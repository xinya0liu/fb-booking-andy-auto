/**
 * FB Messenger bookings → iCloud（苹果）日历 + Bark
 * Cloudflare Worker
 *
 * 在 Business Suite 客人的对话里发出：
 *
 *   确认（建立预约）
 *     ✅ Booking confirmed – Andy Auto AC Regas
 *     Service: Car AC regas
 *     Price: $150
 *     Time: Tomorrow 10am
 *     Address: 56 Smith St, Eagleby
 *
 *   改期（只写有变的栏位）
 *     🔄 Booking updated – Andy Auto AC Regas
 *     Time: Friday 31/10 9am
 *
 *   取消（写上原本的日期，客人有多个预约时用来对应）
 *     ❌ Booking cancelled – Andy Auto AC Regas
 *     Your booking for Thursday 30/10 7:20am has been cancelled.
 *
 * 关键词不分大小写、出现在任何位置都算；同一条消息有多个时，顺序是 取消 → 改期 → 确认。
 * Time 可以写：30/10、30/10/2026、2026-10-30、30 Oct、Oct 30、tomorrow、today、
 *   Thursday、this Thursday、next Wednesday、10月30日、明天、周四、下周三 等。
 *
 * 环境变量 / Secrets：
 *   VERIFY_TOKEN         Meta webhook 验证用的字符串（也用来保护 /check 检查页）
 *   APP_SECRET           Meta App 的 App Secret
 *   PAGE_ACCESS_TOKEN    专页访问令牌
 *   ICLOUD_USER          Apple ID（登录 iCloud 用的邮箱）
 *   ICLOUD_APP_PASSWORD  App 专用密码（xxxx-xxxx-xxxx-xxxx），设为 Secret
 *   ICLOUD_CALENDAR      iCloud 日历的名称，默认 "客人预约"
 *   BARK_URL             一个或多个 Bark 网址，用逗号隔开
 *   LINK_TEMPLATE        对话链接模板，可用 {psid} {conv} {linkid} {fblink}
 * 可选：
 *   ICLOUD_CALENDAR_URL  直接指定日历网址（一般不用填，Worker 会按名称自动找）
 *   LINK_DIRECT          "true" = 对话链接不经过 Worker 中转
 *   FORWARD_INCOMING     "true" = 客人发来的消息也推 Bark
 *   BARK_GROUP           Bark 分组，默认 "Bookings"
 *   DEFAULT_MINUTES      没写结束时间时的时长，默认 90
 *   TIMEZONE             默认 "Australia/Brisbane"
 *   GRAPH_VERSION        默认 "v23.0"
 *   ANTHROPIC_API_KEY    填了就会在格式看不懂时用 AI 解析确认消息
 *   AI_MODEL             默认 "claude-haiku-5-5"
 *
 * 检查 iCloud 设置：浏览器打开 https://你的worker网址/check?token=你的VERIFY_TOKEN
 */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // 对话链接中转：先在浏览器打开这里，再转去 Facebook
    if (req.method === 'GET' && url.pathname === '/go') {
      const to = url.searchParams.get('u') || '';
      if (/^https:\/\/(www|business|m)\.facebook\.com\//.test(to)) return Response.redirect(to, 302);
      return new Response('bad link', { status: 400 });
    }

    // iCloud 设置检查页
    if (req.method === 'GET' && url.pathname === '/check') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      return checkPage(env);
    }

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

    // 先回 200 给 Meta，再在后台处理
    ctx.waitUntil(handle(body, env, url.origin).catch(e => console.error('handle error', e)));
    return new Response('EVENT_RECEIVED');
  },
};

async function handle(body, env, origin) {
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg || !msg.text) continue;
      if (msg.is_echo) {
        await onPageMessage(ev, env, origin);
      } else if (env.FORWARD_INCOMING === 'true') {
        await onCustomerMessage(ev, env, origin);
      }
    }
  }
}

function config(env) {
  return {
    tz: env.TIMEZONE || 'Australia/Brisbane',
    minutes: parseInt(env.DEFAULT_MINUTES || '90', 10),
    linkTemplate: env.LINK_TEMPLATE || '',
    graph: env.GRAPH_VERSION || 'v23.0',
  };
}

function detectAction(text) {
  if (/booking\s+cancel+ed/i.test(text)) return 'cancel';
  if (/booking\s+updated/i.test(text)) return 'update';
  if (/booking\s+confirmed/i.test(text)) return 'confirm';
  return null;
}

// ================= 你（专页）发出的消息 =================

async function onPageMessage(ev, env, origin) {
  const text = ev.message.text.trim();
  const action = detectAction(text);
  if (!action) return;

  const cfg = config(env);
  const psid = ev.recipient.id;
  const mid = ev.message.mid || `${psid}-${text}`;
  console.log(`${action}, psid = ${psid}`);

  const [name, rawLink] = await Promise.all([
    getCustomerName(psid, env),
    conversationLink(cfg, env, psid),
  ]);
  const ctx = { env, cfg, psid, mid, text, name: name || 'Customer', link: viaWorker(origin, env, rawLink) };

  try {
    if (action === 'confirm') await doConfirm(ctx);
    else if (action === 'update') await doUpdate(ctx);
    else await doCancel(ctx);
  } catch (e) {
    console.error(e);
    const title = { confirm: '⚠️ Booking not saved', update: '⚠️ Booking not updated', cancel: '⚠️ Booking not cancelled' }[action];
    await bark(env, `${title}: ${ctx.name}`, `${e.message}\n\n${text}`, ctx.link);
  }
}

async function doConfirm({ env, cfg, psid, mid, text, name, link }) {
  const f = readFields(text);
  if (!f.time) throw new Error('No "Time:" line found.');

  let w = parseWhenParts(f.time, cfg);
  if ((!w.date || !w.start) && env.ANTHROPIC_API_KEY) {
    const ai = await aiParse(text, cfg, env);
    if (ai) {
      w = { ...ai.when, warning: '' };
      f.service ||= ai.service; f.price ||= ai.price; f.address ||= ai.address;
    }
  }
  if (!w.date) throw new Error("Couldn't read the date. Please check the format.");
  if (!w.start) throw new Error("Couldn't read the time. Please check the format.");

  const t = buildTimes(w.date, w.start, w.end, cfg.minutes * 60000);
  const id = (await sha256hex(mid)).slice(0, 32);
  const uid = `${id}@fb-booking`;

  // 防重复：同一位客人同一时间已经有预约就跳过
  const existing = await findBookings(env, cfg, psid);
  const same = existing.find(e => sameLocalStart(e, t, cfg.tz));
  if (same) {
    if (same.uid !== uid) await bark(env, `ℹ️ Already in calendar: ${name}`, t.label, link);
    return;
  }

  const lines = [];
  if (link) lines.push(`Chat: ${link}`, '');
  lines.push(`Customer ID: ${psid}`, '', '— Original message —', text);

  const ics = buildEvent({
    uid,
    startMs: zonedToUtc(t.start, cfg.tz),
    endMs: zonedToUtc(t.end, cfg.tz),
    summary: buildSummary(name, f.service, f.price),
    location: f.address,
    description: lines.join('\n'),
    url: link,
    x: { psid, name, service: f.service, price: f.price },
  });

  const cal = await calendarUrl(env);
  try {
    await dav(env, 'PUT', `${cal}${id}.ics`, { body: ics, headers: { 'if-none-match': '*' } });
  } catch (e) {
    if (e.status === 412) return; // Meta 重复推送同一条消息
    throw e;
  }

  const body = [t.label, f.service, f.price].filter(Boolean).join(' · ') + (w.warning ? `\n${w.warning}` : '');
  await bark(env, `📅 Booking added: ${name}`, body, link);
}

async function doUpdate({ env, cfg, psid, text, name, link }) {
  const f = readFields(text);
  if (!f.time && !f.service && !f.price && !f.address) {
    throw new Error('Nothing to update. Add a Time:, Service:, Price: or Address: line.');
  }

  const list = await findBookings(env, cfg, psid);
  if (!list.length) return notFound(env, name, link, null);
  const target = list[0];
  const old = localParts(target.startMs, cfg.tz);

  const now = utcStamp(Date.now());
  const changes = {
    'X-FB-PSID': [`X-FB-PSID:${icsEsc(psid)}`],
    SEQUENCE: [`SEQUENCE:${target.sequence + 1}`],
    DTSTAMP: [`DTSTAMP:${now}`],
    'LAST-MODIFIED': [`LAST-MODIFIED:${now}`],
  };
  const changed = [];
  let w = { warning: '' };
  let t = null;

  if (f.time) {
    w = parseWhenParts(f.time, cfg);
    if (!w.date && !w.start) throw new Error("Couldn't read the new date or time. Please check the format.");
    const date = w.date || { y: old.y, m: old.m, d: old.d };
    const start = w.start || { h: old.h, min: old.min };
    const duration = target.endMs - target.startMs;
    t = buildTimes(date, start, w.end, duration > 0 ? duration : cfg.minutes * 60000);
    changes.DTSTART = [`DTSTART:${utcStamp(zonedToUtc(t.start, cfg.tz))}`];
    changes.DTEND = [`DTEND:${utcStamp(zonedToUtc(t.end, cfg.tz))}`];
    changes.DURATION = null;
    changed.push('Time');
  }
  if (f.address) { changes.LOCATION = [`LOCATION:${icsEsc(f.address)}`]; changed.push('Address'); }
  if (f.service || f.price) {
    const service = f.service || target.service;
    const price = f.price || target.price;
    if (service) changes['X-FB-SERVICE'] = [`X-FB-SERVICE:${icsEsc(service)}`];
    if (price) changes['X-FB-PRICE'] = [`X-FB-PRICE:${icsEsc(price)}`];
    if (target.service || target.price || (f.service && f.price)) {
      changes.SUMMARY = [`SUMMARY:${icsEsc(buildSummary(target.name || name, service, price))}`];
    }
    if (f.service) changed.push('Service');
    if (f.price) changed.push('Price');
  }

  const note = t ? `Rescheduled from ${old.label}` : `Updated: ${changed.join(', ')}`;
  changes.DESCRIPTION = [`DESCRIPTION:${icsEsc(`${note}\n\n${target.description}\n\n— Update message —\n${text}`)}`];

  try {
    await dav(env, 'PUT', target.href, {
      body: editEvent(target.ics, changes),
      headers: target.etag ? { 'if-match': target.etag } : {},
    });
  } catch (e) {
    if (e.status === 412) throw new Error('The event was changed on another device at the same moment. Please send the update again.');
    throw e;
  }

  const more = list.length > 1 ? '\nℹ️ This customer has other upcoming bookings.' : '';
  if (t) {
    await bark(env, `🔄 Booking rescheduled: ${name}`,
      `${t.label} (was ${old.label})` + (w.warning ? `\n${w.warning}` : '') + more, link);
  } else {
    await bark(env, `🔄 Booking updated: ${name}`, `${old.label} · Changed: ${changed.join(', ')}` + more, link);
  }
}

async function doCancel({ env, cfg, psid, text, name, link }) {
  const list = await findBookings(env, cfg, psid);
  const hint = parseDate(text, cfg); // 消息里写的日期（如果有）

  let target = list[0];
  if (hint) target = list.find(e => {
    const p = localParts(e.startMs, cfg.tz);
    return p.y === hint.y && p.m === hint.m && p.d === hint.d;
  });
  if (!target) return notFound(env, name, link, hint);

  const p = localParts(target.startMs, cfg.tz);
  try {
    await dav(env, 'DELETE', target.href, { headers: target.etag ? { 'if-match': target.etag } : {}, ok: [404] });
  } catch (e) {
    if (e.status === 412) throw new Error('The event was changed on another device at the same moment. Please send the cancellation again.');
    throw e;
  }

  const more = list.length > 1 ? '\nℹ️ This customer has other upcoming bookings.' : '';
  await bark(env, `❌ Booking cancelled: ${name}`, [p.label, target.service].filter(Boolean).join(' · ') + more, link);
}

async function notFound(env, name, link, hint) {
  const when = hint ? ` on ${WD_SHORT[dowOf(hint)]} ${hint.d}/${hint.m}` : '';
  await bark(env, `⚠️ Booking not found: ${name}`,
    `No upcoming booking${when} for this customer. Please update the calendar manually.`, link);
}

// ================= 客人发来的消息 =================

async function onCustomerMessage(ev, env, origin) {
  const cfg = config(env);
  const psid = ev.sender.id;
  const [name, rawLink] = await Promise.all([getCustomerName(psid, env), conversationLink(cfg, env, psid)]);
  await bark(env, `💬 ${name || 'Customer'}`, ev.message.text, viaWorker(origin, env, rawLink));
}

// ================= 读取消息 =================

function readFields(text) {
  const field = label => {
    const m = text.match(new RegExp(`^[ \\t]*${label}[ \\t]*[:：][ \\t]*(.+)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  return { service: field('Service'), price: field('Price'), time: field('Time'), address: field('Address') };
}

function buildSummary(name, service, price) {
  return `${name} – ${service || 'Booking'}${price ? ` ${price}` : ''}`;
}

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WD_CN = '日一二三四五六';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = 'jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december';
const WEEKDAY_RE = 'sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat';
const wdIndex = w => WD_SHORT.findIndex(x => x.toLowerCase() === w.toLowerCase().slice(0, 3));
const cnIndex = c => WD_CN.indexOf(c === '天' ? '日' : c);
const dowOf = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

// 日期规则：
//   Thursday / this Thursday / 周四 → 接下来最近的星期四（今天是星期四就算下星期；this Thursday 可以是今天）
//   next Thursday / 下周四 → 下个星期（周一开始算）的星期四
function parseDate(s, cfg) {
  const today = cfg.today || todayInTz(cfg.tz);
  const todayMs = Date.UTC(today.y, today.m - 1, today.d);
  const todayDow = new Date(todayMs).getUTCDay();
  const fromOffset = days => {
    const t = new Date(todayMs + days * 864e5);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };

  let y = null, m, d, hit;
  const iso  = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const cn   = s.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const dmy  = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/); // 澳洲写法：日/月(/年)
  const dMon = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\b\\.?(?:\\s+(\\d{4}))?`, 'i'));
  const monD = s.match(new RegExp(`\\b(${MONTH_RE})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i'));
  const mIdx = w => MONTHS.indexOf(w.toLowerCase().slice(0, 3)) + 1;

  if (iso)       { y = +iso[1]; m = +iso[2]; d = +iso[3]; hit = iso[0]; }
  else if (cn)   { y = cn[1] ? +cn[1] : null; m = +cn[2]; d = +cn[3]; hit = cn[0]; }
  else if (dmy)  { d = +dmy[1]; m = +dmy[2]; y = dmy[3] ? (+dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3]) : null; hit = dmy[0]; }
  else if (dMon) { d = +dMon[1]; m = mIdx(dMon[2]); y = dMon[3] ? +dMon[3] : null; hit = dMon[0]; }
  else if (monD) { m = mIdx(monD[1]); d = +monD[2]; y = monD[3] ? +monD[3] : null; hit = monD[0]; }

  if (hit) {
    if (!y) {
      y = today.y;
      if (Date.UTC(y, m - 1, d) < todayMs - 7 * 864e5) y++; // 已经过去一周以上 → 明年
    }
  } else {
    const rel = s.match(/day after tomorrow|今天|明天|后天|\btoday\b|\btomorrow\b|\btmrw\b|\btmr\b/i);
    const wEn = s.match(new RegExp(`\\b(?:(this|next)\\s+)?(${WEEKDAY_RE})\\b`, 'i'));
    const wCn = s.match(/(下周|下个?星期|下个?礼拜|这周|本周|这个?星期|这个?礼拜|周|星期|礼拜)([日天一二三四五六])/);

    if (rel) {
      const add = { '今天': 0, '明天': 1, '后天': 2, today: 0, tomorrow: 1, tmrw: 1, tmr: 1, 'day after tomorrow': 2 }[rel[0].toLowerCase()];
      ({ y, m, d } = fromOffset(add));
      hit = rel[0];
    } else if (wEn || wCn) {
      let target, kind;
      if (wEn) { target = wdIndex(wEn[2]); kind = (wEn[1] || '').toLowerCase(); hit = wEn[0]; }
      else { target = cnIndex(wCn[2]); kind = /^下/.test(wCn[1]) ? 'next' : /^(这|本)/.test(wCn[1]) ? 'this' : ''; hit = wCn[0]; }
      let add;
      if (kind === 'next') {
        const monIdx = x => (x + 6) % 7; // 周一=0 … 周日=6
        add = (7 - monIdx(todayDow)) + monIdx(target);
      } else {
        add = (target - todayDow + 7) % 7;
        if (add === 0 && kind !== 'this') add = 7;
      }
      ({ y, m, d } = fromOffset(add));
    } else {
      return null;
    }
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d, hit };
}

// 读取 "Time:" 那一行：日期、开始、结束（都可能缺）
function parseWhenParts(s, cfg) {
  const date = parseDate(s, cfg);
  const rest = date ? s.replace(date.hit, ' ') : s;

  let warning = '';
  if (date) {
    const actual = dowOf(date);
    const we = s.match(new RegExp(`\\b(${WEEKDAY_RE})\\b`, 'i'));
    const wc = s.match(/(?:周|星期|礼拜)([日天一二三四五六])/);
    const want = we ? wdIndex(we[1]) : wc ? cnIndex(wc[1]) : -1;
    if (want >= 0 && want !== actual) {
      warning = `⚠️ Day mismatch: ${date.d}/${date.m} is a ${WD_LONG[actual]}, not ${WD_LONG[want]}. Please check with the customer.`;
    }
  }

  const [a, b] = rest.split(/\s*(?:-|–|—|~|～|到|至|\bto\b)\s*/i);
  const start = parseClock(a || '');
  const end = start && b ? parseClock(b) : null;
  // "1-3pm"：开始时间没写 am/pm，就跟着结束时间
  if (end && !start.ap && end.ap && start.h < 12 && end.h >= 12 && start.h + 12 <= end.h) start.h += 12;
  return { date, start, end, warning };
}

function parseClock(s) {
  const m = s.match(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：.]\s*(\d{2})|点\s*(半|\d{1,2})?)?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!m) return null;
  let h = +m[2];
  const min = m[3] ? +m[3] : m[4] === '半' ? 30 : m[4] ? +m[4] : 0;
  const ap = (m[5] || '').toLowerCase().replace(/\./g, '');
  const cn = m[1];
  if ((ap === 'pm' || cn === '下午' || cn === '晚上') && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (cn === '中午' && h < 11) h += 12;
  if (h > 23 || min > 59) return null;
  return { h, min, ap: !!(ap || cn) };
}

function buildTimes(date, start, end, defaultMs) {
  const { y, m, d } = date;
  const startMs = Date.UTC(y, m - 1, d, start.h, start.min);
  let endMs = startMs + defaultMs;
  if (end) {
    let eh = end.h;
    if (eh * 60 + end.min <= start.h * 60 + start.min && eh < 12) eh += 12;
    const v = Date.UTC(y, m - 1, d, eh, end.min);
    if (v > startMs) endMs = v;
  }
  return {
    start: naive(startMs), end: naive(endMs),
    label: `${WD_SHORT[dowOf(date)]} ${d}/${m} ${pad(start.h)}:${pad(start.min)}`,
  };
}

// 格式看不懂时，用 AI 解析确认消息（可选）
async function aiParse(text, cfg, env) {
  const t = todayInTz(cfg.tz);
  const prompt =
`Today is ${t.y}-${pad(t.m)}-${pad(t.d)} (${WD_LONG[dowOf(t)]}, time zone ${cfg.tz}).
Below is a booking confirmation for a mobile car air-conditioning service. Dates are Australian (day/month).
The phone number and name at the end belong to the business, not the customer.
Reply with JSON only, nothing else:
{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM or null","service":"","price":"","address":""}
If the date or start time cannot be determined, reply {"error":"reason"}.

Message:
${text}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.AI_MODEL || 'claude-haiku-5-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const out = (j.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const o = JSON.parse(out);
    if (o.error || !o.date || !o.start) return null;
    const [y, m, d] = o.date.split('-').map(Number);
    const [h, min] = o.start.split(':').map(Number);
    let end = null;
    if (o.end) { const [eh, em] = o.end.split(':').map(Number); end = { h: eh, min: em }; }
    return {
      when: { date: { y, m, d }, start: { h, min }, end },
      service: o.service || '', price: o.price || '', address: o.address || '',
    };
  } catch (e) {
    console.error('aiParse', e);
    return null;
  }
}

// ================= iCloud 日历（CalDAV） =================

const ICLOUD_ROOT = 'https://caldav.icloud.com/';
let calendarUrlCache = null; // 同一个 Worker 实例里记住日历网址，不用每次都查

function calendarName(env) { return (env.ICLOUD_CALENDAR || '客人预约').trim(); }
const sameName = (a, b) => a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase();

function icloudAuth(env) {
  if (!env.ICLOUD_USER || !env.ICLOUD_APP_PASSWORD) throw new Error('ICLOUD_USER or ICLOUD_APP_PASSWORD is not set in Cloudflare.');
  return 'Basic ' + btoa(`${env.ICLOUD_USER.trim()}:${env.ICLOUD_APP_PASSWORD.trim()}`);
}

async function dav(env, method, url, { body, depth, headers = {}, ok = [] } = {}) {
  const h = { authorization: icloudAuth(env), ...headers };
  if (body) h['content-type'] = body.startsWith('<?xml') ? 'application/xml; charset=utf-8' : 'text/calendar; charset=utf-8';
  if (depth !== undefined) h.depth = String(depth);
  const r = await fetch(url, { method, headers: h, body });
  const text = await r.text();
  if (r.status === 401) {
    throw new Error('iCloud sign-in failed (401). Check ICLOUD_USER and ICLOUD_APP_PASSWORD. It must be an app-specific password, and it stops working if the Apple ID password is changed.');
  }
  if (!r.ok && !ok.includes(r.status)) {
    const e = new Error(`iCloud error ${r.status} (${method}): ${text.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  return { status: r.status, text, etag: r.headers.get('etag') };
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

async function listCalendars(env) {
  const p1 = await dav(env, 'PROPFIND', ICLOUD_ROOT, {
    depth: 0, body: `${XML_HEAD}<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
  });
  const principalHref = xmlText(xmlOne(xmlOne(p1.text, 'current-user-principal') || '', 'href'));
  if (!principalHref) throw new Error('iCloud: could not find your account (current-user-principal).');
  const principal = new URL(principalHref, ICLOUD_ROOT).href;

  const p2 = await dav(env, 'PROPFIND', principal, {
    depth: 0, body: `${XML_HEAD}<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
  });
  const homeHref = xmlText(xmlOne(xmlOne(p2.text, 'calendar-home-set') || '', 'href'));
  if (!homeHref) throw new Error('iCloud: could not find your calendars (calendar-home-set).');
  const home = new URL(homeHref, principal).href;

  const p3 = await dav(env, 'PROPFIND', home, {
    depth: 1, body: `${XML_HEAD}<d:propfind ${NS}><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`,
  });
  return xmlAll(p3.text, 'response')
    .filter(r => /<(?:[\w.-]+:)?calendar\b[^>]*>/i.test(xmlOne(r, 'resourcetype') || ''))
    .map(r => ({ url: new URL(xmlText(xmlOne(r, 'href')), home).href.replace(/\/?$/, '/'), name: xmlText(xmlOne(r, 'displayname')) }));
}

async function calendarUrl(env) {
  if (env.ICLOUD_CALENDAR_URL) return env.ICLOUD_CALENDAR_URL.replace(/\/?$/, '/');
  if (calendarUrlCache) return calendarUrlCache;
  const want = calendarName(env);
  const cals = await listCalendars(env);
  const hit = cals.find(c => sameName(c.name, want));
  if (!hit) {
    throw new Error(`iCloud calendar "${want}" not found. Calendars on this Apple ID: ${cals.map(c => c.name).filter(Boolean).join(', ') || 'none'}.`);
  }
  calendarUrlCache = hit.url;
  return hit.url;
}

// 这位客人还没结束的预约，按时间排序
async function findBookings(env, cfg, psid) {
  const cal = await calendarUrl(env);
  const now = Date.now();
  const r = await dav(env, 'REPORT', cal, {
    depth: 1,
    body: `${XML_HEAD}<c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utcStamp(now)}" end="${utcStamp(now + 400 * 864e5)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  const list = [];
  for (const resp of xmlAll(r.text, 'response')) {
    const ics = xmlText(xmlOne(resp, 'calendar-data'));
    if (!ics.includes('BEGIN:VEVENT')) continue;
    const e = parseEvent(ics, cfg.tz);
    if (!e.startMs || e.endMs <= now) continue;
    if (e.psid ? e.psid !== psid : !e.description.includes(psid)) continue;
    e.href = new URL(xmlText(xmlOne(resp, 'href')), cal).href;
    e.etag = xmlText(xmlOne(resp, 'getetag')) || null;
    list.push(e);
  }
  return list.sort((a, b) => a.startMs - b.startMs);
}

function sameLocalStart(event, t, tz) {
  const p = localParts(event.startMs, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}` === t.start.slice(0, 16);
}

// 检查页：确认能登录 iCloud，并且找得到日历
async function checkPage(env) {
  const out = [];
  let status = 200;
  try {
    const cals = await listCalendars(env);
    const want = calendarName(env);
    const hit = cals.find(c => sameName(c.name, want));
    out.push('✅ Signed in to iCloud.', '', 'Calendars on this Apple ID:');
    for (const c of cals) out.push(`  • ${c.name || '(no name)'}`);
    out.push('');
    if (hit) {
      out.push(`✅ Found "${want}". Bookings will be saved there.`);
      const r = await dav(env, 'REPORT', hit.url, {
        depth: 1,
        body: `${XML_HEAD}<c:calendar-query ${NS}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR">` +
          `<c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(Date.now())}" end="${utcStamp(Date.now() + 400 * 864e5)}"/>` +
          `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      });
      out.push(`   Upcoming events in it: ${xmlAll(r.text, 'response').length}`);
    } else {
      status = 500;
      out.push(`❌ Calendar "${want}" not found. Create it in iCloud, or set ICLOUD_CALENDAR to one of the names above.`);
    }
  } catch (e) {
    status = 500;
    out.push('❌ ' + e.message);
  }
  return new Response(out.join('\n'), { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// ---------- XML（iCloud 的回复） ----------

const xmlName = n => `(?:[\\w.-]+:)?${n}`;
function xmlAll(xml, name) {
  const re = new RegExp(`<${xmlName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${xmlName(name)}>`, 'gi');
  return [...String(xml || '').matchAll(re)].map(m => m[1]);
}
function xmlOne(xml, name) { return xmlAll(xml, name)[0] ?? null; }
function xmlText(s) {
  if (s == null) return '';
  if (s.includes('<![CDATA[')) return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').trim();
}

// ---------- iCalendar（.ics 日历事件） ----------

function buildEvent({ uid, startMs, endMs, summary, location, description, url, x }) {
  const now = utcStamp(Date.now());
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fb-booking//Cloudflare Worker//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${now}`, `CREATED:${now}`, `LAST-MODIFIED:${now}`,
    `DTSTART:${utcStamp(startMs)}`, `DTEND:${utcStamp(endMs)}`,
    `SUMMARY:${icsEsc(summary)}`,
  ];
  if (location) L.push(`LOCATION:${icsEsc(location)}`);
  if (description) L.push(`DESCRIPTION:${icsEsc(description)}`);
  if (url) L.push(`URL;VALUE=URI:${url}`);
  for (const [k, v] of Object.entries(x || {})) if (v) L.push(`X-FB-${k.toUpperCase()}:${icsEsc(v)}`);
  L.push('SEQUENCE:0', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}

function parseEvent(ics, tz) {
  const lines = icsUnfold(ics);
  const { top } = veventInfo(lines);
  const p = {};
  for (const i of top) {
    const x = icsLine(lines[i]);
    if (!(x.name in p)) p[x.name] = x;
  }
  const val = n => (p[n] ? icsUnesc(p[n].value) : '');
  const startMs = icsTime(p.DTSTART, tz);
  const endMs = icsTime(p.DTEND, tz) || (startMs ? startMs + 3600000 : null);
  return {
    ics, startMs, endMs,
    uid: val('UID'),
    sequence: parseInt(val('SEQUENCE') || '0', 10) || 0,
    description: val('DESCRIPTION'),
    psid: val('X-FB-PSID'), name: val('X-FB-NAME'), service: val('X-FB-SERVICE'), price: val('X-FB-PRICE'),
  };
}

// 修改事件：只换掉指定的栏位，其他内容（例如你在 iPhone 上加的提醒）原样保留
function editEvent(ics, changes) {
  const lines = icsUnfold(ics);
  const { end, top } = veventInfo(lines);
  const names = Object.keys(changes);
  const drop = new Set(top.filter(i => names.includes(icsLine(lines[i]).name)));
  const add = names.flatMap(n => changes[n] || []);
  const out = [];
  lines.forEach((l, i) => {
    if (i === end) out.push(...add);
    if (!drop.has(i)) out.push(l);
  });
  return out.map(icsFold).join('\r\n') + '\r\n';
}

// 第一个 VEVENT 的范围，以及它自己那一层的栏位（不含里面的 VALARM 等）
function veventInfo(lines) {
  let start = -1, end = -1, depth = 0;
  const top = [];
  for (let i = 0; i < lines.length; i++) {
    const u = lines[i].toUpperCase();
    if (start < 0) { if (u === 'BEGIN:VEVENT') start = i; continue; }
    if (u.startsWith('BEGIN:')) depth++;
    else if (u.startsWith('END:')) { if (depth === 0) { end = i; break; } depth--; }
    else if (depth === 0) top.push(i);
  }
  if (start < 0 || end < 0) throw new Error('iCloud returned an event without VEVENT.');
  return { start, end, top };
}

function icsUnfold(ics) { return ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(l => l.length); }

function icsLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  const [name, ...ps] = line.slice(0, i).split(';');
  const params = {};
  for (const s of ps) {
    const k = s.indexOf('=');
    if (k > 0) params[s.slice(0, k).toUpperCase()] = s.slice(k + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

function icsTime(p, tz) {
  if (!p || p.params.VALUE === 'DATE') return null; // 全天事件不算
  const m = p.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  if (m[7]) return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  try { return zonedToUtc(local, p.params.TZID || tz); } catch { return zonedToUtc(local, tz); }
}

function icsEsc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsUnesc(s) {
  return String(s).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// 每行最多 75 字节，超过就折行（中文要按字节算）
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '', n = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > limit) { parts.push(cur); cur = ''; n = 0; limit = 74; }
    cur += ch; n += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

// ---------- 时区 ----------

function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}

// "2026-10-30T07:20:00"（当地时间）→ UTC 毫秒
function zonedToUtc(local, tz) {
  const asUtc = Date.parse(local + 'Z');
  let utc = asUtc - tzOffsetMs(asUtc, tz);
  utc = asUtc - tzOffsetMs(utc, tz);
  return utc;
}

function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const r = { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
  r.label = `${WD_SHORT[dowOf(r)]} ${r.d}/${r.m} ${pad(r.h)}:${pad(r.min)}`;
  return r;
}

function utcStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'; }

// ================= Meta / 链接 / Bark =================

async function getCustomerName(psid, env) {
  if (!env.PAGE_ACCESS_TOKEN) return null;
  try {
    const r = await fetch(`https://graph.facebook.com/${config(env).graph}/${psid}?fields=first_name,last_name` +
      `&access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`);
    const j = await r.json();
    return [j.first_name, j.last_name].filter(Boolean).join(' ') || null;
  } catch {
    return null;
  }
}

// 把对话链接包一层 Worker 中转（设 LINK_DIRECT=true 可关闭）
function viaWorker(origin, env, link) {
  if (!link || !origin || env.LINK_DIRECT === 'true') return link;
  return `${origin}/go?u=${encodeURIComponent(link)}`;
}

// LINK_TEMPLATE 占位符：{psid} {conv}（t_ 后面的数字） {linkid}（/inbox/ 后面的数字） {fblink}
async function conversationLink(cfg, env, psid) {
  let link = cfg.linkTemplate;
  if (!link) return '';
  link = link.replaceAll('{psid}', psid);
  if (!/\{(conv|linkid|fblink)\}/.test(link)) return link;
  try {
    const r = await fetch(`https://graph.facebook.com/${cfg.graph}/me/conversations?platform=messenger` +
      `&user_id=${psid}&fields=id,link&access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`);
    const j = await r.json();
    const c = (j.data || [])[0];
    if (!c) { console.error('conversation lookup', JSON.stringify(j)); return ''; }
    const conv = String(c.id || '').replace(/^t_/, '');
    const path = c.link || '';
    const linkid = (path.match(/inbox\/(\d+)/) || [])[1] || '';
    return link
      .replaceAll('{conv}', conv)
      .replaceAll('{linkid}', linkid)
      .replaceAll('{fblink}', path ? `https://www.facebook.com${path}` : '');
  } catch (e) {
    console.error('conversation lookup', e);
    return '';
  }
}

// BARK_URL 可以放多个网址，用逗号隔开
async function bark(env, title, body, link) {
  const urls = (env.BARK_URL || '').split(/[,\s]+/).map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!urls.length) return;
  const path = `/${encodeURIComponent(title)}/${encodeURIComponent(String(body || ' ').slice(0, 800))}`;
  const query = `?group=${encodeURIComponent(env.BARK_GROUP || 'Bookings')}` + (link ? `&url=${encodeURIComponent(link)}` : '');
  await Promise.all(urls.map(u => fetch(u + path + query).catch(e => console.error('bark', e))));
}

async function verifySignature(req, raw, secret) {
  const sig = req.headers.get('x-hub-signature-256') || '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return sig === 'sha256=' + hex(new Uint8Array(mac));
}

// ================= 小工具 =================

function todayInTz(tz) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return { y, m, d };
}
async function sha256hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
function hex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
function naive(ms) { return new Date(ms).toISOString().slice(0, 19); } // 本地时间（没有时区）
function pad(n) { return String(n).padStart(2, '0'); }
