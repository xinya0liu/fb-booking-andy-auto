/**
 * FB Messenger 预约确认 → Google 日历 + Bark 提醒
 * Cloudflare Worker
 *
 * 你在 Business Suite 发出包含 TRIGGER 的确认消息，例如：
 *   Great, have booked you in for car AC service for $150.
 *   Time: 30/10 Friday 7:20am
 *   Address: 56 Smith St, Eagleby
 * 就会自动在 Google 日历建事件（备注里有回到对话的链接）。
 * 日期按澳洲写法读：日/月。消息末尾你自己的电话和名字会被忽略。
 *
 * 环境变量 / Secrets：
 *   VERIFY_TOKEN       Meta webhook 验证用的字符串（自己定）
 *   APP_SECRET         Meta App 的 App Secret（用来验证请求真的来自 Meta）
 *   PAGE_ACCESS_TOKEN  专页访问令牌（用来查客人名字）
 *   GOOGLE_SA_EMAIL    Google 服务账号的 client_email
 *   GOOGLE_SA_KEY      Google 服务账号的 private_key（整段贴上，含 BEGIN/END）
 *   CALENDAR_ID        Google 日历 ID
 *   LINK_TEMPLATE      回到对话的链接，把客人 ID 的位置换成 {psid}
 *   BARK_URL           例如 https://api.day.app/你的KEY
 * 可选：
 *   FORWARD_INCOMING   "true" = 客人发来的消息也推 Bark
 *   TRIGGER            默认 "have booked you in"（消息里包含这句就触发，不分大小写）
 *   TIMEZONE           默认 "Australia/Brisbane"
 *   DEFAULT_MINUTES    没写结束时间时的时长，默认 90
 *   GRAPH_VERSION      默认 "v23.0"
 *   ANTHROPIC_API_KEY  填了就会在格式看不懂时用 AI 解析
 *   AI_MODEL           默认 "claude-haiku-5-5"
 */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Meta webhook 验证
    if (req.method === 'GET') {
      if (url.searchParams.get('hub.mode') === 'subscribe' &&
          url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN) {
        return new Response(url.searchParams.get('hub.challenge') || '');
      }
      return new Response('forbidden', { status: 403 });
    }
    if (req.method !== 'POST') return new Response('ok');

    const raw = await req.text();
    if (env.APP_SECRET && !(await verifySignature(req, raw, env.APP_SECRET))) {
      return new Response('bad signature', { status: 401 });
    }

    let body;
    try { body = JSON.parse(raw); } catch { return new Response('ok'); }

    // 先回 200 给 Meta，再在后台处理，避免 Meta 重复推送
    ctx.waitUntil(handle(body, env).catch(e => console.error('handle error', e)));
    return new Response('EVENT_RECEIVED');
  },
};

async function handle(body, env) {
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg || !msg.text) continue;
      if (msg.is_echo) {
        await onPageMessage(ev, env);            // 你（专页）发出的消息
      } else if (env.FORWARD_INCOMING === 'true') {
        await onCustomerMessage(ev, env);        // 客人发来的消息
      }
    }
  }
}

function config(env) {
  return {
    trigger: env.TRIGGER || 'have booked you in',
    tz: env.TIMEZONE || 'Australia/Brisbane',
    minutes: parseInt(env.DEFAULT_MINUTES || '90', 10),
    linkTemplate: env.LINK_TEMPLATE || '',
    graph: env.GRAPH_VERSION || 'v23.0',
  };
}

function conversationLink(cfg, psid) {
  return cfg.linkTemplate ? cfg.linkTemplate.replaceAll('{psid}', psid) : '';
}

// ---------- 你发出的确认消息 → 日历 ----------

async function onPageMessage(ev, env) {
  const cfg = config(env);
  const text = ev.message.text.trim();
  if (!text.toLowerCase().includes(cfg.trigger.toLowerCase())) return;

  const psid = ev.recipient.id;
  const link = conversationLink(cfg, psid);
  console.log('booking message, psid =', psid);

  try {
    let b = parseBooking(text, cfg);
    if (!b && env.ANTHROPIC_API_KEY) b = await aiParse(text, cfg, env);
    if (!b) throw new Error('看不懂日期或时间，请检查格式');

    const name = (await getCustomerName(psid, env)) || '客人';
    const created = await createEvent(
      { ...b, name, link, original: text, mid: ev.message.mid || `${psid}-${text}` },
      cfg, env,
    );
    if (created) {
      await bark(env, `📅 已加入日历：${name}`,
        `${b.label} ${b.service} ${b.price}`.trim() + (b.warning ? `\n${b.warning}` : ''), link);
    }
  } catch (e) {
    console.error(e);
    await bark(env, '⚠️ 预约没写进日历', `${e.message}\n${text}`, link);
  }
}

// ---------- 客人发来的消息 → Bark ----------

async function onCustomerMessage(ev, env) {
  const cfg = config(env);
  const psid = ev.sender.id;
  const name = (await getCustomerName(psid, env)) || '客人';
  await bark(env, `💬 ${name}`, ev.message.text, conversationLink(cfg, psid));
}

// ---------- 解析确认消息 ----------

function parseBooking(text, cfg) {
  const field = re => ((text.match(re) || [])[1] || '').trim();

  const when = field(/Time\s*[:：]\s*(.+)/i);
  const t = when ? parseWhen(when, cfg) : null;
  if (!t) return null;

  // "booked you in for car AC service for $150."
  let service = '', price = '';
  const sp = text.match(/booked you in for\s+(.+?)\s+for\s+(\$\s?[\d,.]+)/i);
  if (sp) {
    service = sp[1].trim();
    price = sp[2].replace(/\s/g, '').replace(/\.$/, '');
  } else {
    service = field(/booked you in for\s+([^.\n]+)/i);
  }

  // 消息末尾的电话和名字是你自己的，不读取
  return { ...t, service, price, address: field(/Address\s*[:：]\s*(.+)/i), phone: '', note: '' };
}

function parseWhen(s, cfg) {
  const today = todayInTz(cfg.tz);
  let y = null, m, d, rest, hit;

  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const cn  = s.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const dmy = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/); // 澳洲写法：日/月(/年)

  if (iso)      { y = +iso[1]; m = +iso[2]; d = +iso[3]; hit = iso[0]; }
  else if (cn)  { y = cn[1] ? +cn[1] : null; m = +cn[2]; d = +cn[3]; hit = cn[0]; }
  else if (dmy) { d = +dmy[1]; m = +dmy[2]; y = dmy[3] ? (+dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3]) : null; hit = dmy[0]; }

  if (hit) {
    if (!y) {
      y = today.y;
      // 没写年份、日期已经过去一周以上 → 当作明年
      if (Date.UTC(y, m - 1, d) < Date.UTC(today.y, today.m - 1, today.d) - 7 * 864e5) y++;
    }
    rest = s.replace(hit, ' ');
  } else {
    const rel = s.match(/今天|明天|后天|today|tomorrow/i);
    if (!rel) return null;
    const add = { '今天': 0, '明天': 1, '后天': 2, today: 0, tomorrow: 1 }[rel[0].toLowerCase()];
    const t = new Date(Date.UTC(today.y, today.m - 1, today.d + add));
    y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
    rest = s.replace(rel[0], ' ');
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  // 写了星期几的话，检查跟日期对不对得上
  let warning = '';
  const NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const we = s.match(/\b(sun|mon|tue|wed|thu|fri|sat)/i);
  const wc = s.match(/(?:周|星期|礼拜)([日天一二三四五六])/);
  const want = we ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(we[1].toLowerCase())
             : wc ? '日一二三四五六'.indexOf(wc[1] === '天' ? '日' : wc[1]) : -1;
  const actual = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (want >= 0 && want !== actual) {
    warning = `⚠️ 星期对不上：${d}/${m} 是${NAMES[actual]}，不是${NAMES[want]}，请跟客人确认`;
  }

  const [a, b] = rest.split(/\s*(?:-|–|—|~|～|到|至)\s*/);
  const start = parseClock(a || '');
  if (!start) return null;

  const startMs = Date.UTC(y, m - 1, d, start.h, start.min);
  let endMs = startMs + cfg.minutes * 60000;
  const end = b ? parseClock(b) : null;
  if (end) {
    let eh = end.h;
    if (eh * 60 + end.min <= start.h * 60 + start.min && eh < 12) eh += 12;
    const v = Date.UTC(y, m - 1, d, eh, end.min);
    if (v > startMs) endMs = v;
  }
  return {
    start: naive(startMs), end: naive(endMs),
    label: `${d}/${m} ${pad(start.h)}:${pad(start.min)}`, warning,
  };
}

function parseClock(s) {
  const m = s.match(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：.]\s*(\d{2})|点\s*(半|\d{1,2})?)?\s*(am|pm)?/i);
  if (!m) return null;
  let h = +m[2];
  const min = m[3] ? +m[3] : m[4] === '半' ? 30 : m[4] ? +m[4] : 0;
  const ap = (m[5] || '').toLowerCase();
  const cn = m[1];
  if ((ap === 'pm' || cn === '下午' || cn === '晚上') && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (cn === '中午' && h < 11) h += 12;
  if (h > 23 || min > 59) return null;
  return { h, min };
}

// 格式看不懂时，用 AI 解析（可选）
async function aiParse(text, cfg, env) {
  const t = todayInTz(cfg.tz);
  const prompt =
`今天是 ${t.y}-${pad(t.m)}-${pad(t.d)}（时区 ${cfg.tz}）。下面是一条上门服务的预约确认消息，日期是澳洲写法（日/月）。
消息末尾的电话和名字是商家自己的，不是客人的，phone 请留空。
请抽取信息，只回复 JSON，不要任何其他文字：
{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM 或 null","service":"","price":"","address":"","phone":"","note":""}
如果无法确定日期或开始时间，回复 {"error":"原因"}。

消息：
${text}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.AI_MODEL || 'claude-haiku-5-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await r.json();
    const out = (j.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const o = JSON.parse(out);
    if (o.error || !o.date || !o.start) return null;

    const [y, m, d] = o.date.split('-').map(Number);
    const [h, mi] = o.start.split(':').map(Number);
    const s = Date.UTC(y, m - 1, d, h, mi);
    let e = s + cfg.minutes * 60000;
    if (o.end) {
      const [eh, em] = o.end.split(':').map(Number);
      const v = Date.UTC(y, m - 1, d, eh, em);
      if (v > s) e = v;
    }
    return {
      start: naive(s), end: naive(e), label: `${d}/${m} ${pad(h)}:${pad(mi)}`,
      service: o.service || '', price: o.price || '', address: o.address || '',
      phone: o.phone || '', note: o.note || '',
    };
  } catch (e) {
    console.error('aiParse', e);
    return null;
  }
}

// ---------- Google 日历 ----------

async function createEvent(b, cfg, env) {
  const token = await googleToken(env);
  // 用消息 ID 生成事件 ID：Meta 重复推送时不会建出两个事件
  const id = (await sha256hex(b.mid)).slice(0, 32);
  const summary = [b.name, b.service].filter(Boolean).join(' - ') + (b.price ? ` ${b.price}` : '');

  const lines = [];
  if (b.phone) lines.push(`电话：${b.phone}`);
  if (b.link) lines.push(`对话：${b.link}`);
  if (b.note) lines.push(`备注：${b.note}`);
  lines.push('', '—— 原始确认消息 ——', b.original);

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        summary,
        location: b.address || undefined,
        description: lines.join('\n'),
        start: { dateTime: b.start, timeZone: cfg.tz },
        end: { dateTime: b.end, timeZone: cfg.tz },
      }),
    },
  );
  if (res.status === 409) return null; // 已经建过
  if (!res.ok) throw new Error(`Google 日历错误 ${res.status}: ${await res.text()}`);
  return res.json();
}

async function googleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: env.GOOGLE_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;

  const pem = env.GOOGLE_SA_KEY.replace(/\\n/g, '\n');
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')),
    c => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${b64url(new Uint8Array(sig))}`,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google 登录失败: ' + JSON.stringify(j));
  return j.access_token;
}

// ---------- Meta / Bark ----------

async function getCustomerName(psid, env) {
  if (!env.PAGE_ACCESS_TOKEN) return null;
  try {
    const r = await fetch(
      `https://graph.facebook.com/${config(env).graph}/${psid}?fields=first_name,last_name` +
      `&access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`,
    );
    const j = await r.json();
    return [j.first_name, j.last_name].filter(Boolean).join(' ') || null;
  } catch {
    return null;
  }
}

async function bark(env, title, body, link) {
  if (!env.BARK_URL) return;
  const u = `${env.BARK_URL.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(String(body).slice(0, 500))}` +
    `?group=${encodeURIComponent('预约')}` + (link ? `&url=${encodeURIComponent(link)}` : '');
  try { await fetch(u); } catch (e) { console.error('bark', e); }
}

async function verifySignature(req, raw, secret) {
  const sig = req.headers.get('x-hub-signature-256') || '';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return sig === 'sha256=' + hex(new Uint8Array(mac));
}

// ---------- 小工具 ----------

function todayInTz(tz) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number);
  return { y, m, d };
}
async function sha256hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
function hex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function naive(ms) { return new Date(ms).toISOString().slice(0, 19); } // 本地时间，配合 timeZone 使用
function pad(n) { return String(n).padStart(2, '0'); }
