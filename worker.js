/**
 * FB Messenger bookings → iCloud（苹果）日历 + Bark
 * Cloudflare Worker
 *
 * 消息开头的关键词决定怎么处理（前面可以有 emoji，不分大小写；聊天中间顺口打出来的不会触发）：
 *
 *   Booking confirmed  新建：读对话、AI 整理、写入日历，并自动把完整资料发给客人
 *   Booking updated    修改：读对话找出改了什么、更新日历，并自动把更新后的资料发给客人
 *   Booking cancelled  取消：删除这位客人的预约（写了日期就删那一天的，否则删最近的一个）
 *
 *   用 AI 的两个关键词，消息里如果另外写了 "Time: …"、"Price: …" 这类行，会优先采用。
 *   资料不对：在对话里讲清楚，再发一次 Booking updated。
 *   AI 或读对话失败时，消息里有写栏位就照写的内容处理（后备），否则 Bark 提醒怎么补发。
 *
 * 常用的三句（存成 Business Suite 的“已保存的回复”）：
 *   Booking confirmed 👍 I'll send through your booking details shortly.
 *   Booking updated 👍 I'll send through your updated booking details shortly.
 *   Booking cancelled – your booking for Sunday 25/10 2pm has been cancelled.
 *
 * 只想更新日历、不要 AI、不要自动回复客人时，用这两个开头（照消息里写的栏位处理）：
 *   We've booked you in        新建，必须有 "Time:" 行
 *   We've updated your booking 修改，只写有变的行
 *     We've booked you in – Andy Auto AC Regas
 *     Service: Car AC regas
 *     Price: $150
 *     Time: Tomorrow 10am
 *     Address: 56 Smith St, Eagleby
 *
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
 * 可选：
 *   ICLOUD_CALENDAR_URL  直接指定日历网址（一般不用填，Worker 会按名称自动找）
 *   SHORTCUT_NAME        iPhone 捷径的名称（例如 Open Customer）。设了就让链接直接执行捷径：
 *                        复制客人名字并打开 Business Suite；没设就打开客人卡片网页
 *   INBOX_URL            客人卡片“打开收件箱”按钮的网址，默认 Business Suite 收件箱
 *   FORWARD_INCOMING     "true" = 客人发来的消息也推 Bark
 *   BARK_GROUP           Bark 分组，默认 "Bookings"
 *   DEFAULT_MINUTES      没写结束时间时的时长，默认 90
 *   TIMEZONE             默认 "Australia/Brisbane"
 *   GRAPH_VERSION        默认 "v23.0"
 *   ANTHROPIC_API_KEY    读对话、AI 整理资料、自动回复客人需要
 *   AUTO_REPLY           "false" = Booking confirmed / updated 时不自动发消息给客人（默认会发）
 *   CONFIRM_HEADER       自动确认消息的第一行，默认 "✅ Booking details – Andy Auto AC Regas"
 *   UPDATE_HEADER        自动更新消息的第一行，默认 "🔄 Updated booking details – Andy Auto AC Regas"
 *   CONFIRM_FOOTER       自动确认 / 更新消息的最后一行
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

    // 客人卡片：显示客人名字，一键复制名字并打开收件箱
    // （iPhone 上的 Business Suite 不支持直接打开某一个对话，所以改用搜索名字的方式）
    if (req.method === 'GET' && url.pathname === '/c') {
      return customerCard(url.searchParams.get('n') || '', env);
    }

    // 临时测试路由：触发 Andy 的 Bark reminder
    if (req.method === 'GET' && url.pathname === '/test-bark' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      await handleScheduled('test', env);
      return new Response('done');
    }

    // 打印页：明天的预约工单
    if (req.method === 'GET' && url.pathname === '/print' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return printPage(env, url.origin);
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event.cron, env).catch(e => console.error('scheduled error', e)));
  },
};

async function handle(body, env, origin) {
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg || !msg.text) continue;
      if (msg.is_echo) {
        if (msg.metadata === BOT_TAG) continue; // Worker 自己发给客人的确认消息
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
    graph: env.GRAPH_VERSION || 'v23.0',
  };
}

// 关键词必须在消息的最开头（前面可以有 emoji、空格、标点），聊天中间顺口打出来的不算
//   Booking confirmed / Booking updated   → 读对话、AI 整理、更新日历、自动回复客人
//   We've booked you in / We've updated your booking → 只照消息里写的栏位更新日历，不用 AI、不回复客人
//   Booking cancelled                     → 删除预约
function detectAction(text) {
  const head = text.trim().replace(/^[^A-Za-z]+/, '');
  if (/^booking\s+cancel+ed\b/i.test(head)) return { action: 'cancel' };
  if (/^booking\s+updated\b/i.test(head)) return { action: 'update', manual: false };
  if (/^booking\s+confirmed\b/i.test(head)) return { action: 'confirm', manual: false };
  if (/^we've\s+updated\s+your\s+booking\b/i.test(head)) return { action: 'update', manual: true };
  if (/^we've\s+booked\s+you\s+in\b/i.test(head)) return { action: 'confirm', manual: true };
  return null;
}

// ================= 你（专页）发出的消息 =================

async function onPageMessage(ev, env, origin) {
  const text = ev.message.text.trim();
  const found = detectAction(text);
  if (!found) return;
  const { action, manual } = found;

  const cfg = config(env);
  const psid = ev.recipient.id;
  const mid = ev.message.mid || `${psid}-${text}`;
  console.log(`${action}${manual ? ' (manual)' : ''}, psid = ${psid}`);

  const name = await getCustomerName(psid, env);
  // 消息里写了 "Name: …" 就用它，否则用 Facebook 上的名字
  const typed = readFields(text).name;
  const shown = typed || name || 'Customer';
  const ctx = { env, cfg, psid, mid, text, manual, name: shown, link: cardLink(origin, typed || name, env) };

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

async function doConfirm(ctx) {
  const { env, cfg, text, name, link } = ctx;
  const f = readFields(text);

  // 有 AI 就一律从对话整理（你在消息里写的栏位优先）；没有 AI 才照消息里写的建立
  let fallback = '';
  if (ctx.manual) {
    // Booked you in：只照消息写入日历
    if (!f.time) throw new Error('No "Time:" line found.');
  } else if (env.ANTHROPIC_API_KEY) {
    try {
      return await doConfirmFromChat(ctx, f);
    } catch (e) {
      // 后备：AI 或读对话失败时，消息里有 Time: 就照消息内容建立
      if (!e.fallback) throw e;
      if (!f.time) throw new Error(`${e.message}\n\nTo save it without AI, send it with the details, e.g.\nBooked you in\nService: …\nPrice: …\nTime: Sunday 2pm\nAddress: …`);
      fallback = `⚠️ AI unavailable (${e.message}). Saved from your message only. No confirmation was sent to the customer.`;
    }
  } else if (!f.time) {
    throw new Error('No "Time:" line found. Set ANTHROPIC_API_KEY to fill in the details from the chat automatically.');
  }

  const w = parseWhenParts(f.time, cfg);
  if (!w.date) throw new Error("Couldn't read the date. Please check the format.");
  if (!w.start) throw new Error("Couldn't read the time. Please check the format.");

  const t = buildTimes(w.date, w.start, w.end, cfg.minutes * 60000);
  const created = await saveNewBooking(ctx, {
    t, service: f.service, price: f.price, address: f.address,
    notes: extraFields(text), // 备注放消息里的所有栏位：Service、Price、Time、Address、Mobile、Vehicle 等
  });
  if (!created) return;

  applyCustomLabel(ctx.psid, f.service, w.date, env);

  const body = [t.label, f.service, f.price].filter(Boolean).join(' · ') + (w.warning ? `\n${w.warning}` : '') +
    overlapLine(created.overlaps) + (fallback ? `\n${fallback}` : '');
  await bark(env, `📅 Booking added: ${name}`, body, link);
}

// 写入新预约。已经有同一时间的预约、或 Meta 重复推送时返回 false
async function saveNewBooking({ env, cfg, psid, mid, name, link }, { t, service, price, address, notes }) {
  const id = (await sha256hex(mid)).slice(0, 32);
  const uid = `${id}-${psid}@fb-booking`; // 客人编号藏在事件的 UID 里，备注里不用写

  // 防重复：同一位客人同一时间已经有预约就跳过
  const existing = await findBookings(env, cfg, psid);
  const same = existing.find(e => sameLocalStart(e, t, cfg.tz));
  if (same) {
    if (same.uid !== uid) await bark(env, `ℹ️ Already in calendar: ${name}`, t.label, link);
    return false;
  }

  const startMs = zonedToUtc(t.start, cfg.tz), endMs = zonedToUtc(t.end, cfg.tz);
  const overlaps = await findOverlaps(env, cfg, startMs, endMs, uid);

  const ics = buildEvent({
    uid,
    startMs: zonedToUtc(t.start, cfg.tz),
    endMs: zonedToUtc(t.end, cfg.tz),
    summary: buildSummary(name, service, price),
    location: address,
    description: notes.join('\n'),
    url: link,
    x: { psid, name, service, price },
  });

  const cal = await calendarUrl(env);
  try {
    await dav(env, 'PUT', `${cal}${id}.ics`, { body: ics, headers: { 'if-none-match': '*' } });
  } catch (e) {
    if (e.status === 412) return false; // Meta 重复推送同一条消息
    throw e;
  }
  return { overlaps };
}

// ================= 一键确认：从对话整理资料 =================
//
// 只发 "Booking confirmed"（可以另外写几行，例如 Time:、Price:，你写的优先）：
//   1. 读取这位客人最近 30 天的对话
//   2. 用 AI 整理出时间、服务、价格、地址、电话、车型、备注
//   3. 写进日历
//   4. 用专页自动发一条完整的确认消息给客人（AUTO_REPLY=false 可关闭）
//   5. Bark 推送整理结果给管理员核对

const CHAT_FIELDS = [
  ['service', 'Service'], ['price', 'Price'], ['time', 'Time'], ['address', 'Address'],
  ['mobile', 'Mobile'], ['vehicle', 'Vehicle'], ['notes', 'Notes'],
];
const BOT_TAG = 'fb-booking'; // Worker 自己发出的消息带这个标记，回传时不再处理

async function doConfirmFromChat(ctx, f) {
  const { env, cfg, psid, text, name, link } = ctx;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('No "Time:" line found. To fill in the details from the chat automatically, set ANTHROPIC_API_KEY in Cloudflare.');
  }

  const chat = await readConversation(psid, env, cfg);
  const ai = await aiFromChat(chat, cfg, env);

  // 你在消息里写的栏位优先，其次才用 AI 整理的
  const typed = {};
  for (const l of extraFields(text)) typed[fieldLabel(l).toLowerCase()] = l.slice(l.search(/[:：]/) + 1).trim();
  const d = {};
  for (const [k, label] of CHAT_FIELDS) d[k] = typed[label.toLowerCase()] || ai[k] || '';

  let w;
  if (typed.time) {
    w = parseWhenParts(typed.time, cfg);
    if (!w.date || !w.start) throw new Error("Couldn't read your Time: line. Please check the format.");
  } else {
    if (!ai.date || !ai.start) {
      throw new Error("Couldn't find the booking date and time in the chat. Add a Time: line, e.g. Time: Sunday 7pm, and send again.");
    }
    w = { date: ai.date, start: ai.start, end: ai.end, warning: '' };
  }
  const t = buildTimes(w.date, w.start, w.end, cfg.minutes * 60000);
  assertFuture(t, cfg);
  d.time = t.label;

  // 备注：所有栏位，加上你另外写的其他行
  const notes = ['Auto-filled from chat'];
  for (const [k, label] of CHAT_FIELDS) if (d[k]) notes.push(`${label}: ${d[k]}`);
  for (const l of extraFields(text)) {
    if (!CHAT_FIELDS.some(([, label]) => label.toLowerCase() === fieldLabel(l).toLowerCase())) notes.push(l);
  }

  const created = await saveNewBooking(ctx, { t, service: d.service, price: d.price, address: d.address, notes });
  if (!created) return;

  applyCustomLabel(psid, d.service, w.date, env);

  // 自动回复客人
  const msg = customerMessage(d, w, env, env.CONFIRM_HEADER || 'Andy Auto AC Regas');
  let sent = null;
  if (env.AUTO_REPLY !== 'false') sent = await sendToCustomer(psid, msg, env);

  const missing = ['service', 'price', 'address'].filter(k => !d[k]).map(k => CHAT_FIELDS.find(x => x[0] === k)[1]);
  const lines = [
    [t.label, d.service, d.price].filter(Boolean).join(' · '),
    d.address, d.mobile && `📱 ${d.mobile}`, d.vehicle && `🚗 ${d.vehicle}`, d.notes && `📝 ${d.notes}`,
  ].filter(Boolean);
  if (w.warning) lines.push(w.warning);
  if (created.overlaps.length) lines.push(overlapLine(created.overlaps).trim());
  if (missing.length) lines.push(`ℹ️ Not found in chat: ${missing.join(', ')}`);
  if (!sent) lines.push('ℹ️ Auto-reply is off, nothing was sent to the customer.');
  else if (sent.ok) lines.push('✉️ Confirmation sent to the customer.');
  else lines.push('', `⚠️ Confirmation NOT sent to the customer (${sent.error}). Please send it yourself:`, '', msg);
  await bark(env, `📅 Booking added: ${name}`, lines.join('\n'), link);
}

// 读取对话：最近 30 天、最多 50 条，按时间先后
// 外部服务（Facebook 读对话、AI）出问题的错误，可以改用消息内容作为后备
function serviceError(message) {
  const e = new Error(message);
  e.fallback = true;
  return e;
}

async function readConversation(psid, env, cfg) {
  try {
    return await readConversationRaw(psid, env, cfg);
  } catch (e) {
    throw e.fallback ? e : serviceError(`Facebook: ${e.message}`);
  }
}

async function readConversationRaw(psid, env, cfg) {
  const graph = `https://graph.facebook.com/${cfg.graph}`;
  const token = `access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN || '')}`;
  const c = await (await fetch(`${graph}/me/conversations?platform=messenger&user_id=${psid}&fields=id&${token}`)).json();
  const id = c.data?.[0]?.id;
  if (!id) throw serviceError(`Facebook: couldn't find this conversation. ${JSON.stringify(c.error || c).slice(0, 200)}`);
  const m = await (await fetch(`${graph}/${id}/messages?fields=message,from,created_time&limit=50&${token}`)).json();
  if (m.error || !m.data) throw serviceError(`Facebook: couldn't read the messages. ${JSON.stringify(m.error || m).slice(0, 200)}`);
  const since = Date.now() - 30 * 864e5;
  const list = m.data
    .filter(x => x.message && Date.parse(x.created_time) >= since)
    .reverse()
    .map(x => ({ who: x.from?.id === psid ? 'Customer' : 'Us', label: localParts(Date.parse(x.created_time), cfg.tz).label, text: x.message }));
  if (!list.length) throw serviceError('Facebook: no messages found in this conversation in the last 30 days.');
  return list;
}

async function aiFromChat(chat, cfg, env, current = null) {
  const t = todayInTz(cfg.tz);
  const transcript = chat.map(x => `[${x.label}] ${x.who}: ${x.text}`).join('\n');
  const task = current
    ? `The last message from Us is "Booking updated": the business is changing an existing booking right now.
Current booking details (before this update):
${current}
Find what the customer and the business agreed to change, and save the booking as it should be NOW with the save_booking tool.
Keep the current value for anything that did not change, copied exactly as shown (use "" where it shows (none)).`
    : `The last message from Us is "Booking confirmed": the business is confirming a booking right now.
Find the details of the booking being confirmed now and save them with the save_booking tool.`;
  const prompt =
`Today is ${WD_LONG[dowOf(t)]} ${t.y}-${pad(t.m)}-${pad(t.d)}, time zone ${cfg.tz}.
Below is a Facebook Messenger chat between a mobile car air-conditioning business ("Us") and a customer.
${task}

Rules:
- Earlier bookings in the chat may have been confirmed, changed or cancelled. Only the booking being confirmed now matters.
  If the customer cancelled and then came back without giving new details, reuse the most recent agreed details.
- Dates in the chat are Australian (day/month). Words like "tomorrow" or "Sunday" are relative to the time that message was sent, shown in [brackets].
- Use the final agreed values, e.g. the last price quoted by Us, not an earlier estimate, and the time the customer finally accepted, not other options offered.
- The business's own phone number appears in messages from Us. Never use it as the customer's mobile.
- Leave a field as "" if it was not mentioned. Do not guess or invent anything.
- notes: only things the technician should know (e.g. symptoms, parts needed, parking). Keep it short, or "".

Chat (oldest first):
${transcript}`;

  const str = d => ({ type: 'string', description: d });
  const tool = {
    name: 'save_booking',
    description: 'Save the details of the booking being confirmed now.',
    input_schema: {
      type: 'object',
      properties: {
        date: str('YYYY-MM-DD, or "" if unknown'),
        start: str('HH:MM in 24-hour time, or "" if unknown'),
        end: str('HH:MM in 24-hour time, or "" if not mentioned'),
        service: str('Service type in 1-3 words based on what was discussed, e.g. "Regas", "Pressure Test", "Leak Check". Keep it short and specific.'),
        price: str('e.g. $150'),
        address: str('Service address'),
        mobile: str("Customer's mobile number"),
        vehicle: str('e.g. 2016 Toyota Camry'),
        notes: str('Short notes for the technician'),
      },
      required: ['date', 'start', 'end', 'service', 'price', 'address', 'mobile', 'vehicle', 'notes'],
    },
  };

  let o;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.AI_MODEL || 'claude-haiku-5-5',
        max_tokens: 1000,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'save_booking' }, // 一定要用这个工具回答，不能写别的文字
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw); } catch { throw new Error(`AI service returned HTTP ${r.status}: ${raw.slice(0, 200) || '(empty)'}`); }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    o = (j.content || []).find(c => c.type === 'tool_use')?.input;
    if (!o) throw new Error(`no booking details returned: ${JSON.stringify(j.content || j).slice(0, 200)}`);
  } catch (e) {
    throw serviceError(`AI couldn't read the chat: ${e.message}`);
  }

  const res = {};
  for (const k of ['service', 'price', 'address', 'mobile', 'vehicle', 'notes']) res[k] = String(o[k] || '').trim();
  const dm = String(o.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const sm = String(o.start || '').match(/^(\d{1,2}):(\d{2})$/);
  const em = String(o.end || '').match(/^(\d{1,2}):(\d{2})$/);
  res.date = dm ? { y: +dm[1], m: +dm[2], d: +dm[3] } : null;
  res.start = sm ? { h: +sm[1], min: +sm[2] } : null;
  res.end = em ? { h: +em[1], min: +em[2] } : null;
  return res;
}

// 发给客人的确认消息（标题不能包含三个关键词，避免回传时又触发）
function customerMessage(d, w, env, header) {
  const { y, m, d: day } = w.date;
  const h = w.start.h, min = w.start.min;
  const clock = `${h % 12 || 12}:${pad(min)}${h < 12 ? 'am' : 'pm'}`;
  const when = `${WD_LONG[dowOf({ y, m, d: day })]} ${day}/${m}, ${clock}`;
  const lines = [header];
  if (d.service) lines.push(`Service: ${d.service}`);
  if (d.price) lines.push(`Price: ${d.price}`);
  lines.push(`Time: ${when}`);
  if (d.address) lines.push(`Address: ${d.address}`);
  if (d.vehicle) lines.push(`Vehicle: ${d.vehicle}`);
  lines.push('', env.CONFIRM_FOOTER || 'Any changes, reply here or call Andy on 0478 701 289. See you then!');
  return lines.join('\n');
}

async function applyCustomLabel(psid, service, date, env) {
  const token = `access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN || '')}`;
  const base = `https://graph.facebook.com/${config(env).graph}`;
  const labelName = `${service || 'AC Service'} ${date.d}/${date.m}`;
  try {
    const listR = await fetch(`${base}/me/custom_labels?fields=id,name&limit=100&${token}`);
    const list = await listR.json();
    let labelId;
    const found = (list.data || []).find(l => l.name === labelName);
    if (found) {
      labelId = found.id;
    } else {
      const createR = await fetch(`${base}/me/custom_labels?${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: labelName }),
      });
      const created = await createR.json();
      if (created.error) throw new Error(created.error.message);
      labelId = created.id;
    }
    const applyR = await fetch(`${base}/${labelId}/label?${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: psid }),
    });
    const applied = await applyR.json();
    if (applied.error) throw new Error(applied.error.message);
  } catch (e) {
    console.error('applyCustomLabel error:', e.message);
  }
}

async function sendToCustomer(psid, text, env) {
  try {
    const r = await fetch(`https://graph.facebook.com/${config(env).graph}/me/messages?access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN || '')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text, metadata: BOT_TAG } }),
    });
    const j = await r.json();
    if (j.error) return { ok: false, error: j.error.message || 'Facebook error' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function doUpdate(ctx) {
  const { env, cfg, psid, text, name, link } = ctx;
  // 有 AI 就一律从对话找出改了什么（你在消息里写的栏位优先）；没有 AI 才照消息里写的修改
  const fields = extraFields(text);
  let fallback = '';
  if (ctx.manual) {
    // Booking change：只照消息修改日历
    if (!fields.length) throw new Error('Nothing to change. Add a line like Time:, Price:, Address: or Mobile:.');
  } else if (env.ANTHROPIC_API_KEY) {
    try {
      return await doUpdateFromChat(ctx);
    } catch (e) {
      // 后备：AI 或读对话失败时，消息里有写栏位就照消息内容修改
      if (!e.fallback) throw e;
      if (!fields.length) throw new Error(`${e.message}\n\nTo update it without AI, send the changed lines, e.g.\nBooking change\nTime: Sunday 3pm`);
      fallback = `⚠️ AI unavailable (${e.message}). Updated from your message only. No details were sent to the customer.`;
    }
  } else if (!fields.length) {
    throw new Error('Nothing to update. Add a line like Time:, Price:, Address: or Mobile:.');
  }

  const list = await findBookings(env, cfg, psid);
  if (!list.length) return notFound(env, name, link, null);
  const r = await applyUpdate(ctx, list[0], fields);
  if (fallback) r.lines.push(fallback);
  await bark(env, r.title, r.lines.join('\n') + moreBookings(list), link);
}

// 把 "标签: 内容" 的行套用到预约上，返回 Bark 要显示的内容
async function applyUpdate({ env, cfg, psid, name }, target, fields, { future = false } = {}) {
  const f = readFields(fields.join('\n'));
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
  let overlaps = [];

  if (f.time) {
    w = parseWhenParts(f.time, cfg);
    if (!w.date && !w.start) throw new Error("Couldn't read the new date or time. Please check the format.");
    const date = w.date || { y: old.y, m: old.m, d: old.d };
    const start = w.start || { h: old.h, min: old.min };
    const duration = target.endMs - target.startMs;
    t = buildTimes(date, start, w.end, duration > 0 ? duration : cfg.minutes * 60000);
    if (future) assertFuture(t, cfg);
    const startMs = zonedToUtc(t.start, cfg.tz), endMs = zonedToUtc(t.end, cfg.tz);
    changes.DTSTART = [`DTSTART:${utcStamp(startMs)}`];
    changes.DTEND = [`DTEND:${utcStamp(endMs)}`];
    changes.DURATION = null;
    changed.push('Time');
    overlaps = await findOverlaps(env, cfg, startMs, endMs, target.uid);
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

  // 其他栏位（Mobile、Vehicle 等）
  for (const l of fields) {
    const label = fieldLabel(l);
    if (!/^(service|price|time|address)$/i.test(label)) changed.push(label);
  }

  // 备注：同名的栏位直接换成新的，新栏位加在后面；最上面记一笔改动
  const others = changed.filter(c => c !== 'Time');
  const note = t
    ? `Rescheduled from ${old.label}` + (others.length ? ` · Changed: ${others.join(', ')}` : '')
    : `Updated: ${changed.join(', ')}`;
  const newLines = fields.map(l => (t && /^time$/i.test(fieldLabel(l)) ? `Time: ${t.label}` : l));
  changes.DESCRIPTION = [`DESCRIPTION:${icsEsc(mergeNotes(target.description, newLines, note))}`];

  try {
    await dav(env, 'PUT', target.href, {
      body: editEvent(target.ics, changes),
      headers: target.etag ? { 'if-match': target.etag } : {},
    });
  } catch (e) {
    if (e.status === 412) throw new Error('The event was changed on another device at the same moment. Please send the update again.');
    throw e;
  }

  const lines = t
    ? [`${t.label} (was ${old.label})` + (others.length ? ` · Changed: ${others.join(', ')}` : '')]
    : [`${old.label} · Changed: ${changed.join(', ')}`];
  if (w.warning) lines.push(w.warning);
  if (overlaps.length) lines.push(overlapLine(overlaps).trim());
  return { title: `🔄 ${t ? 'Booking rescheduled' : 'Booking updated'}: ${name}`, lines, t, w, old };
}

// 只发 "Booking updated"：读对话，找出改了什么，更新日历并自动回复客人
async function doUpdateFromChat(ctx) {
  const { env, cfg, psid, name, link } = ctx;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('Nothing to update. Add a line like Time:, Price:, Address: or Mobile:, or set ANTHROPIC_API_KEY to read the changes from the chat.');
  }
  const list = await findBookings(env, cfg, psid);
  if (!list.length) return notFound(env, name, link, null);
  const target = list[0];
  const old = localParts(target.startMs, cfg.tz);

  // 目前的资料：时间、标题里的服务价格、地点，以及备注里的各栏位
  const cur = { service: target.service, price: target.price, address: target.location, mobile: '', vehicle: '', notes: '' };
  for (const l of target.description.split('\n').map(x => x.trim()).filter(x => FIELD_RE.test(x))) {
    const k = fieldLabel(l).toLowerCase();
    const v = l.slice(l.search(/[:：]/) + 1).trim();
    if (k in cur && !cur[k]) cur[k] = v;
    if (['mobile', 'vehicle', 'notes'].includes(k)) cur[k] = v;
  }
  const currentText = [`Time: ${WD_LONG[dowOf(old)]} ${old.y}-${pad(old.m)}-${pad(old.d)} ${pad(old.h)}:${pad(old.min)}`]
    .concat(CHAT_FIELDS.filter(([k]) => k !== 'time').map(([k, label]) => `${label}: ${cur[k] || '(none)'}`)).join('\n');

  const chat = await readConversation(psid, env, cfg);
  const ai = await aiFromChat(chat, cfg, env, currentText);

  // 你在消息里写的栏位优先
  const typed = {};
  const typedOther = [];
  for (const l of extraFields(ctx.text)) {
    const k = fieldLabel(l).toLowerCase();
    const v = l.slice(l.search(/[:：]/) + 1).trim();
    if (CHAT_FIELDS.some(([key]) => key === k)) typed[k] = v; else typedOther.push(l);
  }
  for (const [k] of CHAT_FIELDS) if (k !== 'time' && typed[k]) ai[k] = typed[k];

  // 跟目前的资料比较，只套用有变的栏位
  const fields = [];
  if (typed.time) fields.push(`Time: ${typed.time}`);
  else if (ai.date && ai.start) {
    const same = ai.date.y === old.y && ai.date.m === old.m && ai.date.d === old.d && ai.start.h === old.h && ai.start.min === old.min;
    const end = ai.end ? `-${pad(ai.end.h)}:${pad(ai.end.min)}` : '';
    if (!same) fields.push(`Time: ${ai.date.y}-${pad(ai.date.m)}-${pad(ai.date.d)} ${pad(ai.start.h)}:${pad(ai.start.min)}${end}`);
  }
  const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const [k, label] of CHAT_FIELDS) {
    if (k === 'time' || !ai[k]) continue;
    if (norm(ai[k]) !== norm(cur[k])) fields.push(`${label}: ${ai[k]}`);
  }
  fields.push(...typedOther);
  if (!fields.length) {
    throw new Error("Couldn't find any change in the chat. Add the changed lines, e.g. Time: Sunday 3pm, and send again.");
  }

  const r = await applyUpdate(ctx, target, fields, { future: true });

  // 自动回复客人更新后的完整资料
  const d = { ...cur };
  for (const l of fields) {
    const k = fieldLabel(l).toLowerCase();
    if (k !== 'time') d[k] = l.slice(l.search(/[:：]/) + 1).trim();
  }
  const when = r.t
    ? { date: r.w.date, start: r.w.start }
    : { date: { y: old.y, m: old.m, d: old.d }, start: { h: old.h, min: old.min } };
  const msg = customerMessage(d, when, env, env.UPDATE_HEADER || 'Andy Auto AC Regas – Updated');
  let sent = null;
  if (env.AUTO_REPLY !== 'false') sent = await sendToCustomer(psid, msg, env);

  const lines = [...r.lines, ...fields.filter(l => !/^time:/i.test(l)).map(l => `• ${l}`)];
  if (!sent) lines.push('ℹ️ Auto-reply is off, nothing was sent to the customer.');
  else if (sent.ok) lines.push('✉️ Updated details sent to the customer.');
  else lines.push('', `⚠️ Updated details NOT sent to the customer (${sent.error}). Please send it yourself:`, '', msg);
  await bark(env, r.title, lines.join('\n') + moreBookings(list), link);
}

function moreBookings(list) {
  return list.length > 1 ? '\nℹ️ This customer has other upcoming bookings.' : '';
}

function assertFuture(t, cfg) {
  if (zonedToUtc(t.start, cfg.tz) <= Date.now()) {
    throw new Error(`The time came out as ${t.label}, which is in the past. Add a Time: line, e.g. Time: Sunday 3pm, and send again.`);
  }
}

function overlapLine(overlaps) {
  return overlaps.length ? `\n⚠️ Overlaps with: ${overlaps.join('; ')}` : '';
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

async function handleScheduled(cron, env) {
  console.log('[scheduled] fired, cron=', cron);
  const cfg = config(env);
  // 0 0 * * * = 10am Brisbane → Messenger reminder to customers (skip same-day bookings)
  if (cron === '0 0 * * *') {
    const toRemind = await findTomorrowBookings(env, cfg, { skipToday: true });
    console.log('[scheduled] customer reminders:', toRemind.length);
    for (const e of toRemind) {
      if (!e.psid) continue;
      await sendToCustomer(e.psid, buildReminderMessage(e, cfg, env), env);
    }
    return;
  }

  const bookings = await findTomorrowBookings(env, cfg);
  console.log('[scheduled] bookings found:', bookings.length);
  if (!bookings.length) {
    await bark(env, '📅 Tomorrow: No bookings', '', '');
    return;
  }

  // all other crons (0 9 * * * = 7pm Brisbane, or any test cron) → Bark to Andy
  const blocks = bookings.map(e => {
    const p = localParts(e.startMs, cfg.tz);
    const clock = `${p.h % 12 || 12}:${pad(p.min)}${p.h < 12 ? 'am' : 'pm'}`;
    const desc = e.description || '';
    let service = e.service || '';
    let price = e.price || '';
    let vehicle = desc.match(/^Vehicle:\s*(.+)$/im)?.[1]?.trim() || '';
    if (!e.psid && (!service || !vehicle)) {
      const parsed = parseSummaryFields(e.summary || '');
      if (!service) service = parsed.service;
      if (!price) price = parsed.price;
      if (!vehicle) vehicle = parsed.vehicle;
    }
    const mobile = desc.match(/^Mobile:\s*(.+)$/im)?.[1]?.trim() || '';
    const parts = [clock];
    if (service) parts.push(service);
    if (price) parts.push(price);
    const row1 = parts.join(' · ');
    const row2 = [vehicle, e.location].filter(Boolean).join(' · ');
    const row3 = [e.name || 'Customer', mobile].filter(Boolean).join(' · ');
    return [row1, row2, row3].filter(Boolean).join('\n');
  });
  const workerUrl = env.WORKER_URL || 'https://fb-booking-andy-auto.susanna0liu.workers.dev';
  const printUrl = `${workerUrl}/print?secret=${encodeURIComponent(env.VERIFY_TOKEN || '')}`;
  await bark(env, `📅 Tomorrow: ${bookings.length} APPOINTMENT${bookings.length > 1 ? 'S' : ''}`, blocks.join('\n───\n'), printUrl);
}

function buildReminderMessage(e, cfg, env) {
  const p = localParts(e.startMs, cfg.tz);
  const clock = `${p.h % 12 || 12}:${pad(p.min)}${p.h < 12 ? 'am' : 'pm'}`;
  const when = `${WD_LONG[dowOf(p)]} ${p.d}/${p.m}, ${clock}`;
  const vehicle = (e.description || '').match(/^Vehicle:\s*(.+)$/im)?.[1]?.trim() || '';
  const lines = ['Hi! Just a reminder of your booking tomorrow with Andy Auto AC Regas:'];
  if (vehicle) lines.push(`Vehicle: ${vehicle}`);
  if (e.service) lines.push(`Service: ${e.service}`);
  if (e.price) lines.push(`Price: ${e.price}`);
  lines.push(`Time: ${when}`);
  if (e.location) lines.push(`Address: ${e.location}`);
  lines.push('', env.CONFIRM_FOOTER || 'Any changes, reply here or call Andy on 0478 701 289. See you then!');
  return lines.join('\n');
}

function parseSummaryFields(summary) {
  // Strip customer name (FB format: "Service $Price – Name")
  const s = summary.replace(/\s*–\s*.+$/, '').trim();
  const priceMatch = s.match(/\$[\d,]+/);
  const price = priceMatch ? priceMatch[0] : '';
  const withoutPrice = s.replace(/\$[\d,]+/, '').trim();
  // Split service from vehicle: vehicle usually starts with a 4-digit year
  const yearIdx = withoutPrice.search(/\b(19|20)\d{2}\b/);
  let service = '', vehicle = '';
  if (yearIdx > 0) {
    service = withoutPrice.slice(0, yearIdx).trim();
    vehicle = withoutPrice.slice(yearIdx).trim();
  } else {
    // No year — first word is service, rest is vehicle
    const parts = withoutPrice.split(/\s+/);
    service = parts[0] || '';
    vehicle = parts.slice(1).join(' ');
  }
  return { service, price, vehicle };
}

async function printPage(env, origin) {
  const cfg = config(env);
  const bookings = await findTomorrowBookings(env, cfg);
  const today = todayInTz(cfg.tz);
  const tom = new Date(today.y, today.m - 1, today.d + 1);
  const dateStr = `${WD_LONG[tom.getDay()]} ${tom.getDate()}/${tom.getMonth() + 1}/${tom.getFullYear()}`;

  const rows = bookings.map((e, i) => {
    const p = localParts(e.startMs, cfg.tz);
    const clock = `${p.h % 12 || 12}:${pad(p.min)}${p.h < 12 ? 'am' : 'pm'}`;
    const desc = e.description || '';
    const isSms = !e.psid;
    // FB bookings: service/price from X-FB fields; SMS: parse from summary
    let service = e.service || '';
    let price = e.price || '';
    let vehicle = desc.match(/^Vehicle:\s*(.+)$/im)?.[1]?.trim() || '';
    if (isSms && (!service || !vehicle)) {
      const parsed = parseSummaryFields(e.summary || '');
      if (!service) service = parsed.service;
      if (!price) price = parsed.price;
      if (!vehicle) vehicle = parsed.vehicle;
    }
    const mobile = desc.match(/^Mobile:\s*(.+)$/im)?.[1]?.trim() || '';
    const bg = isSms ? '#e0e0e0' : '#fff';
    const source = isSms ? 'SMS' : 'FB';
    return `<tr style="background:${bg}">
      <td class="n">${i + 1}</td>
      <td class="src">${source}</td>
      <td class="time">${clock}</td>
      <td>${service}</td>
      <td>${price}</td>
      <td class="veh">${vehicle}</td>
      <td class="addr">${e.location || ''}</td>
      <td>${e.name || ''}</td>
      <td>${mobile}</td>
    </tr>`;
  }).join('');

  const empty = bookings.length === 0
    ? '<p class="empty">No bookings for tomorrow.</p>' : '';

  const tableHtml = bookings.length === 0 ? '' : `
  <table>
    <thead><tr>
      <th>#</th><th>Source</th><th>Time</th><th>Service</th><th>Price</th>
      <th>Vehicle</th><th>Address</th><th>Customer</th><th>Mobile</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Andy Auto – ${dateStr}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 24px 32px; color: #111; }
  h1 { font-size: 1.15em; margin-bottom: 2px; }
  h2 { font-size: 0.95em; color: #555; margin-top: 0; font-weight: normal; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.88em; }
  th { background: #222; color: #fff; padding: 7px 10px; text-align: left; font-weight: normal; white-space: nowrap; }
  td { padding: 8px 10px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
  td.n { color: #aaa; width: 24px; font-size: 0.85em; }
  td.time { white-space: nowrap; font-weight: bold; }
  td.addr { max-width: 180px; word-break: break-word; }
  td.veh  { max-width: 140px; word-break: break-word; }
  .empty { color: #888; font-style: italic; }
  .src { color: #111; font-size: 0.8em; text-align: center; white-space: nowrap; width: 40px; }
  @media print { tr { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  @media print {
    @page { size: A4 landscape; margin: 15mm; }
    body { margin: 0; }
    th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head><body>
<h1>Andy Auto AC Regas</h1>
<h2>Appointments for ${dateStr} &nbsp;·&nbsp; ${bookings.length} booking${bookings.length !== 1 ? 's' : ''}</h2>
${empty}${tableHtml}
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

async function findTomorrowBookings(env, cfg, { skipToday = false } = {}) {
  const cal = await calendarUrl(env);
  const today = todayInTz(cfg.tz);
  const tom = new Date(today.y, today.m - 1, today.d + 1);
  const t = { y: tom.getFullYear(), m: tom.getMonth() + 1, d: tom.getDate() };
  const startMs = zonedToUtc(`${t.y}-${pad(t.m)}-${pad(t.d)}T00:00:00`, cfg.tz);
  const endMs = zonedToUtc(`${t.y}-${pad(t.m)}-${pad(t.d)}T23:59:59`, cfg.tz);
  const r = await dav(env, 'REPORT', cal, {
    depth: 1,
    body: `${XML_HEAD}<c:calendar-query ${NS}><d:prop><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utcStamp(startMs)}" end="${utcStamp(endMs)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  const list = [];
  for (const resp of xmlAll(r.text, 'response')) {
    const ics = xmlText(xmlOne(resp, 'calendar-data'));
    if (!ics.includes('BEGIN:VEVENT')) continue;
    const e = parseEvent(ics, cfg.tz);
    if (!e.startMs) continue;
    if (skipToday && e.createdMs) {
      const created = localParts(e.createdMs, cfg.tz);
      if (created.y === today.y && created.m === today.m && created.d === today.d) continue;
    }
    list.push(e);
  }
  return list.sort((a, b) => a.startMs - b.startMs);
}

async function onCustomerMessage(ev, env, origin) {
  const cfg = config(env);
  const psid = ev.sender.id;
  const name = await getCustomerName(psid, env);

  const kvKey = `bark-${psid}`;
  const now = Date.now();
  const bookings = await findAllBookings(env, cfg, psid).catch(() => []);
  const past = bookings.filter(e => e.startMs < now).sort((a, b) => b.startMs - a.startMs);
  const upcoming = bookings.filter(e => e.startMs >= now).sort((a, b) => a.startMs - b.startMs);

  const tags = [...(upcoming.length ? ['Upcoming appointment'] : []), ...(past.length ? ['Old customer'] : [])];
  const title = tags.length ? `💬 ${name || 'Customer'} / ${tags.join(' · ')}` : `💬 ${name || 'Customer'}`;

  let body = ev.message.text || '';

  // 历史预约只在 4 小时内第一条消息时显示
  const hasHistory = upcoming.length || past.length;
  const showHistory = hasHistory && env.BARK_COOLDOWN
    ? !(await env.BARK_COOLDOWN.get(kvKey))
    : hasHistory > 0;

  if (showHistory) {
    const fmt = e => {
      const p = localParts(e.startMs, cfg.tz);
      return `• ${[e.service, e.price].filter(Boolean).join(' ')} · ${p.label}`;
    };
    const sections = [];
    if (upcoming.length) sections.push(`Upcoming:\n${upcoming.map(fmt).join('\n')}`);
    if (past.length) sections.push(`Past:\n${past.map(fmt).join('\n')}`);
    body = `${sections.join('\n\n')}\n─────────────────\n${body}`;
    if (env.BARK_COOLDOWN) {
      await env.BARK_COOLDOWN.put(kvKey, '1', { expirationTtl: 4 * 3600 });
    }
  }

  await bark(env, title, body, '');
}

// ================= 读取消息 =================

function readFields(text) {
  const field = label => {
    const m = text.match(new RegExp(`^[ \\t]*${label}[ \\t]*[:：][ \\t]*(.+)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  return { service: field('Service'), price: field('Price'), time: field('Time'), address: field('Address'), name: field('Name') };
}

// 消息里所有 "标签: 内容" 格式的行（开头那行和结尾的客套话、你的电话都不放）
function extraFields(text) {
  return text.split(/\r?\n/).map(l => l.trim())
    .filter(l => FIELD_RE.test(l) && !/^booking\b/i.test(l.replace(/^[^A-Za-z]+/, ''))); // 关键词那行不算栏位
}

const FIELD_RE = /^[A-Za-z\u4e00-\u9fff][\w \u4e00-\u9fff]{0,24}[:：]\s*\S/;
const fieldLabel = l => l.split(/[:：]/)[0].trim();

function mergeNotes(old, newLines, note) {
  const lines = old ? old.split('\n') : [];
  for (const u of newLines) {
    const key = fieldLabel(u).toLowerCase();
    let idx = -1;
    lines.forEach((l, i) => { if (FIELD_RE.test(l.trim()) && fieldLabel(l.trim()).toLowerCase() === key) idx = i; });
    if (idx >= 0) lines[idx] = u; else lines.push(u);
  }
  const hasHistory = /^(Rescheduled from|Updated:)/.test(lines[0] || '');
  return [note, ...(hasHistory || !lines.length ? [] : ['']), ...lines].join('\n').trim();
}

function buildSummary(name, service, price) {
  const svc = service || 'AC Service';
  return `${svc}${price ? ` ${price}` : ''} – ${name}`;
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
    const tagged = e.psid || (e.uid.match(/-(\d+)@fb-booking$/) || [])[1]; // 隐藏栏位或 UID 里的客人编号
    if (tagged ? tagged !== psid : !e.description.includes(psid)) continue; // 旧事件：备注里的 Customer ID
    e.href = new URL(xmlText(xmlOne(resp, 'href')), cal).href;
    e.etag = xmlText(xmlOne(resp, 'getetag')) || null;
    list.push(e);
  }
  return list.sort((a, b) => a.startMs - b.startMs);
}

async function findAllBookings(env, cfg, psid) {
  const cal = await calendarUrl(env);
  const now = Date.now();
  const r = await dav(env, 'REPORT', cal, {
    depth: 1,
    body: `${XML_HEAD}<c:calendar-query ${NS}><d:prop><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utcStamp(now - 730 * 864e5)}" end="${utcStamp(now + 400 * 864e5)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  const list = [];
  for (const resp of xmlAll(r.text, 'response')) {
    const ics = xmlText(xmlOne(resp, 'calendar-data'));
    if (!ics.includes('BEGIN:VEVENT')) continue;
    const e = parseEvent(ics, cfg.tz);
    if (!e.startMs) continue;
    const tagged = e.psid || (e.uid.match(/-(\d+)@fb-booking$/) || [])[1];
    if (tagged ? tagged !== psid : !e.description.includes(psid)) continue;
    list.push(e);
  }
  return list.sort((a, b) => b.startMs - a.startMs); // 最近的排最前
}

// 同一时段日历里的其他事件（不论是谁的，包括手动建立的）
async function findOverlaps(env, cfg, startMs, endMs, excludeUid) {
  const cal = await calendarUrl(env);
  const r = await dav(env, 'REPORT', cal, {
    depth: 1,
    body: `${XML_HEAD}<c:calendar-query ${NS}><d:prop><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utcStamp(startMs)}" end="${utcStamp(endMs)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  const out = [];
  for (const resp of xmlAll(r.text, 'response')) {
    const ics = xmlText(xmlOne(resp, 'calendar-data'));
    if (!ics.includes('BEGIN:VEVENT')) continue;
    const e = parseEvent(ics, cfg.tz);
    if (!e.startMs || e.uid === excludeUid) continue;
    if (!(e.startMs < endMs && e.endMs > startMs)) continue;
    const a = localParts(e.startMs, cfg.tz), b = localParts(e.endMs, cfg.tz);
    out.push(`${e.summary || '(no title)'} ${pad(a.h)}:${pad(a.min)}–${pad(b.h)}:${pad(b.min)}`);
  }
  return out;
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
  const createdMs = icsTime(p.CREATED, tz);
  return {
    ics, startMs, endMs, createdMs,
    uid: val('UID'),
    sequence: parseInt(val('SEQUENCE') || '0', 10) || 0,
    description: val('DESCRIPTION'), summary: val('SUMMARY'), location: val('LOCATION'),
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

// 客人名字：先查客人资料；查不到（一般客人常见，因为需要额外权限）就从对话的参与者里找
async function getCustomerName(psid, env) {
  if (!env.PAGE_ACCESS_TOKEN) return null;
  const graph = `https://graph.facebook.com/${config(env).graph}`;
  const token = `access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`;
  try {
    const j = await (await fetch(`${graph}/${psid}?fields=first_name,last_name&${token}`)).json();
    const n = [j.first_name, j.last_name].filter(Boolean).join(' ');
    if (n) return n;
    console.error('name via profile failed', JSON.stringify(j.error || j));
  } catch (e) {
    console.error('name via profile failed', e);
  }
  try {
    const j = await (await fetch(`${graph}/me/conversations?platform=messenger&user_id=${psid}&fields=participants&${token}`)).json();
    const people = j.data?.[0]?.participants?.data || [];
    const p = people.find(x => x.id === psid);
    if (p?.name) return p.name;
    console.error('name via conversation failed', JSON.stringify(j.error || j));
  } catch (e) {
    console.error('name via conversation failed', e);
  }
  return null;
}

// 通知和日历里的链接：
//   设了 SHORTCUT_NAME → 直接执行 iPhone 的捷径（复制名字 + 打开 Business Suite），点一下就完成
//   没设            → 打开客人卡片网页（按一个按钮复制名字并打开收件箱）
function cardLink(origin, name, env = {}) {
  if (!name) return '';
  if (env.SHORTCUT_NAME) {
    return `shortcuts://run-shortcut?name=${encodeURIComponent(env.SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(name)}`;
  }
  if (!origin) return '';
  return `${origin}/c?n=${encodeURIComponent(name)}`;
}

function customerCard(name, env) {
  const inbox = env.INBOX_URL || 'https://business.facebook.com/latest/inbox/all';
  const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name || 'Customer')}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --btn:#0866ff; --btn2:#e4e6eb; --fg2:#111 }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#f2f2f2; --muted:#aaa; --btn2:#333; --fg2:#f2f2f2 } }
  body { margin:0; background:var(--bg); color:var(--fg); font:17px -apple-system,system-ui,sans-serif;
         display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; box-sizing:border-box }
  main { width:100%; max-width:420px; text-align:center }
  h1 { font-size:30px; margin:0 0 6px; word-break:break-word }
  p { color:var(--muted); margin:0 0 28px; font-size:15px }
  a, button { display:block; width:100%; box-sizing:border-box; border:0; border-radius:12px; padding:16px;
              font:600 17px -apple-system,system-ui,sans-serif; text-decoration:none; margin-bottom:12px; cursor:pointer }
  .main { background:var(--btn); color:#fff }
  .sub { background:var(--btn2); color:var(--fg2) }
  #ok { min-height:20px; color:var(--muted); font-size:14px }
  input { position:absolute; left:-9999px }
</style>
<main>
  <h1>${esc(name || 'Customer')}</h1>
  <p>Tap the button, then paste the name into the inbox search.</p>
  <a class="main" id="go" href="${esc(inbox)}">Copy name &amp; open inbox</a>
  <button class="sub" id="copy" type="button">Copy name only</button>
  <div id="ok"></div>
  <input id="t" value="${esc(name)}" readonly>
</main>
<script>
  function copyName() {
    var t = document.getElementById('t'), ok = false;
    try { t.removeAttribute('readonly'); t.select(); t.setSelectionRange(0, 9999); ok = document.execCommand('copy'); t.setAttribute('readonly', ''); } catch (e) {}
    try { if (navigator.clipboard) { navigator.clipboard.writeText(t.value); ok = true; } } catch (e) {}
    document.getElementById('ok').textContent = ok ? 'Name copied ✓' : 'Could not copy. Press and hold the name to copy it.';
  }
  document.getElementById('go').addEventListener('click', copyName);
  document.getElementById('copy').addEventListener('click', copyName);
</script></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// BARK_URL 可以放多个网址，用逗号隔开
async function bark(env, title, body, link) {
  const urls = (env.BARK_URL || '').split(/[,\s]+/).map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!urls.length) return;
  const path = `/${encodeURIComponent(title)}/${encodeURIComponent(String(body || ' ').slice(0, 1500))}`;
  let query = `?group=${encodeURIComponent(env.BARK_GROUP || 'Bookings')}`;
  if (link) query += `&url=${encodeURIComponent(link)}`;
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
