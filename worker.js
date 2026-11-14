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
 *   BARK_GROUP           预约通知的 Bark 分组，默认 "Bookings"
  BARK_GROUP_CUSTOMER  客人来消息的 Bark 分组，默认 "Customers"
  BARK_SOUND_BOOKING   预约通知（新增/更新/取消）的铃声名，不设则用 Bark 默认声音
                       客人来消息的通知永远用 Bark 默认声音（不受此变量影响）
                       铃声名可在 Bark App → 设置 → 通知铃声 里查看，例如：
                       calypso / minuet / chime / bell / glass / telegraph / update
 *   DEFAULT_MINUTES      没写结束时间时的时长，默认 90
 *   TIMEZONE             默认 "Australia/Brisbane"
 *   GRAPH_VERSION        默认 "v23.0"
 *   ANTHROPIC_API_KEY    读对话、AI 整理资料、自动回复客人需要
 *   AUTO_REPLY           "false" = Booking confirmed / updated 时不自动发消息给客人（默认会发）
 *   CONFIRM_HEADER       自动确认消息的第一行，默认 "✅ Booking details – Andy Auto AC Regas"
 *   UPDATE_HEADER        自动更新消息的第一行，默认 "🔄 Updated booking details – Andy Auto AC Regas"
 *   CONFIRM_FOOTER       自动确认 / 更新消息的最后一行
 *   AI_MODEL             默认 "claude-sonnet-4-6"
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
      return printPage(env, url.origin, url.searchParams.get('date') || '');
    }

    // 打印页的每日备注：Andy 在页面上写的 TODO（call to order oring, pickup tools）
    if (url.pathname === '/notes' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('bad date', { status: 400 });
      const key = `note:${date}`;
      if (req.method === 'GET') {
        const v = env.BARK_COOLDOWN ? await env.BARK_COOLDOWN.get(key) : '';
        return new Response(v || '', { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      }
      if (req.method === 'POST') {
        const body = (await req.text()).slice(0, 2000);
        if (env.BARK_COOLDOWN) {
          if (body.trim()) await env.BARK_COOLDOWN.put(key, body, { expirationTtl: 60 * 24 * 3600 });
          else await env.BARK_COOLDOWN.delete(key);
        }
        return new Response('ok');
      }
    }

    // 车型冷媒数据库：Web 管理页 + CRUD API + 查询 API
    if (url.pathname === '/vehicles' && req.method === 'GET' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return vehiclesAdminPage(env, url.origin);
    }
    if (url.pathname === '/vehicles/api' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return vehiclesApi(req, env);
    }
    if (url.pathname === '/vehicle-lookup' && req.method === 'GET' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return vehicleLookup(url.searchParams, env);
    }
    // 冷媒单价（$/kg）—— 偶尔调价，存 KV
    if (url.pathname === '/refrigerant-prices' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return refrigerantPricesHandler(req, env);
    }
    // CRM：每单工单标记（状态/支付/实收）+ Calendar 事件字段编辑
    if (url.pathname === '/bookings/meta' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return bookingsMetaHandler(req, url, env);
    }
    if (url.pathname === '/bookings/edit' && req.method === 'POST' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return bookingEditHandler(req, url, env);
    }
    if (url.pathname === '/report' && req.method === 'GET' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return reportPage(req, url, env);
    }
    // One-off migration: rename "Notes:" → "AI notes:" in historic events.
    // Idempotent: skips events that already have an "AI notes:" line.
    if (url.pathname === '/migrate-ai-notes' && req.method === 'POST' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      return migrateAiNotesHandler(env);
    }

    // SMS / 电话预约：接收 Shortcut 发来的对话文字，AI 整理后建日历
    if (req.method === 'POST' && url.pathname === '/sms-booking' &&
        url.searchParams.get('secret') === (env.VERIFY_TOKEN || '')) {
      const cfg = config(env);
      const contentType = (req.headers.get('content-type') || '').split(';')[0].trim();
      const errHandler = e => { console.error('sms-booking error', e); return bark(env, '⚠️ SMS booking failed', e.message, ''); };
      if (contentType.startsWith('image/') || contentType === 'application/octet-stream') {
        const buf = await req.arrayBuffer();
        ctx.waitUntil(doSmsBookingFromImage(buf, sniffMediaType(buf), env, cfg).catch(errHandler));
      } else if (contentType === 'application/json') {
        const j = await req.json();
        const buf = Uint8Array.from(atob(j.image), c => c.charCodeAt(0)).buffer;
        ctx.waitUntil(doSmsBookingFromImage(buf, sniffMediaType(buf), env, cfg).catch(errHandler));
      } else {
        const text = await req.text();
        ctx.waitUntil(doSmsBooking(text, env, cfg).catch(errHandler));
      }
      return new Response('ok');
    }

    // iMessage 轮询三件套 ----------------------------------------
    // /imessage-task  (POST)  iPhone Shortcut 提交电话号码
    // /imessage-poll  (GET)   Mac 每 5 秒问有没有任务
    // /imessage-result (POST) Mac 把读到的对话发回来
    const imsecret = env.VERIFY_TOKEN || '';
    if (url.pathname === '/imessage-task' &&
        url.searchParams.get('secret') === imsecret) {
      if (req.method !== 'POST') return new Response('method', { status: 405 });
      const j = await req.json().catch(() => ({}));
      const phone = (j.phone || '').trim();
      if (!phone) return new Response(JSON.stringify({ error: 'no phone' }), { status: 400, headers: { 'content-type': 'application/json' } });
      await env.BARK_COOLDOWN.put('imsg-task', phone, { expirationTtl: 300 });
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/imessage-poll' &&
        url.searchParams.get('secret') === imsecret) {
      if (req.method !== 'GET') return new Response('method', { status: 405 });
      const phone = await env.BARK_COOLDOWN.get('imsg-task');
      if (phone) await env.BARK_COOLDOWN.delete('imsg-task');
      return new Response(JSON.stringify({ phone: phone || null }), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/imessage-result' &&
        url.searchParams.get('secret') === imsecret) {
      if (req.method !== 'POST') return new Response('method', { status: 405 });
      const j = await req.json().catch(() => ({}));
      const conversation = (j.conversation || '').trim();
      const phone = (j.phone || '').trim();
      if (!conversation) {
        ctx.waitUntil(bark(env, `ℹ️ No iMessages found`, `Phone: ${phone}\nNo iMessage history on this Mac for this number.`, ''));
        return new Response(JSON.stringify({ ok: true, warning: 'empty conversation' }), { headers: { 'content-type': 'application/json' } });
      }
      const cfg = config(env);
      ctx.waitUntil(
        doSmsBooking(conversation, env, cfg, phone)
          .catch(e => { console.error('imessage-result error', e); return bark(env, '⚠️ iMessage booking failed', e.message, ''); })
      );
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/imessage-keyword' &&
        url.searchParams.get('secret') === imsecret) {
      if (req.method !== 'POST') return new Response('method', { status: 405 });
      const j = await req.json().catch(() => ({}));
      const conversation = (j.conversation || '').trim();
      const phone = (j.phone || '').trim();
      const action = (j.action || 'confirm').toLowerCase();
      const contactName = (j.contact_name || '').trim();
      if (!conversation) return new Response(JSON.stringify({ error: 'no conversation' }), { status: 400, headers: { 'content-type': 'application/json' } });
      const cfg = config(env);
      try {
        const reply = await doKeywordBooking(conversation, phone, action, env, cfg, contactName);
        return new Response(JSON.stringify({ ok: true, reply }), { headers: { 'content-type': 'application/json' } });
      } catch (e) {
        console.error('imessage-keyword error', e);
        await bark(env, `⚠️ iMessage keyword failed`, e.message, '');
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }
    // ---------------------------------------------------------------

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
    await barkBooking(env, `${title}: ${ctx.name}`, `${e.message}\n\n${text}`, ctx.link);
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
  await barkBooking(env, `📅 Booking added: ${name}`, body, barkTimeLink(t.label, env), t.label);
}

// ================= SMS / 电话预约 =================

// A message starts at a "[DD/MM HH:MM] " timestamp. Everything until the next
// timestamp belongs to the same message (for multi-line replies like ✅ blocks).
const MSG_START_RE = /^\[\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\]\s/;

// Trim conversation to only messages AFTER the last ✅/🔄 Us reply (including
// its multi-line body). Used for UPDATED action where only post-confirmation
// changes matter.
function trimToLastConfirmation(conversationText) {
  const lines = conversationText.split('\n');
  let lastConfIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Us:.*[✅🔄]/.test(lines[i])) lastConfIdx = i;
  }
  if (lastConfIdx < 0) return conversationText;
  // Walk past the entire multi-line ✅ body until we hit the next message
  let end = lastConfIdx + 1;
  while (end < lines.length && !MSG_START_RE.test(lines[end])) end++;
  return lines.slice(end).join('\n');
}

// Replace the Time: line in every ✅/🔄 Us message with a redaction marker.
// For the CONFIRMED/UPDATED action, every ✅/🔄 in history is from a PAST
// booking (the current trigger has not been replied to yet). Keeping
// address/vehicle context but removing stale time/date fixes the common
// "time came out as 18/10 Sunday 3pm, in the past" failure.
function redactOldConfirmationTimes(conversationText) {
  const lines = conversationText.split('\n');
  const confIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/Us:.*[✅🔄]/.test(lines[i])) confIdx.push(i);
  }
  if (!confIdx.length) return conversationText;
  const out = lines.slice();
  for (const start of confIdx) {
    let i = start + 1;
    while (i < out.length && !MSG_START_RE.test(out[i])) {
      if (/^\s*Time:\s*/i.test(out[i])) out[i] = '  [past booking time — ignore]';
      i++;
    }
  }
  return out.join('\n');
}

// Append a trigger marker so the AI knows which message is the actual
// booking trigger, especially in long histories.
function appendTriggerMarker(conversationText, action) {
  const label = action === 'updated' || action === 'update' ? 'update'
    : action === 'cancelled' || action === 'cancel' ? 'cancellation'
    : 'booking';
  return conversationText + `\n\n===\nThe LAST "Us: Booking ${action}" message above is the trigger for this ${label}. Extract details from the exchange immediately leading up to it. Older ✅ messages are from past bookings — their time is redacted, but address/vehicle may still be reused if the customer has not provided new ones.`;
}

async function doKeywordBooking(conversationText, phone, action, env, cfg, contactName = '') {
  let textForAi;
  if (action === 'updated' || action === 'update') {
    textForAi = trimToLastConfirmation(conversationText);
  } else if (action === 'confirmed' || action === 'confirm') {
    textForAi = redactOldConfirmationTimes(conversationText);
  } else {
    textForAi = conversationText;
  }
  textForAi = appendTriggerMarker(textForAi, action);
  console.log(`doKeywordBooking action=${action} phone=${phone} conv=${conversationText.length}→${textForAi.length} chars`);
  const ai = await aiFromSmsChat(textForAi, cfg, env, contactName);
  console.log(`AI extracted: name=${ai.name!==undefined} date=${!!ai.date} start=${!!ai.start} addr=${!!ai.address} svc=${!!ai.service} price=${!!ai.price}`);
  if (phone) ai.mobile = phone;
  if (action === 'confirmed' || action === 'confirm') {
    await saveSmsFromAi(ai, env, cfg, phone);
    const { y, m, d } = ai.date;
    const { h, min } = ai.start;
    const clock = `${h % 12 || 12}${min ? ':' + pad(min) : ''}${h < 12 ? 'am' : 'pm'}`;
    let when = `${d}/${m} ${WD_LONG[dowOf({ y, m, d })]} ${clock}`;
    if (ai.end) {
      let eh = ai.end.h;
      if (eh * 60 + ai.end.min <= h * 60 + min && eh < 12) eh += 12;
      const eclock = `${eh % 12 || 12}${ai.end.min ? ':' + pad(ai.end.min) : ''}${eh < 12 ? 'am' : 'pm'}`;
      when += ` – ${eclock}`;
    }
    return `✅ Andy Auto AC Regas\nTime: ${when}\nSee you then!`;
  }
  if (action === 'updated' || action === 'update') {
    const list = await findBookingsByPhone(phone, env, cfg);
    if (!list.length) {
      await saveSmsFromAi(ai, env, cfg, phone);
      await bark(env, `⚠️ Booking updated: no existing event found`, `Created new booking for ${phone} instead.`, '');
      const { y, m, d } = ai.date; const { h, min } = ai.start;
      const clock = `${h % 12 || 12}${min ? ':' + pad(min) : ''}${h < 12 ? 'am' : 'pm'}`;
      let when = `${d}/${m} ${WD_LONG[dowOf({ y, m, d })]} ${clock}`;
      if (ai.end) {
        let eh = ai.end.h;
        if (eh * 60 + ai.end.min <= h * 60 + min && eh < 12) eh += 12;
        const eclock = `${eh % 12 || 12}${ai.end.min ? ':' + pad(ai.end.min) : ''}${eh < 12 ? 'am' : 'pm'}`;
        when += ` – ${eclock}`;
      }
      return `✅ Andy Auto AC Regas\nTime: ${when}\nSee you then!`;
    }
    const target = list[0];
    const old = localParts(target.startMs, cfg.tz);
    const now = utcStamp(Date.now());
    const changes = {
      SEQUENCE: [`SEQUENCE:${target.sequence + 1}`],
      DTSTAMP: [`DTSTAMP:${now}`],
      'LAST-MODIFIED': [`LAST-MODIFIED:${now}`],
    };
    const replyLines = [];
    const noteFields = [];

    if (ai.date && ai.start) {
      const sameDate = ai.date.y === old.y && ai.date.m === old.m && ai.date.d === old.d;
      const sameTime = ai.start.h === old.h && ai.start.min === old.min;
      if (!sameDate || !sameTime) {
        const duration = target.endMs - target.startMs;
        const t = buildTimes(ai.date, ai.start, ai.end, duration > 0 ? duration : cfg.minutes * 60000);
        changes.DTSTART = [`DTSTART:${utcStamp(zonedToUtc(t.start, cfg.tz))}`];
        changes.DTEND = [`DTEND:${utcStamp(zonedToUtc(t.end, cfg.tz))}`];
        changes.DURATION = null;
        const { y, m, d } = ai.date; const { h, min } = ai.start;
        const clock = `${h % 12 || 12}${min ? ':' + pad(min) : ''}${h < 12 ? 'am' : 'pm'}`;
        const label = `${d}/${m} ${WD_LONG[dowOf({ y, m, d })]} ${clock}`;
        replyLines.push(`Updated time: ${label}`);
        noteFields.push(`Time: ${t.label}`);
      }
    }
    // address and vehicle are intentionally skipped — SMS update is for time/service/price only
    if (ai.service && ai.service !== target.service) {
      changes['X-FB-SERVICE'] = [`X-FB-SERVICE:${icsEsc(ai.service)}`];
      replyLines.push(`Updated service: ${ai.service}`);
      noteFields.push(`Service: ${ai.service}`);
    }
    if (ai.price && ai.price !== target.price) {
      changes['X-FB-PRICE'] = [`X-FB-PRICE:${icsEsc(ai.price)}`];
      replyLines.push(`Updated price: ${ai.price}`);
      noteFields.push(`Price: ${ai.price}`);
    }
    if (changes['X-FB-SERVICE'] || changes['X-FB-PRICE']) {
      changes.SUMMARY = [`SUMMARY:${icsEsc(buildSummary(target.name || 'SMS Customer', ai.service || target.service, ai.price || target.price))}`];
    }
    if (!replyLines.length) {
      await bark(env, `ℹ️ Booking updated: no changes detected`, `Phone: ${phone}`, '');
      return null;
    }
    const changedLabels = replyLines.map(l => l.replace(/^Updated /, '').split(':')[0]);
    changes.DESCRIPTION = [`DESCRIPTION:${icsEsc(mergeNotes(target.description, noteFields, `Updated: ${changedLabels.join(', ')}`))}` ];
    try {
      await dav(env, 'PUT', target.href, { body: editEvent(target.ics, changes), headers: target.etag ? { 'if-match': target.etag } : {} });
    } catch (e) {
      if (e.status === 412) throw new Error('The event was changed on another device. Please send the update again.');
      throw e;
    }
    await barkBooking(env, `🔄 Booking updated: ${target.name || 'SMS Customer'}`, replyLines.join('\n'), '', '');
    return `🔄 Andy Auto AC Regas\n${replyLines.join('\n')}\nSee you then!`;
  }

  if (action === 'cancelled' || action === 'cancel') {
    const list = await findBookingsByPhone(phone, env, cfg);
    if (!list.length) {
      await bark(env, `⚠️ Booking not found for ${phone}`, 'No upcoming booking found. Please update the calendar manually.', '');
      return null;
    }
    const target = list[0];
    try {
      await dav(env, 'DELETE', target.href, { headers: target.etag ? { 'if-match': target.etag } : {}, ok: [404] });
    } catch (e) {
      if (e.status === 412) throw new Error('The event was changed on another device. Please try cancelling again.');
      throw e;
    }
    const p = localParts(target.startMs, cfg.tz);
    const more = list.length > 1 ? '\nℹ️ This customer has other upcoming bookings.' : '';
    await barkBooking(env, `❌ Booking cancelled: ${target.name || 'SMS Customer'}`, [p.label, target.service].filter(Boolean).join(' · ') + more, '', '');
    return `Feel free to rebook anytime!`;
  }

  throw new Error(`Action "${action}" not yet supported via iMessage keyword`);
}

async function doSmsBooking(conversationText, env, cfg, phone = '') {
  if (!conversationText.trim()) throw new Error('Empty conversation.');
  const ai = await aiFromSmsChat(conversationText, cfg, env);
  if (phone) ai.mobile = phone;
  await saveSmsFromAi(ai, env, cfg, phone);
}

async function doSmsBookingFromImage(imageBuffer, mediaType, env, cfg) {
  const base64 = arrayBufferToBase64(imageBuffer);
  const ai = await aiFromScreenshot(base64, mediaType, cfg, env);
  await saveSmsFromAi(ai, env, cfg);
}

async function saveSmsFromAi(ai, env, cfg, phone = '') {
  if (!ai.date || !ai.start) throw new Error("Couldn't find the booking date and time.");

  const t = buildTimes(ai.date, ai.start, ai.end, cfg.minutes * 60000);
  assertFuture(t, cfg);

  const name = ai.name || phone || 'SMS Customer';
  const link = smsLink(ai.mobile);

  const notes = ['SMS booking'];
  const FIELDS = [['service','Service'],['price','Price'],['time','time'],['address','Address'],['mobile','Mobile'],['vehicle','Vehicle'],['ai_notes','AI notes']];
  for (const [k, label] of FIELDS) {
    if (k === 'time') { notes.push(`Time: ${t.label}`); continue; }
    if (ai[k]) notes.push(`${label}: ${ai[k]}`);
  }

  const id = (await sha256hex(`sms-${name}-${ai.date.y}-${pad(ai.date.m)}-${pad(ai.date.d)}-${pad(ai.start.h)}${pad(ai.start.min)}`)).slice(0, 32);
  const uid = `${id}-sms@fb-booking`;
  const overlaps = await findOverlaps(env, cfg, zonedToUtc(t.start, cfg.tz), zonedToUtc(t.end, cfg.tz), uid);

  const ics = buildEvent({
    uid,
    startMs: zonedToUtc(t.start, cfg.tz),
    endMs: zonedToUtc(t.end, cfg.tz),
    summary: buildSummary(name, ai.service, ai.price),
    location: ai.address,
    description: notes.join('\n'),
    url: link,
    x: { psid: '', name, service: ai.service, price: ai.price,
         'X-VEH-MAKE': ai.vehicle_make || '', 'X-VEH-MODEL': ai.vehicle_model || '',
         'X-VEH-YEAR': ai.vehicle_year || '', 'X-VEH-VARIANT': ai.vehicle_variant || '' },
  });

  const cal = await calendarUrl(env);
  try {
    await dav(env, 'PUT', `${cal}${id}.ics`, { body: ics, headers: { 'if-none-match': '*' } });
  } catch (e) {
    if (e.status === 412) {
      await barkBooking(env, `ℹ️ Already in calendar: ${name}`, t.label, link);
      return;
    }
    throw e;
  }

  const lines = [
    [t.label, ai.service, ai.price].filter(Boolean).join(' · '),
    ai.address, ai.mobile && `📱 ${ai.mobile}`, ai.vehicle && `🚗 ${ai.vehicle}`, ai.ai_notes && `📝 ${ai.ai_notes}`,
  ].filter(Boolean);
  if (overlaps.length) lines.push(overlapLine(overlaps).trim());
  await barkBooking(env, `📅 SMS Booking added: ${name}`, lines.join('\n'), '', t.label);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function sniffMediaType(buf) {
  const b = new Uint8Array(buf, 0, 12);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return 'image/jpeg';
}

async function aiFromScreenshot(base64, mediaType, cfg, env) {
  const t = todayInTz(cfg.tz);
  const prompt =
`Today is ${WD_LONG[dowOf(t)]} ${t.y}-${pad(t.m)}-${pad(t.d)}, time zone ${cfg.tz}.
This is a screenshot of an SMS conversation. The business owner runs a mobile car air-conditioning service.
Extract the booking details and save them with the save_booking tool.

Rules:
- Dates are Australian (day/month). Words like "tomorrow" or "Sunday" are relative to today's date.
- Use the final agreed values (last price quoted, time the customer accepted).
- The business owner's phone number is 0478 701 289. Never use it as the customer's mobile.
- The customer's name is usually shown at the top of the screen as the conversation header.
- Leave a field as "" if not mentioned. Do not guess or invent anything.
- notes: only info the technician needs on-site that is NOT captured in other fields — e.g. gate code, parking instructions, specific symptom, part needed. IMPORTANT EXCEPTION: if the customer is coming to Andy's location (not a mobile visit to the customer), always write "Customer coming to us". Do NOT include: customer name, service breakdown, price reasoning, "mobile service at home", "time customer accepted", or any AI reasoning. Leave "" if nothing genuinely useful.`;

  const str = d => ({ type: 'string', description: d });
  const tool = {
    name: 'save_booking',
    description: 'Save the booking details extracted from the screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        name: str("Customer's name from the conversation header, or empty string if not visible"),
        date: str('YYYY-MM-DD, or "" if unknown'),
        start: str('HH:MM in 24-hour time, or "" if unknown'),
        end: str('If the conversation mentions an arrival window (e.g. "around 3:30–4pm", "between 2 and 2:30"), return the window END time in HH:MM 24-hour format (e.g. "16:00"). This is used to show the customer a range in the confirmation. Leave "" if only a single arrival time is mentioned with no range.'),
        service: str('Service type agreed with the customer. If one simple service, use 1-3 words (e.g. "Regas", "Pressure Test"). If multiple items are being done, list all of them separated by commas or "and" (e.g. "Change O-ring, replace valves and regas", "Compressor replacement + regas", "Vacuum, new gas, pressure test"). No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        price: str('e.g. $150. No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        address: str('Service address — use the most complete address mentioned: street number + street name + suburb is preferred over suburb alone. If a full street address and a suburb are both mentioned, use the full address. Preserve unit/flat numbers exactly as written (e.g. "2/32a Smith St" must stay as "2/32a Smith St", not "2 Smith St"). Do not include postcode, state (QLD) or country (Australia). No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        mobile: str("Customer's mobile number. Leave \"\" if not mentioned."),
        vehicle: str('e.g. 2016 Toyota Camry. No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        vehicle_make: str('Just the make, e.g. "Toyota", "Mazda", "Hyundai". Leave "" if the make isn\'t clear.'),
        vehicle_model: str('Just the model, e.g. "Camry", "Hilux", "CX-5". Leave "" if the model isn\'t clear.'),
        vehicle_year: str('4-digit year, e.g. "2016". Leave "" if the year isn\'t clear.'),
        vehicle_variant: str('Engine/trim distinguisher only when a customer specifically said so, e.g. "Hybrid", "Petrol", "Diesel", "2.5L". Leave "" otherwise.'),
        ai_notes: str('On-site info for the technician not captured elsewhere — e.g. gate code, parking, symptom, part needed. Leave "" if nothing genuinely useful. This fills a dedicated "AI notes" field in the Calendar description. Do NOT write anything that belongs to Andys own records (prices, quotes, reminders) — that is a separate field Andy controls.'),
      },
      required: ['name', 'date', 'start', 'end', 'service', 'price', 'address', 'mobile', 'vehicle', 'vehicle_make', 'vehicle_model', 'vehicle_year', 'vehicle_variant', 'ai_notes'],
    },
  };

  let o;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.AI_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1000,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'save_booking' },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });
    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw); } catch { throw new Error(`AI returned HTTP ${r.status}: ${raw.slice(0, 200)}`); }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    o = (j.content || []).find(c => c.type === 'tool_use')?.input;
    if (!o) throw new Error(`No booking details returned: ${JSON.stringify(j.content || j).slice(0, 200)}`);
  } catch (e) {
    throw new Error(`AI couldn't read the screenshot: ${e.message}`);
  }

  const cleanStr = s => String(s || '').trim().replace(/^["']+$/, '');
  const res = { name: cleanStr(o.name) };
  for (const k of ['service', 'price', 'address', 'mobile', 'vehicle', 'ai_notes']) res[k] = String(o[k] || '').trim();
  res.address = normalizeAddress(res.address);
  const dm = String(o.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const sm = String(o.start || '').match(/^(\d{1,2}):(\d{2})$/);
  const em = String(o.end || '').match(/^(\d{1,2}):(\d{2})$/);
  res.date = dm ? { y: +dm[1], m: +dm[2], d: +dm[3] } : null;
  res.start = sm ? { h: +sm[1], min: +sm[2] } : null;
  res.end = em ? { h: +em[1], min: +em[2] } : null;
  return res;
}

async function aiFromSmsChat(conversationText, cfg, env, contactName = '') {
  const t = todayInTz(cfg.tz);
  const contactNameLine = contactName
    ? `- The customer's address book label is: "${contactName}". This label is the ONLY source for the \`name\` field — use it even if it looks odd. CRITICAL: it is NOT a source for any other field. Never extract date, time, address, service, price, vehicle, or mobile from this label. Andy often writes past booking dates (e.g. "18/10 Sunday 3pm", "Mon 2pm", "21/10") into the label as an internal reminder — those dates/times are historical, not the new booking. Get date/time/address/etc. only from the conversation messages below.`
    : `- For the customer's name: use whatever name appears in the conversation, or empty string if unknown.`;
  const ownerRule = `- The business owner's name is Andy. Never use "Andy" as the customer's name.`;
  const prompt =
`Today is ${WD_LONG[dowOf(t)]} ${t.y}-${pad(t.m)}-${pad(t.d)}, time zone ${cfg.tz}.
Below is an SMS or phone conversation between a mobile car air-conditioning business and a customer.
The business owner is confirming a booking. Extract the booking details and save them with the save_booking tool.

Rules:
- Dates are Australian (day/month). Words like "tomorrow" or "Sunday" are relative to today's date unless a specific date is given.
- Use the final agreed values (last price quoted, time the customer accepted).
- If a time is expressed as "around X" or "about X" and the customer accepts it, use X as the start time. "Around" means approximate, not unknown — still extract it.
- If a customer says "my address is" or "address is" and the actual address appears in the same or next message, use that as the service address.
- The business's own phone number is 0478 701 289. Never use it as the customer's mobile.
${ownerRule}
${contactNameLine}
- Leave a field as "" if not mentioned. Do not guess or invent anything.
- If the conversation contains a previous ✅ Andy Auto AC Regas confirmation, that is from a past booking — ignore its date/time entirely. Only use the most recently agreed time between Andy and the customer in the latest exchange.
- notes: only info the technician needs on-site that is NOT captured in other fields — e.g. gate code, parking instructions, specific symptom, part needed. IMPORTANT EXCEPTION: if the customer is coming to Andy's location (not a mobile visit to the customer), always write "Customer coming to us". Do NOT include: customer name, service breakdown, price reasoning, "mobile service at home", "time customer accepted", or any AI reasoning. Leave "" if nothing genuinely useful.

Conversation:
${conversationText}`;

  const str = d => ({ type: 'string', description: d });
  const tool = {
    name: 'save_booking',
    description: 'Save the booking details.',
    input_schema: {
      type: 'object',
      properties: {
        name: str("Customer's real name. If the only name source is a date/time-like label (e.g. '21/10 Monday 3pm', '18/10 Sun', '3pm'), leave empty — that is Andy's internal booking label, not the customer's name. Leave empty if unknown."),
        date: str('YYYY-MM-DD, or "" if unknown'),
        start: str('HH:MM in 24-hour time, or "" if unknown'),
        end: str('If the conversation mentions an arrival window (e.g. "around 3:30–4pm", "between 2 and 2:30"), return the window END time in HH:MM 24-hour format (e.g. "16:00"). This is used to show the customer a range in the confirmation. Leave "" if only a single arrival time is mentioned with no range.'),
        service: str('Service type agreed with the customer. If one simple service, use 1-3 words (e.g. "Regas", "Pressure Test"). If multiple items are being done, list all of them separated by commas or "and" (e.g. "Change O-ring, replace valves and regas", "Compressor replacement + regas", "Vacuum, new gas, pressure test"). No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        price: str('e.g. $150. No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        address: str('Service address — use the most complete address mentioned: street number + street name + suburb is preferred over suburb alone. If a full street address and a suburb are both mentioned, use the full address. Preserve unit/flat numbers exactly as written (e.g. "2/32a Smith St" must stay as "2/32a Smith St", not "2 Smith St"). Do not include postcode, state (QLD) or country (Australia). No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        mobile: str("Customer's mobile number. Leave \"\" if not mentioned."),
        vehicle: str('e.g. 2016 Toyota Camry. No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        vehicle_make: str('Just the make, e.g. "Toyota", "Mazda", "Hyundai". Leave "" if the make isn\'t clear.'),
        vehicle_model: str('Just the model, e.g. "Camry", "Hilux", "CX-5". Leave "" if the model isn\'t clear.'),
        vehicle_year: str('4-digit year, e.g. "2016". Leave "" if the year isn\'t clear.'),
        vehicle_variant: str('Engine/trim distinguisher only when a customer specifically said so, e.g. "Hybrid", "Petrol", "Diesel", "2.5L". Leave "" otherwise.'),
        ai_notes: str('On-site info for the technician not captured elsewhere — e.g. gate code, parking, symptom, part needed. Leave "" if nothing genuinely useful. This fills a dedicated "AI notes" field in the Calendar description. Do NOT write anything that belongs to Andys own records (prices, quotes, reminders) — that is a separate field Andy controls.'),
      },
      required: ['name', 'date', 'start', 'end', 'service', 'price', 'address', 'mobile', 'vehicle', 'vehicle_make', 'vehicle_model', 'vehicle_year', 'vehicle_variant', 'ai_notes'],
    },
  };

  let o;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.AI_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1000,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'save_booking' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw); } catch { throw new Error(`AI returned HTTP ${r.status}: ${raw.slice(0, 200)}`); }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    o = (j.content || []).find(c => c.type === 'tool_use')?.input;
    if (!o) throw new Error(`No booking details returned: ${JSON.stringify(j.content || j).slice(0, 200)}`);
  } catch (e) {
    throw new Error(`AI couldn't read the conversation: ${e.message}`);
  }

  const cleanStr = s => String(s || '').trim().replace(/^["']+$/, '');
  const res = { name: cleanStr(o.name) };
  for (const k of ['service', 'price', 'address', 'mobile', 'vehicle', 'ai_notes']) res[k] = String(o[k] || '').trim();
  res.address = normalizeAddress(res.address);
  const dm = String(o.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const sm = String(o.start || '').match(/^(\d{1,2}):(\d{2})$/);
  const em = String(o.end || '').match(/^(\d{1,2}):(\d{2})$/);
  res.date = dm ? { y: +dm[1], m: +dm[2], d: +dm[3] } : null;
  res.start = sm ? { h: +sm[1], min: +sm[2] } : null;
  res.end = em ? { h: +em[1], min: +em[2] } : null;
  return res;
}

// 写入新预约。已经有同一时间的预约、或 Meta 重复推送时返回 false
async function saveNewBooking({ env, cfg, psid, mid, name, link }, { t, service, price, address, notes, veh_make, veh_model, veh_year, veh_variant }) {
  const id = (await sha256hex(mid)).slice(0, 32);
  const uid = `${id}-${psid}@fb-booking`; // 客人编号藏在事件的 UID 里，备注里不用写

  // 防重复：同一位客人同一时间已经有预约就跳过
  const existing = await findBookings(env, cfg, psid);
  const same = existing.find(e => sameLocalStart(e, t, cfg.tz));
  if (same) {
    if (same.uid !== uid) await barkBooking(env, `ℹ️ Already in calendar: ${name}`, t.label, link);
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
    x: { psid, name, service, price,
         'X-VEH-MAKE': veh_make || '', 'X-VEH-MODEL': veh_model || '',
         'X-VEH-YEAR': veh_year || '', 'X-VEH-VARIANT': veh_variant || '' },
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
  ['mobile', 'Mobile'], ['vehicle', 'Vehicle'],
  ['ai_notes', 'AI notes'],   // AI-extracted on-site info
  ['notes', 'Notes'],         // user-typed, left blank when created from chat
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
  for (const [k, label] of CHAT_FIELDS) {
    if (k === 'ai_notes') {
      // AI-only field; user-typed "AI notes:" would be odd, ignore
      d[k] = ai[k] || '';
    } else if (k === 'notes') {
      // User-only field; AI never writes here
      d[k] = typed[label.toLowerCase()] || '';
    } else {
      d[k] = typed[label.toLowerCase()] || ai[k] || '';
    }
  }

  // 地址兜底：AI 拿不到时查这个客人的历史预约
  let usedPreviousAddress = false;
  if (!d.address) {
    const prevBookings = await findAllBookings(env, cfg, psid);
    const prevWithAddr = prevBookings.find(e => e.location && e.startMs < Date.now());
    if (prevWithAddr) {
      d.address = normalizeAddress(prevWithAddr.location);
      usedPreviousAddress = true;
    }
  }

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

  const created = await saveNewBooking(ctx, { t, service: d.service, price: d.price, address: d.address, notes,
    veh_make: d.vehicle_make, veh_model: d.vehicle_model, veh_year: d.vehicle_year, veh_variant: d.vehicle_variant });
  if (!created) return;

  applyCustomLabel(psid, d.service, w.date, env);

  // 自动回复客人
  const noAddress = !d.address;
  const msg = customerMessage(d, w, env, env.CONFIRM_HEADER || 'Andy Auto AC Regas');
  let sent = null;
  if (!noAddress && env.AUTO_REPLY !== 'false') sent = await sendToCustomer(psid, msg, env);

  if (noAddress) {
    const template = customerMessage({ ...d, address: '[fill in]' }, w, env, env.CONFIRM_HEADER || 'Andy Auto AC Regas');
    const barkLines = [
      '⚠️ No address — confirmation NOT sent to customer.',
      '📅 Calendar added.',
      'Get the address, then send this manually:',
      '',
      '---',
      template,
    ];
    if (w.warning) barkLines.push(w.warning);
    if (created.overlaps.length) barkLines.push(overlapLine(created.overlaps).trim());
    await barkBooking(env, `📅 Booking added: ${name}`, barkLines.join('\n'), barkTimeLink(t.label, env), t.label);
    return;
  }

  const missing = ['service', 'price'].filter(k => !d[k]).map(k => CHAT_FIELDS.find(x => x[0] === k)[1]);
  const lines = [
    [t.label, d.service, d.price].filter(Boolean).join(' · '),
    d.address, d.mobile && `📱 ${d.mobile}`, d.vehicle && `🚗 ${d.vehicle}`, d.ai_notes && `📝 ${d.ai_notes}`,
  ].filter(Boolean);
  if (w.warning) lines.push(w.warning);
  if (created.overlaps.length) lines.push(overlapLine(created.overlaps).trim());
  if (missing.length) lines.push(`ℹ️ Not found in chat: ${missing.join(', ')}`);
  if (!sent) lines.push('ℹ️ Auto-reply is off, nothing was sent to the customer.');
  else if (sent.ok) lines.push('✉️ Confirmation sent to the customer.');
  else lines.push('', `⚠️ Confirmation NOT sent to the customer (${sent.error}). Please send it yourself:`, '', msg);
  const barkTitle = usedPreviousAddress ? `📅 Booking added: ${name} ⚠️ Verify address` : `📅 Booking added: ${name}`;
  await barkBooking(env, barkTitle, lines.join('\n'), barkTimeLink(t.label, env), t.label);
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
  const m = await (await fetch(`${graph}/${id}/messages?fields=message,from,created_time&limit=100&${token}`)).json();
  if (m.error || !m.data) throw serviceError(`Facebook: couldn't read the messages. ${JSON.stringify(m.error || m).slice(0, 200)}`);
  const since = Date.now() - 90 * 864e5;
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
- If a time is expressed as "around X" or "about X" and the customer accepts it, use X as the start time. "Around" means approximate, not unknown — still extract it.
- If a customer says "my address is" or "address is" and the actual address appears in the same or next message, use that as the service address.
- The business's own phone number appears in messages from Us. Never use it as the customer's mobile.
- Leave a field as "" if it was not mentioned. Do not guess or invent anything.
- notes: only info the technician needs on-site that is NOT captured in other fields — e.g. gate code, parking instructions, specific symptom, part needed. IMPORTANT EXCEPTION: if the customer is coming to Andy's location (not a mobile visit to the customer), always write "Customer coming to us". Do NOT include: customer name, service breakdown, price reasoning, "mobile service at home", "time customer accepted", or any AI reasoning. Leave "" if nothing genuinely useful.

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
        end: str('If the conversation mentions an arrival window (e.g. "around 3:30–4pm", "between 2 and 2:30"), return the window END time in HH:MM 24-hour format (e.g. "16:00"). This is used to show the customer a range in the confirmation. Leave "" if only a single arrival time is mentioned with no range.'),
        service: str('Service type in 1-3 words based on what was discussed, e.g. "Regas", "Pressure Test", "Leak Check". Keep it short and specific. No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        price: str('e.g. $150. No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        address: str('Service address — use the most complete address mentioned: street number + street name + suburb is preferred over suburb alone. If a full street address and a suburb are both mentioned, use the full address. Preserve unit/flat numbers exactly as written (e.g. "2/32a Smith St" must stay as "2/32a Smith St", not "2 Smith St"). Do not include postcode, state (QLD) or country (Australia). No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        mobile: str("Customer's mobile number. Leave \"\" if not mentioned."),
        vehicle: str('e.g. 2016 Toyota Camry. No explanatory notes or parenthetical comments. Leave "" if not mentioned.'),
        ai_notes: str('On-site info for the technician not captured elsewhere — e.g. gate code, parking, symptom, part needed. Leave "" if nothing genuinely useful. This fills a dedicated "AI notes" field in the Calendar description. Do NOT write anything that belongs to Andys own records (prices, quotes, reminders) — that is a separate field Andy controls.'),
      },
      required: ['date', 'start', 'end', 'service', 'price', 'address', 'mobile', 'vehicle', 'ai_notes'],
    },
  };

  let o;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.AI_MODEL || 'claude-sonnet-4-6',
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
  for (const k of ['service', 'price', 'address', 'mobile', 'vehicle', 'ai_notes']) res[k] = String(o[k] || '').trim();
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
  const clock = `${h % 12 || 12}${min ? ':' + pad(min) : ''}${h < 12 ? 'am' : 'pm'}`;
  let when = `${day}/${m} ${WD_LONG[dowOf({ y, m, d: day })]} ${clock}`;
  if (w.end) {
    let eh = w.end.h;
    if (eh * 60 + w.end.min <= h * 60 + min && eh < 12) eh += 12;
    const eclock = `${eh % 12 || 12}${w.end.min ? ':' + pad(w.end.min) : ''}${eh < 12 ? 'am' : 'pm'}`;
    when += ` – ${eclock}`;
  }
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
  const copyTime = (r.t || r.old)?.label || '';
  await barkBooking(env, r.title, r.lines.join('\n') + moreBookings(list), barkTimeLink(copyTime, ctx.env), copyTime);
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

  // 自动回复客人：只显示改动了的栏位
  const when = r.t
    ? { date: r.w.date, start: r.w.start }
    : { date: { y: old.y, m: old.m, d: old.d }, start: { h: old.h, min: old.min } };
  const updateLines = [];
  for (const l of fields) {
    const k = fieldLabel(l).toLowerCase();
    if (k === 'time') {
      const { y, m, d: day } = when.date;
      const { h, min } = when.start;
      const clock = `${h % 12 || 12}:${pad(min)}${h < 12 ? 'am' : 'pm'}`;
      updateLines.push(`Time updated: ${WD_LONG[dowOf({ y, m, d: day })]} ${day}/${m}, ${clock}`);
    } else {
      const label = fieldLabel(l);
      const val = l.slice(l.search(/[:：]/) + 1).trim();
      updateLines.push(`${label} updated: ${val}`);
    }
  }
  updateLines.push('See you then!');
  const msg = updateLines.join('\n');
  let sent = null;
  if (env.AUTO_REPLY !== 'false') sent = await sendToCustomer(psid, msg, env);

  const lines = [...r.lines, ...fields.filter(l => !/^time:/i.test(l)).map(l => `• ${l}`)];
  if (!sent) lines.push('ℹ️ Auto-reply is off, nothing was sent to the customer.');
  else if (sent.ok) lines.push('✉️ Updated details sent to the customer.');
  else lines.push('', `⚠️ Updated details NOT sent to the customer (${sent.error}). Please send it yourself:`, '', msg);
  const copyTime2 = (r.t || r.old)?.label || '';
  await barkBooking(env, r.title, lines.join('\n') + moreBookings(list), barkTimeLink(copyTime2, ctx.env), copyTime2);
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
  await barkBooking(env, `❌ Booking cancelled: ${name}`, [p.label, target.service].filter(Boolean).join(' · ') + more, link);
}

async function notFound(env, name, link, hint) {
  const when = hint ? ` on ${WD_SHORT[dowOf(hint)]} ${hint.d}/${hint.m}` : '';
  await barkBooking(env, `⚠️ Booking not found: ${name}`,
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
    await barkBooking(env, '📅 Tomorrow: No bookings', '', '');
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
  await barkBooking(env, `📅 Tomorrow: ${bookings.length} APPOINTMENT${bookings.length > 1 ? 'S' : ''}`, blocks.join('\n───\n'), printUrl);
}

function buildReminderMessage(e, cfg, env) {
  const p = localParts(e.startMs, cfg.tz);
  const clock = `${p.h % 12 || 12}${p.min ? ':' + pad(p.min) : ''}${p.h < 12 ? 'am' : 'pm'}`;
  const when = `${p.d}/${p.m} ${WD_LONG[dowOf(p)]} ${clock}`;
  const lines = ['Hi! Just a reminder of your booking tomorrow with Andy Auto AC Regas:'];
  lines.push(`Time: ${when}`);
  lines.push('See you then!');
  return lines.join('\n');
}

// Normalize a free-form address: strip state/country/postcode suffixes and
// move misplaced unit/flat numbers from the tail back to the head where they
// belong. Safe to apply multiple times (idempotent).
const ADDR_STATE_RE = /[,\s]+(qld|queensland|nsw|new south wales|vic|victoria|wa|western australia|sa|south australia|tas|tasmania|nt|northern territory|act|australian capital territory)\b/gi;
const ADDR_COUNTRY_RE = /[,\s]+australia\b/gi;
const ADDR_POSTCODE_RE = /[,\s]+\b\d{4}\b(?=[,\s]*$)/;
const UNIT_SEG_RE = /^(unit|u|apt|apartment|flat|suite)\s*\.?\s*([\w\/-]+)$/i;

function normalizeAddress(addr) {
  if (!addr) return '';
  let s = String(addr).trim();
  s = s.replace(ADDR_COUNTRY_RE, '');
  s = s.replace(ADDR_STATE_RE, '');
  s = s.replace(ADDR_POSTCODE_RE, '');
  // Collapse dangling commas and extra whitespace left after stripping
  s = s.replace(/\s*,\s*,+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+/g, ' ');
  // Move misplaced trailing "Unit X" / "Apt X" to the front — legacy data
  // like "10 Holmead Rd, Eight Mile Plains, Unit 84" becomes "Unit 84, 10
  // Holmead Rd, Eight Mile Plains".
  const segs = s.split(',').map(x => x.trim()).filter(Boolean);
  if (segs.length >= 2 && UNIT_SEG_RE.test(segs[segs.length - 1])) {
    const unit = segs.pop();
    segs.unshift(unit);
    s = segs.join(', ');
  }
  return s;
}

// Split a free-form address into { street, suburb } for two-line print display.
// Works off the last comma, else falls back to the last street-suffix word
// (Road/St/Ave/etc). If neither heuristic matches, returns the address whole.
const STREET_SUFFIX_RE = /^(road|rd|street|st|avenue|ave|drive|dr|lane|ln|court|ct|place|pl|way|highway|hwy|crescent|cres|cr|terrace|tce|close|cl|parade|pde|boulevard|blvd|boulevarde|circuit|cct|esplanade|esp|grove|grv|gr|square|sq|parkway|pkwy|mews|link|rise|quay|bay)[,.]?$/i;
function splitAddress(addr) {
  const s = normalizeAddress(addr);
  if (!s) return { street: '', suburb: '' };
  const commaIdx = s.lastIndexOf(',');
  if (commaIdx > 0) {
    return { street: s.slice(0, commaIdx).trim(), suburb: s.slice(commaIdx + 1).trim() };
  }
  const parts = s.split(/\s+/);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (STREET_SUFFIX_RE.test(parts[i])) {
      return { street: parts.slice(0, i + 1).join(' '), suburb: parts.slice(i + 1).join(' ') };
    }
  }
  return { street: s, suburb: '' };
}

function parseSummaryFields(summary) {
  const hasName = /\s*–\s*.+$/.test(summary);
  // Strip customer name (system format: "Service $Price – Name")
  const s = hasName ? summary.replace(/\s*–\s*.+$/, '').trim() : summary;
  const priceMatch = s.match(/\$[\d,]+/);
  const price = priceMatch ? priceMatch[0] : '';
  const withoutPrice = s.replace(/\$[\d,]+/, '').trim();
  if (!hasName) {
    // Free-form manual entry — use the whole title (minus price) as the service
    // so edits like "Repair Philip crv" show verbatim instead of being reduced
    // to a single matched keyword.
    return { service: withoutPrice, price, vehicle: '' };
  }
  // System format — split service from vehicle: vehicle usually starts with a 4-digit year
  const yearIdx = withoutPrice.search(/\b(19|20)\d{2}\b/);
  let service = '', vehicle = '';
  if (yearIdx > 0) {
    service = withoutPrice.slice(0, yearIdx).trim();
    vehicle = withoutPrice.slice(yearIdx).trim();
  } else {
    // No year found — treat the whole remainder as service. Vehicle lives in
    // the description field; splitting on first space here would corrupt
    // multi-word services like "Change O-ring, replace valves and regas".
    service = withoutPrice;
    vehicle = '';
  }
  return { service, price, vehicle };
}

async function printPage(env, origin, dateParam = '') {
  const cfg = config(env);
  const today = todayInTz(cfg.tz);
  if (!dateParam) {
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: cfg.tz }));
    dateParam = nowInTz.getHours() < 16 ? 'today' : '';
  }
  let target;
  const p = dateParam.toLowerCase();
  if (p === 'today') {
    target = { y: today.y, m: today.m, d: today.d };
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const [y, m, d] = dateParam.split('-').map(Number);
    target = { y, m, d };
  } else {
    const tom = new Date(today.y, today.m - 1, today.d + 1);
    target = { y: tom.getFullYear(), m: tom.getMonth() + 1, d: tom.getDate() };
  }
  const bookings = await findTomorrowBookings(env, cfg, { target });
  const targetDate = new Date(target.y, target.m - 1, target.d);
  const dateStr = `${WD_LONG[targetDate.getDay()]} ${target.d}/${target.m}/${target.y}`;
  const isToday = target.y === today.y && target.m === today.m && target.d === today.d;
  const tom = new Date(today.y, today.m - 1, today.d + 1);
  const isTomorrow = target.y === tom.getFullYear() && target.m === tom.getMonth() + 1 && target.d === tom.getDate();
  const targetIso = `${target.y}-${pad(target.m)}-${pad(target.d)}`;

  const services = [];
  const priceTotals = [];
  const bookingData = [];  // mirror of row data for JS modal
  const rows = (await Promise.all(bookings.map(async (e, i) => {
    const p = localParts(e.startMs, cfg.tz);
    const clock = `${p.h % 12 || 12}:${pad(p.min)}${p.h < 12 ? 'am' : 'pm'}`;
    const desc = e.description || '';
    const isSms = !e.psid;
    const summaryParsed = parseSummaryFields(e.summary || '');
    const descService = desc.match(/^Service:\s*(.+)$/im)?.[1]?.trim() || '';
    let service = summaryParsed.service || descService || e.service || '';
    let price = summaryParsed.price || e.price || '';
    let vehicle = desc.match(/^Vehicle:\s*(.+)$/im)?.[1]?.trim() || summaryParsed.vehicle || e.vehicle || '';
    services.push(service);
    const priceNum = parseInt(String(price).replace(/[^\d]/g, ''), 10);
    if (priceNum > 0) priceTotals.push(priceNum);
    const mobile = desc.match(/^Mobile:\s*(.+)$/im)?.[1]?.trim() || '';
    // Two separate notes fields in the Calendar description:
    //   "AI notes: ..." = extracted by AI from the conversation (customer context)
    //   "Notes: ..."    = Andy's own records (quotes, follow-up, reminders)
    // Anchor the AI notes regex first because "Notes:" would otherwise also
    // match it by case-insensitive greedy prefix.
    const aiNotes = desc.match(/^AI notes:\s*(.+)$/im)?.[1]?.trim() || '';
    // Strip the "AI notes:" line before matching the user's Notes line so
    // the loose "Notes:" regex doesn't accidentally grab the AI line.
    const descNoUniAi = desc.replace(/^AI notes:.*$/gim, '');
    const userNotes = descNoUniAi.match(/^Notes:\s*(.+)$/im)?.[1]?.trim() || '';
    const srcClass = isSms ? 'badge-sms' : 'badge-fb';
    const srcLabel = isSms ? 'SMS' : 'FB';
    const addr = splitAddress(e.location || '');
    const addrHtml = addr.suburb
      ? `<span class="addr-street">${addr.street}</span><span class="addr-suburb">${addr.suburb}</span>`
      : `<span class="addr-street">${addr.street}</span>`;
    let name = (e.name || '').trim();
    const digits = s => (s || '').replace(/[^\d]/g, '');
    const nameIsPhone = name && digits(name) && digits(name) === digits(mobile);
    const nameIsEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name);
    let whoHtml;
    if (nameIsPhone) {
      whoHtml = `<span class="who-mobile-only">${mobile}</span>`;
    } else if (nameIsEmail) {
      whoHtml = `<span class="who-mobile-only">${name}</span>${mobile ? `<span class="who-mobile">${mobile}</span>` : ''}`;
    } else if (name && mobile) {
      whoHtml = `<span class="who-name">${name}</span><span class="who-mobile">${mobile}</span>`;
    } else if (name) {
      whoHtml = `<span class="who-name">${name}</span>`;
    } else if (mobile) {
      whoHtml = `<span class="who-mobile-only">${mobile}</span>`;
    } else {
      whoHtml = '';
    }
    bookingData.push({
      uid: e.uid || '',
      psid: e.psid || '',
      phone: mobile || '',
      name: nameIsPhone || nameIsEmail ? '' : name,
      service, price, vehicle,
      address: e.location || '',
      mobile,
      ai_notes: aiNotes,
      notes: userNotes,
      quoted_cents: priceNum > 0 ? priceNum * 100 : 0,
      time: clock,
    });
    // Suggested gas from vehicles DB (only when AI tagged structured fields)
    const gasSug = await suggestGasFor(env, {
      make: e.veh_make, model: e.veh_model, year: e.veh_year, variant: e.veh_variant,
    });
    // Show user notes (📌) and AI notes (🤖) stacked under the service.
    // Print stylesheet hides the 🤖 line to keep paper compact.
    const notesHtml = [];
    if (userNotes) notesHtml.push(`<div class="svc-notes user-note">📌 ${userNotes}</div>`);
    if (aiNotes) notesHtml.push(`<div class="svc-notes ai-note">🤖 ${aiNotes}</div>`);
    const serviceCell = `${service}${notesHtml.join('')}`;
    return `<tr data-idx="${i}" onclick="openBookingModal(${i})">
      <td class="n">${i + 1}</td>
      <td class="src"><span class="${srcClass}">${srcLabel}</span></td>
      <td class="time">${clock}</td>
      <td class="svc">${serviceCell}</td>
      <td class="price">${price}</td>
      <td class="veh">${vehicle}</td>
      <td class="gas">${gasSug}</td>
      <td class="addr">${addr.street || addr.suburb ? addrHtml : ''}</td>
      <td class="who">${whoHtml}</td>
      <td class="mark" id="mark-${i}"></td>
    </tr>`;
  }))).join('');

  const needsFullKit = services.some(s => /pressure/i.test(s));
  const equipmentBanner = needsFullKit
    ? `<div class="equipment">⚠️ 全副武装 — pressure test equipment required today</div>` : '';

  const empty = bookings.length === 0
    ? `<p class="empty">No bookings for ${isToday ? 'today' : isTomorrow ? 'tomorrow' : dateStr}.</p>` : '';

  const quotedTotal = priceTotals.reduce((a, b) => a + b, 0);
  // Collected / Cash / PayID / Unpaid totals come from client-side JS once
  // bookings_meta is loaded. Here we only render a placeholder.
  const summaryBits = [`${bookings.length} booking${bookings.length !== 1 ? 's' : ''}`];
  if (quotedTotal > 0) summaryBits.push(`Quoted $${quotedTotal.toLocaleString()}`);
  const summaryLine = summaryBits.join(' · ');

  const tableHtml = bookings.length === 0 ? '' : `
  <table>
    <thead><tr>
      <th class="col-n">#</th><th class="col-src">Src</th><th class="col-time">Time</th>
      <th>Service</th><th>Price</th><th>Vehicle</th><th class="col-gas">Gas</th><th>Address</th><th>Customer</th>
      <th class="col-mark">Mark</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="collected-line" id="collected-line"></div>`;

  // Load any daily notes Andy has written for this date (persisted in KV).
  const noteKey = `note:${targetIso}`;
  const noteText = env.BARK_COOLDOWN ? (await env.BARK_COOLDOWN.get(noteKey) || '') : '';
  const htmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noteTextEsc = htmlEsc(noteText);

  const secret = encodeURIComponent(env.VERIFY_TOKEN || '');
  const baseUrl = `${origin}/print?secret=${secret}`;
  const todayUrl = `${baseUrl}&date=today`;
  const tomorrowUrl = `${baseUrl}&date=tomorrow`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Andy Auto – ${dateStr}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 24px 32px; color: #111; }
  h1 { font-size: 1.15em; margin-bottom: 2px; }
  h2 { font-size: 0.95em; color: #555; margin-top: 0; font-weight: normal; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th { background: #222; color: #fff; padding: 7px 10px; text-align: left; font-weight: normal; white-space: nowrap; }
  th.col-n { width: 14px; padding-left: 10px; padding-right: 4px; text-align: left; }
  th.col-src { width: 26px; padding-left: 2px; padding-right: 2px; }
  th.col-time { width: 64px; }
  td { padding: 9px 10px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
  td.n { color: #aaa; width: 14px; font-size: 0.75em; padding: 9px 4px 9px 10px; text-align: left; }
  td.src { padding: 9px 2px; width: 26px; text-align: center; }
  /* Grayscale-friendly: SMS is a filled black pill, FB is an outlined one.
     Distinct on a B&W printer without relying on color. */
  .badge-fb, .badge-sms { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 0.65em; font-weight: bold; letter-spacing: 0.2px; line-height: 1.3; }
  .badge-sms { background: #111; color: #fff; }
  .badge-fb { background: #fff; color: #111; border: 1px solid #111; padding: 0 4px; }
  td.time { white-space: nowrap; font-weight: bold; font-size: 1.05em; }
  td.svc { max-width: 210px; word-break: break-word; }
  td.svc .svc-notes { font-size: 0.82em; margin-top: 3px; line-height: 1.25; }
  td.svc .user-note { color: #333; font-weight: 500; }   /* 📌 Andy's own records — more prominent */
  td.svc .ai-note   { color: #888; font-style: italic; } /* 🤖 AI-extracted context — dim */
  @media print {
    td.svc .ai-note { display: none; }                   /* print only user notes to save space */
  }
  td.price { white-space: nowrap; }
  td.veh  { max-width: 170px; word-break: break-word; }
  td.addr { max-width: 260px; word-break: break-word; line-height: 1.3; }
  td.addr .addr-street { display: block; color: #333; }
  td.addr .addr-suburb { display: block; color: #111; font-weight: bold; }
  td.who { max-width: 130px; line-height: 1.3; word-break: break-word; }
  td.who .who-name { display: block; font-weight: bold; }
  td.who .who-mobile { display: block; color: #555; font-size: 0.9em; }
  td.who .who-mobile-only { display: block; color: #111; }
  /* Mark column (post-service status badge) */
  th.col-mark { width: 100px; }
  th.col-gas { width: 70px; }
  td.gas { white-space: nowrap; color: #060; font-size: 0.9em; }
  td.mark { white-space: nowrap; font-size: 0.85em; text-align: right; }
  td.mark .badge-done   { display: inline-block; padding: 2px 6px; border-radius: 3px; background: #efe; color: #060; border: 1px solid #9c9; font-weight: bold; }
  td.mark .badge-partial{ display: inline-block; padding: 2px 6px; border-radius: 3px; background: #fef3dc; color: #7a4a00; border: 1px solid #e0a040; font-weight: bold; }
  td.mark .badge-noshow { display: inline-block; padding: 2px 6px; border-radius: 3px; background: #fee; color: #a00; border: 1px solid #f99; font-weight: bold; }
  td.mark .badge-cancel { display: inline-block; padding: 2px 6px; border-radius: 3px; background: #eee; color: #666; border: 1px solid #ccc; font-weight: bold; }
  td.mark .pay-cash  { color: #060; font-weight: normal; }
  td.mark .pay-payid { color: #025; font-weight: normal; }
  td.mark .pay-unpaid { color: #a00; font-weight: bold; }
  tr { cursor: pointer; }
  tr:hover { background: #f8f8f8 !important; }
  .collected-line { margin-top: 10px; padding: 8px 12px; background: #f5f5f5; border-radius: 6px; font-size: 0.9em; font-weight: bold; color: #333; }
  .collected-line .pay-unpaid { color: #a00; }
  @media print {
    .collected-line { background: transparent; padding: 4px 0; border-top: 1px solid #000; margin-top: 10px; }
    tr { cursor: auto; }
    /* Mark column is for in-app tracking, not useful on paper */
    th.col-mark, td.mark { display: none; }
  }
  .empty { color: #888; font-style: italic; }
  .toggle { display: flex; gap: 6px; margin-bottom: 14px; align-items: center; flex-wrap: nowrap; overflow-x: hidden; }
  .toggle a { padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 0.85em; border: 1px solid #bbb; color: #333; background: #f5f5f5; white-space: nowrap; }
  .toggle a.active { background: #222; color: #fff; border-color: #222; }
  .toggle input[type=date] { padding: 5px 6px; border-radius: 6px; border: 1px solid #bbb; font-size: 0.85em; color: #333; min-width: 0; width: 120px; }
  .toggle .other-label { font-size: 0.85em; color: #555; white-space: nowrap; }
  .equipment { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 10px 16px; margin-bottom: 14px; font-weight: bold; font-size: 0.95em; }
  .notes-box { border: 1px solid #ddd; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; background: #fafafa; }
  .notes-label { font-size: 0.78em; color: #777; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .notes-label .notes-status { font-size: 0.9em; color: #999; margin-left: auto; }
  .notes-input { width: 100%; min-height: 50px; border: none; background: transparent; resize: vertical; font-family: inherit; font-size: 0.95em; color: #111; outline: none; line-height: 1.4; box-sizing: border-box; padding: 0; }
  .notes-input::placeholder { color: #bbb; }
  .notes-print { white-space: pre-wrap; font-size: 1em; line-height: 1.5; }
  @media print {
    .notes-box { background: transparent; border: 1px solid #999; page-break-inside: avoid; }
    .notes-box.notes-empty { display: none; }
    .notes-input { display: none; }
    .notes-label .notes-status { display: none; }
  }
  @media screen { .notes-print { display: none; } }
  .print-btn { padding: 6px 18px; border-radius: 6px; font-size: 0.9em; border: 1px solid #2a7a2a; color: #fff; background: #2a7a2a; cursor: pointer; white-space: nowrap; margin-left: auto; }
  .print-btn:hover { background: #1e5c1e; }
  @media (max-width: 520px) {
    .toggle { gap: 3px; }
    .toggle a { padding: 4px 5px; font-size: 0.72em; }
    .toggle .other-label { font-size: 0.72em; }
    .toggle input[type=date] { width: 72px; font-size: 0.72em; padding: 4px 3px; }
    .print-btn { padding: 4px 7px; font-size: 0.72em; margin-left: auto; }
  }
  @media (max-width: 600px) {
    h2 { font-size: 3.2vw; white-space: nowrap; }
    table { zoom: 0.4; }
  }
  #print-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:999; align-items:center; justify-content:center; }
  #print-modal.open { display:flex; }
  #print-modal-box { background:#fff; border-radius:12px; padding:24px 28px; max-width:320px; width:90%; text-align:center; }
  #print-modal-box .modal-date { font-size:1.25em; font-weight:bold; margin:8px 0 4px; }
  #print-modal-box .modal-count { color:#555; margin-bottom:20px; }
  #print-modal-box .modal-hint { font-size:0.8em; color:#888; margin-bottom:20px; }
  #print-modal-box .modal-btns { display:flex; gap:10px; justify-content:center; }
  #print-modal-box .modal-btns button { padding:9px 22px; border-radius:8px; border:none; font-size:1em; cursor:pointer; }
  #print-modal-box .modal-btns .btn-print { background:#2a7a2a; color:#fff; }
  #print-modal-box .modal-btns .btn-cancel { background:#eee; color:#333; }
  /* Booking edit/mark modal */
  #booking-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:999; align-items:center; justify-content:center; }
  #booking-modal.open { display:flex; }
  #booking-modal-box { background:#fff; border-radius:12px; padding:18px 20px; width:92%; max-width: 480px; max-height: 92vh; overflow-y: auto; }
  #booking-modal-box .bm-header { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  #booking-modal-box .bm-title { font-weight:bold; font-size:1em; flex:1; color:#111; }
  #booking-modal-box .bm-close { border:none; background:none; font-size:1.3em; cursor:pointer; color:#888; padding:0 4px; }
  #booking-modal-box .bm-tabs { display:flex; gap:4px; border-bottom:1px solid #ddd; margin-bottom:12px; }
  #booking-modal-box .bm-tab { padding:8px 12px; cursor:pointer; border:none; background:none; font-size:0.9em; color:#666; border-bottom:2px solid transparent; }
  #booking-modal-box .bm-tab.active { color:#111; border-bottom-color:#2a7a2a; font-weight:bold; }
  #booking-modal-box .bm-panel { display:none; }
  #booking-modal-box .bm-panel.active { display:block; }
  #booking-modal-box .bm-group { margin-bottom: 14px; }
  #booking-modal-box .bm-group label { display:block; font-size:0.78em; color:#666; margin-bottom:4px; }
  #booking-modal-box .bm-group input, #booking-modal-box .bm-group textarea { width:100%; padding:7px 9px; border:1px solid #ccc; border-radius:5px; font-size:0.95em; font-family:inherit; box-sizing:border-box; }
  #booking-modal-box .bm-group textarea { min-height: 50px; resize: vertical; }
  #booking-modal-box .amt-wrap { display:flex; gap:4px; align-items:stretch; }
  #booking-modal-box .amt-wrap input { flex:1; }
  #booking-modal-box .amt-wrap .sign-btn { flex:0 0 36px; border:1px solid #bbb; background:#fafafa; cursor:pointer; border-radius:5px; font-size:1.1em; font-weight:bold; color:#555; padding:0; }
  #booking-modal-box .amt-wrap .sign-btn:hover { background:#efefef; }
  #booking-modal-box .amt-wrap .sign-btn:active { background:#222; color:#fff; }
  #booking-modal-box .bm-row { display:flex; gap:8px; margin-bottom:14px; }
  #booking-modal-box .bm-row > div { flex:1; }
  #booking-modal-box .bm-group-btns { display:flex; gap:6px; flex-wrap:wrap; }
  #booking-modal-box .bm-group-btns button { padding:8px 12px; border:1px solid #ccc; border-radius:6px; background:#fff; cursor:pointer; font-size:0.9em; flex:1; min-width: 70px; }
  #booking-modal-box .bm-group-btns button.selected { background:#2a7a2a; color:#fff; border-color:#2a7a2a; font-weight:bold; }
  #booking-modal-box .bm-actions { display:flex; gap:8px; justify-content:space-between; margin-top:16px; padding-top:14px; border-top:1px solid #eee; }
  #booking-modal-box .bm-actions .btn-save { background:#2a7a2a; color:#fff; border:none; padding:10px 22px; border-radius:6px; font-size:0.95em; cursor:pointer; font-weight:bold; }
  #booking-modal-box .bm-actions .btn-cancel { background:#eee; color:#333; border:none; padding:10px 18px; border-radius:6px; font-size:0.95em; cursor:pointer; }
  #booking-modal-box .bm-actions .btn-clear { background:transparent; color:#a00; border:1px solid #f99; padding:10px 14px; border-radius:6px; font-size:0.85em; cursor:pointer; }
  #booking-modal-box .bm-status { font-size:0.8em; color:#888; margin-left: 8px; }
  @media print { #booking-modal { display: none !important; } }
  @media print {
    .toggle { display: none; }
    .print-btn { display: none; }
    #print-modal { display: none !important; }
    table { zoom: 1; font-size: 0.94em; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    /* Row rhythm sized so 9 bookings still fit on a single A4 landscape
       page while keeping the body text comfortable to read in the van. */
    th { padding: 5px 9px; }
    td { padding: 5px 9px; }
    td.n { padding: 5px 4px 5px 9px; font-size: 0.85em; }
    td.src { padding: 5px 2px; }
    td.time { font-size: 1em; }
    td.addr, td.who { line-height: 1.25; }
    h1 { font-size: 1.25em; margin-bottom: 2px; }
    h2 { font-size: 1em; margin-bottom: 12px; }
    .notes-box { padding: 7px 12px; margin-bottom: 12px; }
    .notes-label { font-size: 0.86em; margin-bottom: 3px; }
    .notes-print { font-size: 1.05em; line-height: 1.45; }
    .equipment { padding: 7px 14px; margin-bottom: 10px; font-size: 1em; }
    /* Over 9 bookings: start a new page at row 10 instead of silently
       clipping the overflow. Only the 10th row forces a break; subsequent
       rows flow naturally. */
    tbody tr:nth-child(10) { page-break-before: always; }
    @page { size: A4 landscape; margin: 10mm; }
    body { margin: 0; }
    th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
<script>
function confirmPrint() {
  document.getElementById('print-modal').classList.add('open');
}
function doPrint() {
  window.print();
  document.getElementById('print-modal').classList.remove('open');
}
function cancelPrint() {
  document.getElementById('print-modal').classList.remove('open');
}
let notesTimer = null;
function onNotesInput(e) {
  const status = document.getElementById('notes-status');
  const printView = document.getElementById('notes-print');
  const box = e.target.closest('.notes-box');
  if (printView) printView.textContent = e.target.value;
  if (box) box.classList.toggle('notes-empty', !e.target.value.trim());
  if (status) status.textContent = 'saving…';
  clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => {
    try {
      await fetch(window.NOTES_URL, { method: 'POST', body: e.target.value });
      if (status) { status.textContent = 'saved'; setTimeout(() => { if (status.textContent === 'saved') status.textContent = ''; }, 1500); }
    } catch {
      if (status) status.textContent = 'save failed';
    }
  }, 600);
}

// ========== Booking modal: mark (status/pay/amount) + edit details ==========
window.BOOKINGS = []; // injected per-page
window.META = {};     // { uid → meta row }
let currentIdx = -1;

function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtMoney(cents) { return '\$' + (cents/100).toFixed(2); }
function paymentLabel(method) { return ({cash:'Cash', payid:'PayID', mixed:'Mixed', unpaid:'Unpaid'})[method] || ''; }

async function loadMeta() {
  try {
    const r = await fetch(window.META_URL);
    const data = await r.json();
    window.META = data.meta || {};
    renderAllBadges();
    renderCollectedLine();
  } catch (e) {
    console.error('loadMeta failed', e);
  }
}

function renderAllBadges() {
  for (let i = 0; i < (window.BOOKINGS || []).length; i++) renderBadge(i);
}

function renderBadge(idx) {
  const b = window.BOOKINGS[idx];
  const cell = document.getElementById('mark-' + idx);
  if (!cell) return;
  const m = window.META[b.uid];
  if (!m || !m.status) { cell.innerHTML = ''; return; }
  const statusMap = { done: ['badge-done', '✓'], partial: ['badge-partial', '◐'], no_show: ['badge-noshow', '✗'], cancelled: ['badge-cancel', '—'] };
  const [cls, icon] = statusMap[m.status] || ['badge-cancel', '?'];
  const money = (m.actual_amount != null) ? fmtMoney(m.actual_amount) : '';
  const method = m.payment_method ? \`<span class="pay-\${m.payment_method}">\${paymentLabel(m.payment_method)}</span>\` : '';
  cell.innerHTML = \`<span class="\${cls}">\${icon} \${money}</span>\${method ? ' · ' + method : ''}\`;
}

function renderCollectedLine() {
  const line = document.getElementById('collected-line');
  if (!line || !window.BOOKINGS.length) { if (line) line.textContent = ''; return; }
  let collected = 0, cash = 0, payid = 0, unpaid = 0;
  let unpaidCount = 0, markedCount = 0;
  for (const b of window.BOOKINGS) {
    const m = window.META[b.uid];
    if (!m || !m.status) continue;
    markedCount++;
    const amt = m.actual_amount || 0;
    if (m.status === 'done' || m.status === 'partial') collected += amt;
    if (m.payment_method === 'cash') cash += amt;
    else if (m.payment_method === 'payid') payid += amt;
    else if (m.payment_method === 'mixed') {
      cash += (m.cash_portion || 0);
      payid += (m.payid_portion || 0);
    }
    else if (m.payment_method === 'unpaid') { unpaid += amt; unpaidCount++; }
  }
  if (!markedCount) { line.textContent = ''; return; }
  const bits = [\`<strong>Collected \${fmtMoney(collected)}</strong>\`];
  if (cash) bits.push(\`Cash \${fmtMoney(cash)}\`);
  if (payid) bits.push(\`PayID \${fmtMoney(payid)}\`);
  if (unpaid) bits.push(\`<span class="pay-unpaid">Unpaid \${fmtMoney(unpaid)} (\${unpaidCount})</span>\`);
  line.innerHTML = bits.join(' · ');
}

function openBookingModal(idx) {
  currentIdx = idx;
  const b = window.BOOKINGS[idx];
  const m = window.META[b.uid] || {};
  const titleBits = [b.time, b.price].filter(Boolean);
  document.getElementById('bm-title').textContent = titleBits.length ? titleBits.join(' · ') : 'Booking';
  switchTab('mark');

  const fmt = fmtCents;
  // No pre-selection on a fresh booking — the user clicks a Status or
  // Payment button to trigger the Done/Cash defaults. This lets Andy
  // open the modal just to edit Details without creating a stray mark.
  highlightBtnGroup('bm-status', m.status || null);
  highlightBtnGroup('bm-method', m.payment_method || null);
  const amt = m.actual_amount != null ? fmt(m.actual_amount) : (b.quoted_cents ? fmt(b.quoted_cents) : '');
  document.getElementById('bm-amount').value = amt;
  document.getElementById('bm-cash-portion').value = m.cash_portion != null ? fmt(m.cash_portion) : '';
  document.getElementById('bm-payid-portion').value = m.payid_portion != null ? fmt(m.payid_portion) : '';
  togglePaymentFields(m.payment_method || 'cash');
  document.getElementById('bm-clear').style.display = m.status ? '' : 'none';

  // Prefill Details tab
  document.getElementById('bm-service').value = b.service || '';
  document.getElementById('bm-price').value = b.price || '';
  document.getElementById('bm-vehicle').value = b.vehicle || '';
  document.getElementById('bm-address').value = b.address || '';
  document.getElementById('bm-name').value = b.name || '';
  document.getElementById('bm-mobile').value = b.mobile || '';
  // 📌 user notes shown on both tabs — same underlying value, synced on input
  document.getElementById('bm-event-notes').value = b.notes || '';
  document.getElementById('bm-event-notes-mark').value = b.notes || '';
  // 🤖 AI notes only on Details tab
  document.getElementById('bm-ai-notes').value = b.ai_notes || '';

  document.getElementById('bm-status-msg').textContent = '';
  document.getElementById('booking-modal').classList.add('open');
}

function closeBookingModal() {
  document.getElementById('booking-modal').classList.remove('open');
  currentIdx = -1;
}

function switchTab(name) {
  for (const t of document.querySelectorAll('#booking-modal .bm-tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('#booking-modal .bm-panel')) p.classList.toggle('active', p.dataset.tab === name);
}

function highlightBtnGroup(groupId, value) {
  for (const b of document.querySelectorAll('#' + groupId + ' button')) {
    b.classList.toggle('selected', b.dataset.value === value);
  }
}

function fmtCents(cents) {
  const d = cents / 100;
  return d % 1 === 0 ? String(d) : d.toFixed(2);
}

function selectInGroup(groupId, value) {
  // Toggle: clicking the already-selected button deselects it.
  const current = getSelectedInGroup(groupId);
  if (current === value) {
    highlightBtnGroup(groupId, null);
    if (groupId === 'bm-method') togglePaymentFields('cash');
    return;
  }
  highlightBtnGroup(groupId, value);
  if (groupId === 'bm-method') togglePaymentFields(value);
  if (groupId === 'bm-status') {
    const amt = document.getElementById('bm-amount');
    if (value === 'no_show' || value === 'cancelled') {
      amt.value = '0';
    } else if (value === 'done' || value === 'partial') {
      // Restore quoted amount when switching from no-show/cancel back
      if (amt.value === '0' || amt.value === '') {
        const b = window.BOOKINGS[currentIdx];
        if (b && b.quoted_cents) amt.value = fmtCents(b.quoted_cents);
      }
    }
    // First Status click → also default Payment to Cash so a single tap
    // commits the common "job done, cash collected" case.
    if (!getSelectedInGroup('bm-method') && value !== null) {
      highlightBtnGroup('bm-method', 'cash');
      togglePaymentFields('cash');
    }
  }
  if (groupId === 'bm-method' && !getSelectedInGroup('bm-status') && value !== null) {
    // First Payment click → also default Status to Done
    highlightBtnGroup('bm-status', 'done');
    const amt = document.getElementById('bm-amount');
    const b = window.BOOKINGS[currentIdx];
    if ((amt.value === '0' || amt.value === '') && b && b.quoted_cents) {
      amt.value = fmtCents(b.quoted_cents);
    }
  }
}

function togglePaymentFields(method) {
  const single = document.getElementById('bm-amount-group');
  const mixed = document.getElementById('bm-mixed-group');
  if (method === 'mixed') {
    single.style.display = 'none';
    mixed.style.display = '';
    updateMixedTotal();
  } else {
    single.style.display = '';
    mixed.style.display = 'none';
  }
}

// iOS numeric keyboards hide the minus sign — this toggle flips the current
// value so Andy can enter refunds/change without a desktop keyboard.
function flipSign(id, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = (el.value || '').trim();
  if (v === '' || v === '0') { el.value = v; }
  else if (v.startsWith('-')) el.value = v.slice(1);
  else el.value = '-' + v;
  if (typeof cb === 'function') cb();
}

function updateMixedTotal() {
  const c = parseFloat(document.getElementById('bm-cash-portion').value) || 0;
  const p = parseFloat(document.getElementById('bm-payid-portion').value) || 0;
  const total = c + p;
  const el = document.getElementById('bm-mixed-total');
  if (el) el.textContent = total > 0 ? 'Total: \$' + total.toFixed(2) : '';
}

function getSelectedInGroup(groupId) {
  const sel = document.querySelector('#' + groupId + ' button.selected');
  return sel ? sel.dataset.value : null;
}

// The notes textarea is shown on both tabs; keep them in sync so editing
// either one commits to the single Calendar description notes line.
function syncNotes(source) {
  const markEl = document.getElementById('bm-event-notes-mark');
  const detailsEl = document.getElementById('bm-event-notes');
  if (source === 'mark') detailsEl.value = markEl.value;
  else markEl.value = detailsEl.value;
}

async function saveBookingModal() {
  if (currentIdx < 0) return;
  const b = window.BOOKINGS[currentIdx];
  const status = document.getElementById('bm-status-msg');
  status.textContent = 'saving…';
  try {
    // 1) Save Details tab (if any field changed from the original)
    const detailsBody = {};
    const fieldMap = { service:'bm-service', price:'bm-price', vehicle:'bm-vehicle', address:'bm-address', name:'bm-name', mobile:'bm-mobile', notes:'bm-event-notes', ai_notes:'bm-ai-notes' };
    const originalMap = { service:b.service, price:b.price, vehicle:b.vehicle, address:b.address, name:b.name, mobile:b.mobile, notes:b.notes, ai_notes:b.ai_notes };
    let detailsChanged = false;
    for (const [field, inputId] of Object.entries(fieldMap)) {
      const newVal = (document.getElementById(inputId).value || '').trim();
      const oldVal = (originalMap[field] || '').trim();
      if (newVal !== oldVal) { detailsBody[field] = newVal; detailsChanged = true; }
    }
    if (detailsChanged) {
      const r = await fetch(window.EDIT_URL + '&uid=' + encodeURIComponent(b.uid), {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(detailsBody),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'edit failed');
      // Update local snapshot and row cells
      Object.assign(b, detailsBody);
      updateRowCells(currentIdx);
    }
    // 2) Save Mark tab only if user actually selected a status (either now
    // or previously). Opening the modal to edit only Details should not
    // create a stray 'done' mark.
    const status = getSelectedInGroup('bm-status');
    if (!status) {
      closeBookingModal();
      return;
    }
    const method = getSelectedInGroup('bm-method');
    const markBody = {
      status,
      payment_method: method,
      phone: b.phone || '',
      psid: b.psid || '',
      customer_name: b.name || '',
    };
    if (method === 'mixed') {
      markBody.cash_portion = document.getElementById('bm-cash-portion').value;
      markBody.payid_portion = document.getElementById('bm-payid-portion').value;
    } else {
      markBody.actual_amount = document.getElementById('bm-amount').value;
    }
    const r2 = await fetch(window.META_URL + '&uid=' + encodeURIComponent(b.uid), {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(markBody),
    });
    if (!r2.ok) throw new Error((await r2.json()).error || 'mark failed');
    // Update local meta cache
    const toCents = v => v ? Math.round(parseFloat(v) * 100) : null;
    const cashCents = method === 'mixed' ? (toCents(markBody.cash_portion) || 0) : null;
    const payidCents = method === 'mixed' ? (toCents(markBody.payid_portion) || 0) : null;
    const amtCents = method === 'mixed' ? (cashCents + payidCents) : toCents(markBody.actual_amount);
    window.META[b.uid] = { ...window.META[b.uid], status: markBody.status, payment_method: method,
      actual_amount: amtCents, cash_portion: cashCents, payid_portion: payidCents };
    renderBadge(currentIdx);
    renderCollectedLine();
    closeBookingModal();
  } catch (e) {
    status.textContent = '❌ ' + e.message;
  }
}

async function clearBookingModal() {
  if (currentIdx < 0) return;
  const b = window.BOOKINGS[currentIdx];
  if (!confirm('Clear all markings for this booking?')) return;
  const r = await fetch(window.META_URL + '&uid=' + encodeURIComponent(b.uid), { method: 'DELETE' });
  if (r.ok) {
    delete window.META[b.uid];
    renderBadge(currentIdx);
    renderCollectedLine();
    closeBookingModal();
  }
}

function updateRowCells(idx) {
  const b = window.BOOKINGS[idx];
  const row = document.querySelector('tr[data-idx="' + idx + '"]');
  if (!row) return;
  const cells = row.querySelectorAll('td');
  // Order: n(0) src(1) time(2) svc(3) price(4) veh(5) gas(6) addr(7) who(8) mark(9)
  const svc = esc(b.service || '');
  const un = (b.notes || '').trim();
  const an = (b.ai_notes || '').trim();
  let html = svc;
  if (un) html += \`<div class="svc-notes user-note">📌 \${esc(un)}</div>\`;
  if (an) html += \`<div class="svc-notes ai-note">🤖 \${esc(an)}</div>\`;
  cells[3].innerHTML = html;
  cells[4].textContent = b.price || '';
  cells[5].textContent = b.vehicle || '';
}
</script>
</head><body>
<h1>Andy Auto AC Regas</h1>
<div class="toggle">
  <a href="${todayUrl}"${isToday ? ' class="active"' : ''}>Today</a>
  <a href="${tomorrowUrl}"${isTomorrow ? ' class="active"' : ''}>Tomorrow</a>
  <label class="other-label" style="display:flex;align-items:center;gap:4px;">Other: <input type="date" value="${targetIso}" onchange="location.href='${baseUrl}&date='+this.value"></label>
  <button class="print-btn" onclick="confirmPrint()">🖨 Print</button>
</div>
<h2>Appointments for ${dateStr} &nbsp;·&nbsp; ${summaryLine}</h2>
<script>window.NOTES_URL = '${origin}/notes?secret=${secret}&date=${targetIso}';</script>
<div class="notes-box${noteText ? '' : ' notes-empty'}">
  <div class="notes-label">📝 Notes <span id="notes-status" class="notes-status"></span></div>
  <textarea class="notes-input" placeholder="Reminders for this day — e.g. call to order O-ring, pickup tools…" oninput="onNotesInput(event)">${noteTextEsc}</textarea>
  <div id="notes-print" class="notes-print">${noteTextEsc}</div>
</div>
${equipmentBanner}${empty}${tableHtml}

<div id="booking-modal" onclick="if(event.target===this)closeBookingModal()">
  <div id="booking-modal-box">
    <div class="bm-header">
      <div class="bm-title" id="bm-title"></div>
      <button class="bm-close" onclick="closeBookingModal()">×</button>
    </div>
    <div class="bm-tabs">
      <button class="bm-tab active" data-tab="mark" onclick="switchTab('mark')">💵 Status / Pay</button>
      <button class="bm-tab" data-tab="details" onclick="switchTab('details')">📝 Details</button>
    </div>

    <div class="bm-panel active" data-tab="mark">
      <div class="bm-group">
        <label>Status <span style="font-size:0.8em;color:#999;">(tap again to unmark)</span></label>
        <div class="bm-group-btns" id="bm-status">
          <button data-value="done"      onclick="selectInGroup('bm-status','done')">✓ Done</button>
          <button data-value="partial"   onclick="selectInGroup('bm-status','partial')">◐ Partial</button>
          <button data-value="no_show"   onclick="selectInGroup('bm-status','no_show')">✗ No-show</button>
          <button data-value="cancelled" onclick="selectInGroup('bm-status','cancelled')">— Cancel</button>
        </div>
      </div>
      <div class="bm-group">
        <label>Payment method</label>
        <div class="bm-group-btns" id="bm-method">
          <button data-value="cash"   onclick="selectInGroup('bm-method','cash')">Cash</button>
          <button data-value="payid"  onclick="selectInGroup('bm-method','payid')">PayID</button>
          <button data-value="mixed"  onclick="selectInGroup('bm-method','mixed')">Mixed</button>
          <button data-value="unpaid" onclick="selectInGroup('bm-method','unpaid')">Unpaid</button>
        </div>
      </div>
      <div class="bm-group" id="bm-amount-group">
        <label>Actual amount ($)</label>
        <div class="amt-wrap">
          <input type="number" id="bm-amount" step="0.01" inputmode="decimal">
          <button type="button" class="sign-btn" onclick="flipSign('bm-amount')" title="Flip sign">±</button>
        </div>
      </div>
      <div class="bm-group" id="bm-mixed-group" style="display:none;">
        <label>Split: Cash + PayID ($) <span style="font-size:0.8em;color:#999;">(tap ± for refund, e.g. 150 cash + -20 PayID change)</span></label>
        <div class="bm-row" style="margin-bottom:0;">
          <div class="amt-wrap">
            <input type="number" id="bm-cash-portion" step="0.01" inputmode="decimal" placeholder="Cash" oninput="updateMixedTotal()">
            <button type="button" class="sign-btn" onclick="flipSign('bm-cash-portion', updateMixedTotal)" title="Flip sign">±</button>
          </div>
          <div class="amt-wrap">
            <input type="number" id="bm-payid-portion" step="0.01" inputmode="decimal" placeholder="PayID" oninput="updateMixedTotal()">
            <button type="button" class="sign-btn" onclick="flipSign('bm-payid-portion', updateMixedTotal)" title="Flip sign">±</button>
          </div>
        </div>
        <div id="bm-mixed-total" style="font-size:0.85em;color:#666;margin-top:4px;"></div>
      </div>
      <div class="bm-group">
        <label>📌 Notes (your own records — AI never touches this)</label>
        <textarea id="bm-event-notes-mark" placeholder="e.g. took $50 deposit, need to order O-rings" oninput="syncNotes('mark')"></textarea>
      </div>
    </div>

    <div class="bm-panel" data-tab="details">
      <div class="bm-row">
        <div><label>Service</label><input id="bm-service"></div>
        <div><label>Price</label><input id="bm-price"></div>
      </div>
      <div class="bm-group"><label>Vehicle</label><input id="bm-vehicle"></div>
      <div class="bm-group"><label>Address</label><input id="bm-address"></div>
      <div class="bm-row">
        <div><label>Customer</label><input id="bm-name"></div>
        <div><label>Mobile</label><input id="bm-mobile"></div>
      </div>
      <div class="bm-group"><label>🤖 AI notes (customer context, usually AI-written)</label><textarea id="bm-ai-notes" placeholder="e.g. Gate code 8989. Dog in yard. Leave key with neighbour."></textarea></div>
      <div class="bm-group"><label>📌 Notes (your own records — AI never touches this)</label><textarea id="bm-event-notes" placeholder="e.g. Quoted $750 for pipes. Needs follow-up next month." oninput="syncNotes('details')"></textarea></div>
    </div>

    <div class="bm-actions">
      <button class="btn-clear" id="bm-clear" onclick="clearBookingModal()">Clear markings</button>
      <div style="flex:1"></div>
      <span class="bm-status" id="bm-status-msg"></span>
      <button class="btn-cancel" onclick="closeBookingModal()">Cancel</button>
      <button class="btn-save" onclick="saveBookingModal()">Save</button>
    </div>
  </div>
</div>

<script>
window.BOOKINGS = ${JSON.stringify(bookingData)};
window.META_URL = '${origin}/bookings/meta?secret=${secret}';
window.EDIT_URL = '${origin}/bookings/edit?secret=${secret}';
if (window.BOOKINGS.length) loadMeta();
</script>

<div id="print-modal">
  <div id="print-modal-box">
    <div>Print appointments for</div>
    <div class="modal-date">${isToday ? 'Today — ' : isTomorrow ? 'Tomorrow — ' : ''}${dateStr}</div>
    <div class="modal-count">${bookings.length} booking${bookings.length !== 1 ? 's' : ''}</div>
    <div class="modal-hint">Select Landscape in print settings</div>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="cancelPrint()">Cancel</button>
      <button class="btn-print" onclick="doPrint()">🖨 Print</button>
    </div>
  </div>
</div>
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

// =========================================================================
// 车型冷媒数据库 (Cloudflare D1)
// =========================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
  });
}

function validateVehicle(v) {
  const errors = [];
  if (!v.make || !String(v.make).trim()) errors.push('make required');
  if (!v.model || !String(v.model).trim()) errors.push('model required');
  const ys = Number(v.year_start), ye = Number(v.year_end);
  if (!Number.isInteger(ys) || ys < 1950 || ys > 2100) errors.push('year_start 1950-2100');
  if (!Number.isInteger(ye) || ye < ys || ye > 2100) errors.push('year_end must be >= year_start and <= 2100');
  if (!v.refrigerant || !/^R134a$|^R12$/i.test(String(v.refrigerant).trim())) errors.push('refrigerant must be R134a or R12');
  const cg = Number(v.charge_g);
  if (!Number.isFinite(cg) || cg <= 0 || cg > 5000) errors.push('charge_g 1-5000');
  return errors;
}

function normalizeVehicle(v) {
  return {
    make: String(v.make || '').trim(),
    model: String(v.model || '').trim(),
    year_start: Number(v.year_start),
    year_end: Number(v.year_end),
    variant: String(v.variant || '').trim(),
    refrigerant: String(v.refrigerant || '').trim().replace(/^r/i, 'R'),
    charge_g: Number(v.charge_g),
    notes: String(v.notes || '').trim(),
  };
}

// Refrigerant unit prices in $/kg. Stored in BARK_COOLDOWN KV under a single
// JSON key so Andy can adjust whenever the supplier changes rates.
// R1234yf not offered as a service right now; add it back here if that changes.
const PRICES_KV_KEY = 'refrigerant_prices';
const REFRIGERANTS = ['R134a', 'R12'];

async function loadRefrigerantPrices(env) {
  if (!env.BARK_COOLDOWN) return {};
  try {
    const v = await env.BARK_COOLDOWN.get(PRICES_KV_KEY);
    return v ? JSON.parse(v) : {};
  } catch { return {}; }
}

async function refrigerantPricesHandler(req, env) {
  if (req.method === 'GET') {
    return jsonResponse(await loadRefrigerantPrices(env));
  }
  if (req.method === 'POST') {
    const body = await req.json();
    const clean = {};
    for (const r of REFRIGERANTS) {
      const n = Number(body[r]);
      if (Number.isFinite(n) && n >= 0 && n < 10000) clean[r] = n;
    }
    if (env.BARK_COOLDOWN) {
      await env.BARK_COOLDOWN.put(PRICES_KV_KEY, JSON.stringify(clean));
    }
    return jsonResponse({ ok: true, prices: clean });
  }
  return jsonResponse({ error: 'method not allowed' }, 405);
}

// =========================================================================
// CRM: 工单标记 (bookings_meta) + Calendar 事件编辑
// =========================================================================

const BOOKING_STATUSES = new Set(['done', 'partial', 'no_show', 'cancelled']);
const PAYMENT_METHODS = new Set(['cash', 'payid', 'mixed', 'unpaid']);

function parsePriceCents(priceStr) {
  if (!priceStr) return null;
  const m = String(priceStr).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return Math.round(parseFloat(m[0]) * 100);
}

// Upsert customers row keyed by phone or psid (whichever is non-empty).
async function upsertCustomer(env, { phone, psid, name, amount_cents, now }) {
  if (!env.DB) return;
  if (!phone && !psid) return;
  try {
    // Try to find existing row
    let existing;
    if (phone) {
      existing = (await env.DB.prepare(`SELECT * FROM customers WHERE phone = ?`).bind(phone).first());
    }
    if (!existing && psid) {
      existing = (await env.DB.prepare(`SELECT * FROM customers WHERE psid = ?`).bind(psid).first());
    }
    if (existing) {
      // Merge: fill in missing name, update last_seen, bump visit_count if amount > 0, add to total_paid
      const newName = existing.name || name || null;
      const newLast = Math.max(existing.last_seen || 0, now);
      const bump = amount_cents && amount_cents > 0 ? 1 : 0;
      const addPaid = amount_cents && amount_cents > 0 ? amount_cents : 0;
      await env.DB.prepare(
        `UPDATE customers SET name = ?, last_seen = ?, visit_count = visit_count + ?, total_paid = total_paid + ?,
                              phone = COALESCE(phone, ?), psid = COALESCE(psid, ?)
         WHERE id = ?`
      ).bind(newName, newLast, bump, addPaid, phone, psid, existing.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO customers (phone, psid, name, first_seen, last_seen, visit_count, total_paid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(phone || null, psid || null, name || null, now, now,
             amount_cents > 0 ? 1 : 0, amount_cents > 0 ? amount_cents : 0).run();
    }
  } catch (e) {
    console.error('upsertCustomer failed', e);
  }
}

async function bookingsMetaHandler(req, url, env) {
  try {
    return await bookingsMetaHandlerInner(req, url, env);
  } catch (e) {
    console.error('bookingsMetaHandler', e);
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
}

async function bookingsMetaHandlerInner(req, url, env) {
  if (!env.DB) return jsonResponse({ error: 'D1 binding missing' }, 500);
  const uid = url.searchParams.get('uid');
  const date = url.searchParams.get('date');  // YYYY-MM-DD — bulk read by day

  if (req.method === 'GET') {
    if (uid) {
      const row = await env.DB.prepare(`SELECT * FROM bookings_meta WHERE calendar_uid = ?`).bind(uid).first();
      return jsonResponse({ meta: row || null });
    }
    // Bulk GET: return ALL meta rows (the print page filters client-side by UID).
    // Dataset is small (days of bookings), no point paginating.
    const { results } = await env.DB.prepare(`SELECT * FROM bookings_meta`).all();
    const map = {};
    for (const r of results) map[r.calendar_uid] = r;
    return jsonResponse({ meta: map });
  }

  if (req.method === 'POST') {
    if (!uid) return jsonResponse({ error: 'uid required' }, 400);
    const body = await req.json();
    const status = body.status && BOOKING_STATUSES.has(body.status) ? body.status : null;
    const method = body.payment_method && PAYMENT_METHODS.has(body.payment_method) ? body.payment_method : null;
    // Negative amounts are legitimate: e.g. customer paid \$150 cash and
    // Andy returned \$20 via PayID → cash_portion=15000, payid_portion=-2000,
    // actual_amount=13000. Only null/empty maps to null; any finite number
    // (positive, zero, negative) is accepted.
    const dollarsToCents = v => {
      if (v === undefined || v === '' || v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) && Math.abs(n) < 1e8 ? Math.round(n * 100) : null;
    };
    let amountCents = dollarsToCents(body.actual_amount);
    let cashPortion = null, payidPortion = null;
    if (method === 'mixed') {
      cashPortion = dollarsToCents(body.cash_portion);
      payidPortion = dollarsToCents(body.payid_portion);
      if (cashPortion === null) cashPortion = 0;
      if (payidPortion === null) payidPortion = 0;
      amountCents = cashPortion + payidPortion;
    }
    const now = Math.floor(Date.now() / 1000);
    const phone = (body.phone || '').trim() || null;
    const psid = (body.psid || '').trim() || null;
    const notes = String(body.our_notes || '').trim();
    const paidAt = (status === 'done' || status === 'partial') ? now : null;

    await env.DB.prepare(
      `INSERT INTO bookings_meta (calendar_uid, phone, psid, status, actual_amount, payment_method, cash_portion, payid_portion, paid_at, our_notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(calendar_uid) DO UPDATE SET
         phone = COALESCE(excluded.phone, phone),
         psid  = COALESCE(excluded.psid, psid),
         status = excluded.status,
         actual_amount = excluded.actual_amount,
         payment_method = excluded.payment_method,
         cash_portion = excluded.cash_portion,
         payid_portion = excluded.payid_portion,
         paid_at = excluded.paid_at,
         our_notes = excluded.our_notes,
         updated_at = excluded.updated_at`
    ).bind(uid, phone, psid, status, amountCents, method, cashPortion, payidPortion, paidAt, notes, now).run();

    // Side effect: upsert customer and bump totals
    if (phone || psid) {
      await upsertCustomer(env, {
        phone, psid, name: body.customer_name || null,
        amount_cents: amountCents || 0, now,
      });
    }

    return jsonResponse({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!uid) return jsonResponse({ error: 'uid required' }, 400);
    await env.DB.prepare(`DELETE FROM bookings_meta WHERE calendar_uid = ?`).bind(uid).run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'method not allowed' }, 405);
}

async function reportPage(req, url, env) {
  if (!env.DB) return new Response('D1 binding missing', { status: 500 });
  const cfg = config(env);
  const today = todayInTz(cfg.tz);
  const period = url.searchParams.get('period') || 'month';   // month / ytd / 30d
  const monthParam = url.searchParams.get('month');           // YYYY-MM
  const wantsCsv = url.searchParams.get('format') === 'csv';

  // Resolve [startTs, endTs) in unix seconds for the chosen period.
  let startSec, endSec, label;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [y, m] = monthParam.split('-').map(Number);
    startSec = Math.floor(new Date(Date.UTC(y, m - 1, 1)).getTime() / 1000);
    endSec = Math.floor(new Date(Date.UTC(y, m, 1)).getTime() / 1000);
    label = `${monthParam}`;
  } else if (period === 'ytd') {
    startSec = Math.floor(new Date(Date.UTC(today.y, 0, 1)).getTime() / 1000);
    endSec = Math.floor(Date.now() / 1000) + 86400;
    label = `YTD ${today.y}`;
  } else if (period === '30d') {
    endSec = Math.floor(Date.now() / 1000) + 86400;
    startSec = endSec - 30 * 86400;
    label = 'Last 30 days';
  } else {
    // default: current month
    startSec = Math.floor(new Date(Date.UTC(today.y, today.m - 1, 1)).getTime() / 1000);
    endSec = Math.floor(new Date(Date.UTC(today.y, today.m, 1)).getTime() / 1000);
    label = `${today.y}-${pad(today.m)}`;
  }

  // Pull all bookings_meta rows in the time window (by paid_at).
  const { results: metas } = await env.DB.prepare(
    `SELECT * FROM bookings_meta
       WHERE paid_at IS NOT NULL
         AND paid_at >= ? AND paid_at < ?
       ORDER BY paid_at ASC`
  ).bind(startSec, endSec).all();

  // Aggregations
  let collected = 0, quoted = 0, cash = 0, payid = 0, mixed = 0, unpaidAmt = 0;
  let countDone = 0, countPartial = 0, countNoShow = 0, countCancel = 0, countUnpaid = 0;
  const byDay = new Map();    // 'YYYY-MM-DD' → {count, collected}
  const byMethod = { cash: 0, payid: 0, mixed: 0, unpaid: 0 };

  for (const r of metas) {
    const amt = r.actual_amount || 0;
    if (r.status === 'done') countDone++;
    else if (r.status === 'partial') countPartial++;
    else if (r.status === 'no_show') countNoShow++;
    else if (r.status === 'cancelled') countCancel++;
    if (r.status === 'done' || r.status === 'partial') collected += amt;
    // Split mixed into its cash/payid portions so the breakdown is accurate
    if (r.payment_method === 'cash') { cash += amt; byMethod.cash++; }
    else if (r.payment_method === 'payid') { payid += amt; byMethod.payid++; }
    else if (r.payment_method === 'mixed') {
      cash += (r.cash_portion || 0);
      payid += (r.payid_portion || 0);
      byMethod.mixed++;
    }
    else if (r.payment_method === 'unpaid') { unpaidAmt += amt; byMethod.unpaid++; countUnpaid++; }
    // Group by local day
    const dt = new Date(r.paid_at * 1000);
    const localStr = new Date(dt.toLocaleString('en-US', { timeZone: cfg.tz }));
    const dayKey = `${localStr.getFullYear()}-${pad(localStr.getMonth()+1)}-${pad(localStr.getDate())}`;
    const bucket = byDay.get(dayKey) || { count: 0, collected: 0, cash: 0, payid: 0, unpaid: 0 };
    bucket.count++;
    if (r.status === 'done' || r.status === 'partial') bucket.collected += amt;
    if (r.payment_method === 'cash') bucket.cash += amt;
    else if (r.payment_method === 'payid') bucket.payid += amt;
    else if (r.payment_method === 'mixed') {
      bucket.cash += (r.cash_portion || 0);
      bucket.payid += (r.payid_portion || 0);
    }
    else if (r.payment_method === 'unpaid') bucket.unpaid += amt;
    byDay.set(dayKey, bucket);
  }

  if (wantsCsv) {
    const rows = [['date', 'count', 'collected_cents', 'cash_cents', 'payid_cents', 'unpaid_cents']];
    for (const [day, b] of Array.from(byDay.entries()).sort().reverse()) {
      rows.push([day, b.count, b.collected, b.cash, b.payid, b.unpaid]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': `attachment; filename="andy-auto-${label}.csv"`,
      },
    });
  }

  const money = c => '$' + (c/100).toFixed(2);
  const secret = encodeURIComponent(env.VERIFY_TOKEN || '');
  const base = `${url.origin}/report?secret=${secret}`;
  const dayRows = Array.from(byDay.entries()).sort().reverse().slice(0, 62).map(([day, b]) => `
      <tr>
        <td>${day}</td>
        <td>${b.count}</td>
        <td>${money(b.collected)}</td>
        <td>${money(b.cash)}</td>
        <td>${money(b.payid)}</td>
        <td>${b.unpaid ? '<span class="unpaid">' + money(b.unpaid) + '</span>' : ''}</td>
      </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Andy Auto – Report ${label}</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; margin: 20px; color: #111; max-width: 900px; }
  h1 { font-size: 1.2em; margin: 0 0 4px; }
  .sub { color: #666; font-size: 0.85em; margin-bottom: 16px; }
  .period-nav { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .period-nav a { padding: 6px 10px; border: 1px solid #bbb; color: #333; background: #f5f5f5; text-decoration: none; border-radius: 6px; font-size: 0.85em; }
  .period-nav a.active { background: #222; color: #fff; border-color: #222; }
  .period-nav .csv-btn { margin-left: auto; background: #2a7a2a; color: #fff; border-color: #2a7a2a; }
  .totals { background: #f5f5f5; padding: 16px 18px; border-radius: 8px; margin-bottom: 20px; }
  .totals .big { font-size: 1.8em; font-weight: bold; color: #060; margin: 4px 0 8px; }
  .totals .quoted { font-size: 1em; color: #555; }
  .totals .gap { font-size: 0.9em; color: #a00; margin-top: 6px; }
  .totals .breakdown { font-size: 0.95em; color: #333; margin-top: 10px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 18px; }
  .stats .box { background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 10px 12px; }
  .stats .box .k { font-size: 0.78em; color: #777; }
  .stats .box .v { font-size: 1.15em; font-weight: bold; color: #111; margin-top: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th { background: #222; color: #fff; padding: 7px 10px; text-align: left; font-weight: normal; }
  td { padding: 7px 10px; border-bottom: 1px solid #eee; }
  .unpaid { color: #a00; font-weight: bold; }
  .empty { color: #888; font-style: italic; padding: 24px; text-align: center; }
</style></head><body>
<h1>Andy Auto – Revenue Report</h1>
<div class="sub">${label}  (${metas.length} bookings marked)</div>

<div class="period-nav">
  <a href="${base}&period=30d" class="${period==='30d'?'active':''}">Last 30 days</a>
  <a href="${base}" class="${!monthParam && period==='month'?'active':''}">This month</a>
  <a href="${base}&period=ytd" class="${period==='ytd'?'active':''}">YTD ${today.y}</a>
  <a class="csv-btn" href="${base}&format=csv${monthParam ? '&month=' + monthParam : period==='ytd' ? '&period=ytd' : period==='30d' ? '&period=30d' : ''}">⬇ CSV</a>
</div>

${metas.length === 0 ? `
<div class="empty">No bookings marked in this period. Start marking jobs on <a href="/print?secret=${secret}">/print</a>.</div>
` : `
<div class="totals">
  <div style="color:#555;font-size:0.85em;">Collected</div>
  <div class="big">${money(collected)}</div>
  <div class="quoted">Quoted ${money(quoted || collected)} ${collected < (quoted || collected) ? '(gap ' + money((quoted || collected) - collected) + ')' : ''}</div>
  <div class="breakdown">
    💵 Cash ${money(cash)}  ·
    📱 PayID ${money(payid)}  ·
    ${mixed ? '📊 Mixed ' + money(mixed) + '  ·  ' : ''}
    ${unpaidAmt ? '<span class="unpaid">⚠ Unpaid ' + money(unpaidAmt) + ' (' + countUnpaid + ')</span>' : '<span style="color:#060">All paid ✓</span>'}
  </div>
</div>

<div class="stats">
  <div class="box"><div class="k">Done</div><div class="v">${countDone}</div></div>
  <div class="box"><div class="k">Partial</div><div class="v">${countPartial}</div></div>
  <div class="box"><div class="k">No-show</div><div class="v">${countNoShow}</div></div>
  <div class="box"><div class="k">Cancelled</div><div class="v">${countCancel}</div></div>
</div>

<h2 style="font-size:1em;margin-top:24px;margin-bottom:8px;">Per-day breakdown (most recent first, up to 62 days)</h2>
<table>
  <thead><tr><th>Date</th><th>#</th><th>Collected</th><th>Cash</th><th>PayID</th><th>Unpaid</th></tr></thead>
  <tbody>${dayRows}</tbody>
</table>
`}
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

async function migrateAiNotesHandler(env) {
  const cfg = config(env);
  const cal = await calendarUrl(env);
  const now = Date.now();
  // Pull a wide window (2 years back, 1 year forward) — covers everything Andy
  // has ever created. Not suitable for deeply historical data but matches the
  // Worker's other calendar queries.
  const r = await dav(env, 'REPORT', cal, {
    depth: 1,
    body: `${XML_HEAD}<c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utcStamp(now - 730 * 864e5)}" end="${utcStamp(now + 400 * 864e5)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  let seen = 0, migrated = 0, alreadyMigrated = 0, noNotes = 0, errors = 0;
  const errorSummaries = [];
  for (const resp of xmlAll(r.text, 'response')) {
    const ics = xmlText(xmlOne(resp, 'calendar-data'));
    if (!ics.includes('BEGIN:VEVENT')) continue;
    seen++;
    const href = new URL(xmlText(xmlOne(resp, 'href')), cal).href;
    const etag = xmlText(xmlOne(resp, 'getetag')) || null;
    const parsed = parseEvent(ics, cfg.tz);
    const desc = parsed.description || '';
    if (/^AI notes:/im.test(desc)) { alreadyMigrated++; continue; }
    if (!/^Notes:/im.test(desc)) { noNotes++; continue; }
    // Rename the single Notes: line to AI notes:
    const newDesc = desc.replace(/^Notes:/im, 'AI notes:');
    const changes = {
      SEQUENCE: [`SEQUENCE:${(parsed.sequence || 0) + 1}`],
      DTSTAMP: [`DTSTAMP:${utcStamp(Date.now())}`],
      'LAST-MODIFIED': [`LAST-MODIFIED:${utcStamp(Date.now())}`],
      DESCRIPTION: [`DESCRIPTION:${icsEsc(newDesc)}`],
    };
    try {
      await dav(env, 'PUT', href, {
        body: editEvent(ics, changes),
        headers: etag ? { 'if-match': etag } : {},
      });
      migrated++;
    } catch (e) {
      errors++;
      if (errorSummaries.length < 5) errorSummaries.push(`${parsed.uid}: ${e.message || e}`);
    }
  }
  return jsonResponse({
    seen, migrated, alreadyMigrated, noNotes, errors,
    errorSamples: errorSummaries,
  });
}

async function bookingEditHandler(req, url, env) {
  try {
    return await bookingEditHandlerInner(req, url, env);
  } catch (e) {
    console.error('bookingEditHandler', e);
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
}

async function bookingEditHandlerInner(req, url, env) {
  // Edit a Calendar event's fields (Service/Price/Vehicle/Address/Customer/Mobile/Notes).
  const uid = url.searchParams.get('uid');
  if (!uid) return jsonResponse({ error: 'uid required' }, 400);
  const body = await req.json();
  const cfg = config(env);

  // Find the event: iCloud's text-match prop-filter is unreliable, so we
  // pull a wide time window and match the UID in-memory.
  const cal = await calendarUrl(env);
  const now = Date.now();
  const r = await dav(env, 'REPORT', cal, {
    depth: 1,
    body: `${XML_HEAD}<c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utcStamp(now - 400 * 864e5)}" end="${utcStamp(now + 400 * 864e5)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  let target = null, href = null, etag = null, ics = '';
  for (const resp of xmlAll(r.text, 'response')) {
    const calData = xmlText(xmlOne(resp, 'calendar-data'));
    if (!calData.includes('BEGIN:VEVENT')) continue;
    const parsed = parseEvent(calData, cfg.tz);
    if (parsed.uid === uid) {
      target = parsed;
      ics = calData;
      href = new URL(xmlText(xmlOne(resp, 'href')), cal).href;
      etag = xmlText(xmlOne(resp, 'getetag')) || null;
      break;
    }
  }
  if (!target) return jsonResponse({ error: 'event not found for uid ' + uid }, 404);

  const changes = {
    SEQUENCE: [`SEQUENCE:${(target.sequence || 0) + 1}`],
    DTSTAMP: [`DTSTAMP:${utcStamp(Date.now())}`],
    'LAST-MODIFIED': [`LAST-MODIFIED:${utcStamp(Date.now())}`],
  };

  // New values (undefined = skip, '' = clear)
  // 'notes' is the user's own records (goes to "Notes:" line).
  // 'ai_notes' is the AI-extracted customer context (goes to "AI notes:" line).
  // The two are kept separate so editing one never clobbers the other —
  // SMS/FB AI update flows only touch ai_notes; UI Details-tab edits only
  // touch notes (unless Andy explicitly also sets ai_notes).
  const fields = ['service', 'price', 'vehicle', 'address', 'name', 'mobile', 'notes', 'ai_notes'];
  const newVals = {};
  for (const f of fields) {
    if (body[f] !== undefined) newVals[f] = String(body[f] || '').trim();
  }

  if (newVals.address !== undefined) {
    const clean = normalizeAddress(newVals.address);
    changes.LOCATION = [`LOCATION:${icsEsc(clean)}`];
  }

  // Update description: merge in any changed field as a `Field: value` line
  if (Object.keys(newVals).length > 0) {
    const desc = (target.description || '').split('\n');
    const updateLine = (field, label) => {
      if (newVals[field] === undefined) return;
      // Exact label match — 'Notes:' vs 'AI notes:' don't overlap because
      // of the leading anchor + exact prefix text.
      const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*', 'i');
      const idx = desc.findIndex(l => re.test(l));
      const line = newVals[field] ? `${label}: ${newVals[field]}` : '';
      if (idx >= 0) {
        if (line) desc[idx] = line; else desc.splice(idx, 1);
      } else if (line) {
        desc.push(line);
      }
    };
    updateLine('service', 'Service');
    updateLine('price', 'Price');
    updateLine('vehicle', 'Vehicle');
    updateLine('address', 'Address');
    updateLine('mobile', 'Mobile');
    updateLine('notes', 'Notes');
    updateLine('ai_notes', 'AI notes');
    updateLine('name', 'Name');
    changes.DESCRIPTION = [`DESCRIPTION:${icsEsc(desc.filter(Boolean).join('\n'))}`];
  }

  // Rebuild summary when name/service/price changed
  if (newVals.name !== undefined || newVals.service !== undefined || newVals.price !== undefined) {
    const name = newVals.name !== undefined ? newVals.name : (target.name || '');
    const service = newVals.service !== undefined ? newVals.service : (target.service || '');
    const price = newVals.price !== undefined ? newVals.price : (target.price || '');
    changes.SUMMARY = [`SUMMARY:${icsEsc(buildSummary(name || 'Customer', service, price))}`];
    // Also update X- fields where they exist
    if (newVals.name !== undefined) changes['X-FB-NAME'] = [`X-FB-NAME:${icsEsc(newVals.name)}`];
    if (newVals.service !== undefined) changes['X-FB-SERVICE'] = [`X-FB-SERVICE:${icsEsc(newVals.service)}`];
    if (newVals.price !== undefined) changes['X-FB-PRICE'] = [`X-FB-PRICE:${icsEsc(newVals.price)}`];
  }

  try {
    await dav(env, 'PUT', href, {
      body: editEvent(ics, changes),
      headers: etag ? { 'if-match': etag } : {},
    });
  } catch (e) {
    if (e.status === 412) return jsonResponse({ error: 'event changed elsewhere, reload and try again' }, 409);
    return jsonResponse({ error: e.message || 'update failed' }, 500);
  }

  return jsonResponse({ ok: true });
}

function vehiclesAdminPage(env, origin) {
  const secret = encodeURIComponent(env.VERIFY_TOKEN || '');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Andy Auto – Vehicle DB</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; margin: 20px; color: #111; max-width: 1100px; }
  h1 { font-size: 1.2em; margin: 0 0 4px; }
  .sub { color: #666; font-size: 0.85em; margin-bottom: 16px; }
  .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .bar input[type=search] { flex: 1; min-width: 180px; padding: 7px 10px; font-size: 0.95em; border: 1px solid #ccc; border-radius: 6px; }
  .search-hint { font-size: 0.78em; color: #888; white-space: nowrap; }
  .search-hint .year-chip { display: inline-block; background: #efe; border: 1px solid #9c9; color: #060; padding: 1px 6px; border-radius: 10px; font-weight: bold; margin-right: 4px; }
  .prices-bar { display: flex; gap: 14px; align-items: center; margin-bottom: 12px; padding: 8px 12px; background: #fff8e8; border: 1px solid #f0d890; border-radius: 6px; font-size: 0.88em; flex-wrap: wrap; }
  .prices-bar .prices-label { font-weight: bold; color: #7a5a00; }
  .prices-bar label { display: flex; align-items: center; gap: 5px; }
  .prices-bar input { width: 70px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em; }
  .prices-bar .unit { color: #7a5a00; font-size: 0.9em; }
  .prices-status { font-size: 0.82em; color: #888; margin-left: auto; }
  td.cost { white-space: nowrap; color: #060; font-weight: bold; }
  td.cost .cost-empty { color: #ccc; font-weight: normal; }
  .btn { padding: 7px 14px; border-radius: 6px; font-size: 0.9em; border: 1px solid #2a7a2a; color: #fff; background: #2a7a2a; cursor: pointer; }
  .btn:hover { background: #1e5c1e; }
  .btn.alt { background: #fff; color: #333; border-color: #ccc; }
  .btn.alt:hover { background: #f0f0f0; }
  .btn.danger { background: #c22; border-color: #c22; }
  .btn.danger:hover { background: #a00; }
  table { border-collapse: collapse; width: 100%; font-size: 0.88em; }
  th { background: #222; color: #fff; padding: 7px 10px; text-align: left; font-weight: normal; white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr:hover { background: #fafafa; }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions button { font-size: 0.78em; padding: 3px 8px; margin-left: 4px; border-radius: 4px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  td.actions button.del { color: #c22; border-color: #e5a; }
  /* Source badge: M = Andy manual, N = Nissens import, C = CoolDrive GasBook import */
  td.src { padding: 7px 6px; }
  td.src span { display: inline-block; width: 18px; text-align: center; border-radius: 3px; font-size: 0.72em; font-weight: bold; padding: 1px 0; }
  td.src .src-manual    { background: #2a7a2a; color: #fff; }
  td.src .src-nissens   { background: #e8f0ff; color: #1850a0; border: 1px solid #a0b8e0; }
  td.src .src-hychill   { background: #fff4e0; color: #a05a00; border: 1px solid #e0b870; }
  td.src .src-cooldrive { background: #f5f5f5; color: #666; border: 1px solid #ccc; }
  tr.group-row { cursor: pointer; background: #fcfcfa; }
  tr.group-row:hover { background: #f0f4f8; }
  tr.group-row .group-variant { color: #777; font-style: italic; }
  tr.expanded-child { background: #fafafa; }
  tr.expanded-child td:first-child { border-left: 3px solid #bbb; }
  .empty { color: #888; font-style: italic; padding: 24px; text-align: center; }
  .msg { padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 0.9em; }
  .msg.err { background: #fee; color: #a00; border: 1px solid #f99; }
  .msg.ok { background: #efe; color: #060; border: 1px solid #9c9; }
  #modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 50; align-items: center; justify-content: center; }
  #modal.open { display: flex; }
  #modal-box { background: #fff; border-radius: 10px; padding: 20px 22px; width: 90%; max-width: 480px; max-height: 90vh; overflow-y: auto; }
  #modal-box h2 { margin: 0 0 12px; font-size: 1.05em; }
  .row { display: flex; gap: 8px; margin-bottom: 10px; }
  .row > div { flex: 1; }
  .row label { display: block; font-size: 0.78em; color: #666; margin-bottom: 2px; }
  .row input, .row select, .row textarea { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9em; box-sizing: border-box; font-family: inherit; }
  .row textarea { resize: vertical; min-height: 44px; }
  .modal-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
</style></head><body>
<h1>Andy Auto – Vehicle Refrigerant DB</h1>
<div class="sub">Lookup data for AC regas quoting. R1234yf prices ~5-10x more than R134a — always double-check that field.</div>
<div id="msg"></div>
<div class="prices-bar">
  <span class="prices-label">💰 Refrigerant unit price:</span>
  <label>R134a <input type="number" id="price-R134a" min="0" step="0.5" onchange="savePrices()" oninput="recomputeCosts()"> <span class="unit">$/kg</span></label>
  <span id="prices-status" class="prices-status"></span>
</div>
<div class="bar">
  <input type="search" id="q" placeholder="Search e.g. 'camry 2013', 'hilux', 'mazda cx-5 2018'…" oninput="debouncedLoad()">
  <span id="search-hint" class="search-hint"></span>
  <button class="btn" onclick="openAdd()">+ Add vehicle</button>
</div>
<div id="tbl"></div>

<div id="modal" onclick="if(event.target===this)closeModal()">
  <div id="modal-box">
    <h2 id="modal-title">Add vehicle</h2>
    <form id="form" onsubmit="submitForm(event)">
      <input type="hidden" id="f-id">
      <div class="row">
        <div><label>Make *</label><input id="f-make" required></div>
        <div><label>Model *</label><input id="f-model" required></div>
      </div>
      <div class="row">
        <div><label>Year start *</label><input id="f-ys" type="number" min="1950" max="2100" required></div>
        <div><label>Year end *</label><input id="f-ye" type="number" min="1950" max="2100" required></div>
      </div>
      <div class="row">
        <div><label>Variant (optional)</label><input id="f-variant" placeholder="e.g. Hybrid / Petrol / GUN126R"></div>
      </div>
      <div class="row">
        <div><label>Refrigerant *</label>
          <select id="f-refrig" required>
            <option value="R134a">R134a</option>
            <option value="R12">R12 (legacy)</option>
          </select>
        </div>
        <div><label>Charge (g) *</label><input id="f-charge" type="number" min="1" max="5000" required></div>
      </div>
      <div class="row">
        <div><label>Notes</label><textarea id="f-notes" placeholder="e.g. Variant-specific caveats"></textarea></div>
      </div>
      <div class="modal-btns">
        <button type="button" class="btn alt" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn" id="save-btn">Save</button>
      </div>
    </form>
  </div>
</div>

<script>
const SECRET = '${secret}';
const API = '${origin}/vehicles/api?secret=' + SECRET;
const PRICES_API = '${origin}/refrigerant-prices?secret=' + SECRET;
let currentRows = [];
let currentPrices = {};
let debounceTimer, priceSaveTimer;
function debouncedLoad() { clearTimeout(debounceTimer); debounceTimer = setTimeout(load, 220); }

async function loadPrices() {
  try {
    const r = await fetch(PRICES_API);
    currentPrices = await r.json();
    for (const ref of ['R134a']) {
      const el = document.getElementById('price-' + ref);
      if (el && currentPrices[ref] != null) el.value = currentPrices[ref];
    }
  } catch {}
}

function savePrices() {
  const body = {};
  for (const ref of ['R134a', 'R12']) {
    const el = document.getElementById('price-' + ref);
    if (el && el.value !== '') body[ref] = Number(el.value);
  }
  currentPrices = body;
  const status = document.getElementById('prices-status');
  if (status) status.textContent = 'saving…';
  clearTimeout(priceSaveTimer);
  priceSaveTimer = setTimeout(async () => {
    try {
      await fetch(PRICES_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (status) { status.textContent = 'saved'; setTimeout(() => { if (status.textContent === 'saved') status.textContent = ''; }, 1500); }
    } catch { if (status) status.textContent = 'save failed'; }
  }, 500);
}

function recomputeCosts() {
  // Update costs in-place without re-fetching from server.
  for (const ref of ['R134a', 'R12']) {
    const el = document.getElementById('price-' + ref);
    if (el) currentPrices[ref] = el.value === '' ? null : Number(el.value);
  }
  render();
}

function costCell(v) {
  const price = currentPrices[v.refrigerant];
  if (price == null || !Number.isFinite(Number(price))) return '<span class="cost-empty">—</span>';
  const cost = v.charge_g * price / 1000;
  return '$' + cost.toFixed(2);
}
function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function flash(text, ok) {
  const m = document.getElementById('msg');
  m.className = 'msg ' + (ok ? 'ok' : 'err');
  m.textContent = text;
  setTimeout(() => { m.textContent = ''; m.className = ''; }, 3500);
}
async function load() {
  const raw = document.getElementById('q').value.trim();
  // Pull any 4-digit year out of the query (1950-2100); rest is the text search.
  const yearMatch = raw.match(/\\b(19[5-9]\\d|20\\d{2}|2100)\\b/);
  const year = yearMatch ? yearMatch[1] : '';
  const text = raw.replace(/\\b(19[5-9]\\d|20\\d{2}|2100)\\b/, '').replace(/\\s+/g, ' ').trim();
  const hint = document.getElementById('search-hint');
  hint.innerHTML = year ? ('<span class="year-chip">year ' + year + '</span>') : '';
  const params = [];
  if (text) params.push('q=' + encodeURIComponent(text));
  if (year) params.push('year=' + encodeURIComponent(year));
  const r = await fetch(API + (params.length ? '&' + params.join('&') : ''));
  const data = await r.json();
  currentRows = data.vehicles || [];
  render();
}
const expandedGroups = new Set();
function render() {
  const tbl = document.getElementById('tbl');
  if (!currentRows.length) {
    tbl.innerHTML = '<div class="empty">No vehicles yet. Click + Add vehicle to start.</div>';
    return;
  }
  const srcBadge = s => {
    const label = { manual: 'M', nissens: 'N', hychill: 'H', cooldrive: 'C' }[s] || '?';
    const cls = 'src-' + (s || 'unknown');
    return \`<span class="\${cls}" title="\${s}">\${label}</span>\`;
  };
  // Group rows with identical (make, model, refrigerant, charge_g, year_start,
  // year_end, source): same car + same charge → fold into one line. Variants
  // and notes differ per row but the charge Andy quotes from is identical.
  const buildRow = v => {
    const years = v.year_end >= 2100 ? v.year_start + '+'
      : (v.year_start === v.year_end ? v.year_start : v.year_start + '-' + v.year_end);
    return \`<tr>
      <td class="src">\${srcBadge(v.source)}</td>
      <td><strong>\${esc(v.make)}</strong></td>
      <td>\${esc(v.model)}</td>
      <td>\${esc(v.variant)}</td>
      <td>\${years}</td>
      <td>\${esc(v.refrigerant)}</td>
      <td>\${v.charge_g}g</td>
      <td class="cost">\${costCell(v)}</td>
      <td>\${esc(v.notes)}</td>
      <td class="actions">
        <button onclick="openEdit(\${v.id})">Edit</button>
        <button class="del" onclick="del(\${v.id})">Delete</button>
      </td>
    </tr>\`;
  };
  const groups = new Map();
  for (const v of currentRows) {
    const key = [v.make, v.model, v.refrigerant, v.charge_g, v.year_start, v.year_end, v.source].join('§');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const rowsHtml = [];
  for (const [key, items] of groups) {
    if (items.length === 1) {
      rowsHtml.push(buildRow(items[0]));
      continue;
    }
    // Collapsed row: summary line + optional expanded rows beneath
    const first = items[0];
    const years = first.year_end >= 2100 ? first.year_start + '+'
      : (first.year_start === first.year_end ? first.year_start : first.year_start + '-' + first.year_end);
    const expanded = expandedGroups.has(key);
    const toggleIcon = expanded ? '▾' : '▸';
    const esc_key = key.replace(/'/g, "\\\\'");
    rowsHtml.push(\`<tr class="group-row" onclick="toggleGroup('\${esc_key}')">
      <td class="src">\${srcBadge(first.source)}</td>
      <td><strong>\${esc(first.make)}</strong></td>
      <td>\${esc(first.model)}</td>
      <td class="group-variant">\${toggleIcon} <em>\${items.length} variants</em></td>
      <td>\${years}</td>
      <td>\${esc(first.refrigerant)}</td>
      <td>\${first.charge_g}g</td>
      <td class="cost">\${costCell(first)}</td>
      <td></td>
      <td class="actions"></td>
    </tr>\`);
    if (expanded) {
      for (const v of items) rowsHtml.push(buildRow(v).replace('<tr>', '<tr class="expanded-child">'));
    }
  }
  tbl.innerHTML = \`<table><thead><tr>
    <th>Src</th><th>Make</th><th>Model</th><th>Variant</th><th>Years</th><th>Refrigerant</th><th>Charge</th><th>Cost</th><th>Notes</th><th></th>
  </tr></thead><tbody>\${rowsHtml.join('')}</tbody></table>\`;
}

function toggleGroup(key) {
  if (expandedGroups.has(key)) expandedGroups.delete(key);
  else expandedGroups.add(key);
  render();
}
function openAdd() {
  document.getElementById('modal-title').textContent = 'Add vehicle';
  document.getElementById('form').reset();
  document.getElementById('f-id').value = '';
  document.getElementById('f-refrig').value = 'R134a';
  document.getElementById('modal').classList.add('open');
  setTimeout(() => document.getElementById('f-make').focus(), 50);
}
function openEdit(id) {
  const v = currentRows.find(x => x.id === id);
  if (!v) return;
  document.getElementById('modal-title').textContent = 'Edit vehicle #' + id;
  document.getElementById('f-id').value = v.id;
  document.getElementById('f-make').value = v.make;
  document.getElementById('f-model').value = v.model;
  document.getElementById('f-ys').value = v.year_start;
  document.getElementById('f-ye').value = v.year_end;
  document.getElementById('f-variant').value = v.variant || '';
  document.getElementById('f-refrig').value = v.refrigerant;
  document.getElementById('f-charge').value = v.charge_g;
  document.getElementById('f-notes').value = v.notes || '';
  document.getElementById('modal').classList.add('open');
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
async function submitForm(e) {
  e.preventDefault();
  const id = document.getElementById('f-id').value;
  const body = {
    make: document.getElementById('f-make').value,
    model: document.getElementById('f-model').value,
    year_start: document.getElementById('f-ys').value,
    year_end: document.getElementById('f-ye').value,
    variant: document.getElementById('f-variant').value,
    refrigerant: document.getElementById('f-refrig').value,
    charge_g: document.getElementById('f-charge').value,
    notes: document.getElementById('f-notes').value,
  };
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await fetch(API + (id ? '&id=' + id : ''), {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'save failed');
    flash(id ? 'Updated' : 'Added', true);
    closeModal();
    await load();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}
async function del(id) {
  const v = currentRows.find(x => x.id === id);
  if (!v) return;
  if (!confirm('Delete ' + v.make + ' ' + v.model + ' (' + v.year_start + '-' + v.year_end + ')?')) return;
  try {
    const r = await fetch(API + '&id=' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error || 'delete failed');
    flash('Deleted', true);
    await load();
  } catch (err) { flash(err.message, false); }
}
loadPrices().then(load);
</script>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

async function vehiclesApi(req, env) {
  if (!env.DB) return jsonResponse({ error: 'D1 binding missing' }, 500);
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const yearParam = url.searchParams.get('year');
    const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;
    const where = [];
    const binds = [];
    // Tokenise the text query: each whitespace/hyphen-separated piece must
    // appear somewhere in make/model/variant. Lets "cx-5" match "CX5" and
    // "mazda cx 5" match a Mazda CX5 row.
    const tokens = q.split(/[\s\-_/]+/).filter(Boolean);
    for (const t of tokens) {
      const like = `%${t.replace(/[%_]/g, '\\$&')}%`;
      where.push('(make LIKE ? COLLATE NOCASE OR model LIKE ? COLLATE NOCASE OR variant LIKE ? COLLATE NOCASE)');
      binds.push(like, like, like);
    }
    if (year !== null) {
      where.push('(? BETWEEN year_start AND year_end)');
      binds.push(year);
    }
    const sql = `SELECT * FROM vehicles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
      `ORDER BY make COLLATE NOCASE, model COLLATE NOCASE, year_start`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return jsonResponse({ vehicles: results });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const errors = validateVehicle(body);
    if (errors.length) return jsonResponse({ error: errors.join('; ') }, 400);
    const v = normalizeVehicle(body);
    const now = Math.floor(Date.now() / 1000);
    const { meta } = await env.DB.prepare(
      `INSERT INTO vehicles (make, model, year_start, year_end, variant, refrigerant, charge_g, notes, updated_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
    ).bind(v.make, v.model, v.year_start, v.year_end, v.variant, v.refrigerant, v.charge_g, v.notes, now).run();
    return jsonResponse({ id: meta.last_row_id, ok: true });
  }

  if (req.method === 'PUT') {
    if (!id) return jsonResponse({ error: 'id required' }, 400);
    const body = await req.json();
    const errors = validateVehicle(body);
    if (errors.length) return jsonResponse({ error: errors.join('; ') }, 400);
    const v = normalizeVehicle(body);
    const now = Math.floor(Date.now() / 1000);
    // Admin-initiated edits bump the row to 'manual' source — Andy's edit
    // is more trustworthy than the imported data it overwrites.
    await env.DB.prepare(
      `UPDATE vehicles SET make=?, model=?, year_start=?, year_end=?, variant=?, refrigerant=?, charge_g=?, notes=?, updated_at=?, source='manual'
       WHERE id=?`
    ).bind(v.make, v.model, v.year_start, v.year_end, v.variant, v.refrigerant, v.charge_g, v.notes, now, Number(id)).run();
    return jsonResponse({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!id) return jsonResponse({ error: 'id required' }, 400);
    await env.DB.prepare(`DELETE FROM vehicles WHERE id = ?`).bind(Number(id)).run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'method not allowed' }, 405);
}

// Compact helper used by the print page: take structured vehicle fields and
// return a short gas-suggestion string like '500g' or '500g or 580g'.
// Returns '' when there are no structured fields or no DB match.
async function suggestGasFor(env, { make, model, year, variant }) {
  if (!env.DB || !make || !model || !year) return '';
  const y = Number(year);
  if (!Number.isInteger(y)) return '';
  try {
    const { results } = await env.DB.prepare(
      `SELECT charge_g, variant FROM vehicles
         WHERE make = ? COLLATE NOCASE
           AND model = ? COLLATE NOCASE
           AND ? BETWEEN year_start AND year_end
         ORDER BY CASE WHEN variant = ? COLLATE NOCASE THEN 0
                       WHEN variant = ''                 THEN 1
                       ELSE 2 END`
    ).bind(make, model, y, variant || '').all();
    if (!results.length) return '';
    // If variant was specified and we got exact match (ordered first), return that only
    if (variant && results[0].variant && results[0].variant.toLowerCase() === variant.toLowerCase()) {
      return `${results[0].charge_g}g`;
    }
    const uniq = Array.from(new Set(results.map(r => r.charge_g))).sort((a,b) => a-b);
    if (uniq.length === 1) return `${uniq[0]}g`;
    return uniq.slice(0, 3).map(g => `${g}g`).join(' or ');
  } catch (e) {
    console.error('suggestGasFor failed', e);
    return '';
  }
}

async function vehicleLookup(params, env) {
  if (!env.DB) return jsonResponse({ error: 'D1 binding missing' }, 500);
  const make = (params.get('make') || '').trim();
  const model = (params.get('model') || '').trim();
  const year = Number(params.get('year'));
  const variant = (params.get('variant') || '').trim();
  if (!make || !model || !Number.isInteger(year)) {
    return jsonResponse({ error: 'make, model, year required' }, 400);
  }
  // Priority:
  //  1. source: manual > nissens > cooldrive
  //  2. variant: exact match > empty (catch-all) > other
  //  3. newest year_start first
  const { results } = await env.DB.prepare(
    `SELECT * FROM vehicles
       WHERE make = ? COLLATE NOCASE
         AND model = ? COLLATE NOCASE
         AND ? BETWEEN year_start AND year_end
       ORDER BY CASE source
                  WHEN 'manual'    THEN 0
                  WHEN 'nissens'   THEN 1
                  WHEN 'hychill'   THEN 2
                  WHEN 'cooldrive' THEN 3
                  ELSE 4 END,
                CASE WHEN variant = ? COLLATE NOCASE THEN 0
                     WHEN variant = ''                 THEN 1
                     ELSE 2 END,
                year_start DESC`
  ).bind(make, model, year, variant).all();
  return jsonResponse({ match: results[0] || null, candidates: results });
}

async function findTomorrowBookings(env, cfg, { skipToday = false, offset = 1, target = null } = {}) {
  const cal = await calendarUrl(env);
  const today = todayInTz(cfg.tz);
  let t;
  if (target) {
    t = target;
  } else {
    const tom = new Date(today.y, today.m - 1, today.d + offset);
    t = { y: tom.getFullYear(), m: tom.getMonth() + 1, d: tom.getDate() };
  }
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

  await bark(env, title, body, '', '', '', env.BARK_GROUP_CUSTOMER || 'Customers'); // 客人消息：单独分组
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
  const endMs = startMs + defaultMs;
  return {
    start: naive(startMs), end: naive(endMs),
    label: `${d}/${m} ${WD_LONG[dowOf(date)]} ${start.h % 12 || 12}${start.min ? `:${pad(start.min)}` : ''}${start.h < 12 ? 'am' : 'pm'}`,
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

async function findBookingsByPhone(phone, env, cfg) {
  const digits = phone.replace(/[^\d]/g, '');
  const core = digits.startsWith('61') ? digits.slice(2) : digits.startsWith('0') ? digits.slice(1) : digits;
  const variants = [phone, digits, core, '0' + core, '61' + core, '+61' + core];

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
    const searchText = (e.description || '') + ics;
    if (!variants.some(v => v && searchText.includes(v))) continue;
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
  for (const [k, v] of Object.entries(x || {})) {
    if (!v) continue;
    // Keys starting with 'X-' are passed through; otherwise add X-FB- prefix
    const key = /^X-/i.test(k) ? k.toUpperCase() : `X-FB-${k.toUpperCase()}`;
    L.push(`${key}:${icsEsc(v)}`);
  }
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
    veh_make: val('X-VEH-MAKE'), veh_model: val('X-VEH-MODEL'), veh_year: val('X-VEH-YEAR'), veh_variant: val('X-VEH-VARIANT'),
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

// 把手机号（0412345678 或 +61412345678）转成 sms:// 深链接
function smsLink(mobile) {
  if (!mobile) return '';
  const digits = mobile.replace(/[^\d+]/g, '');
  if (!digits) return '';
  const e164 = digits.startsWith('+') ? digits : '+61' + digits.replace(/^0/, '');
  return `sms://${e164}`;
}

function barkTimeLink(timeLabel, env = {}) {
  if (!timeLabel || !env.SHORTCUT_NAME) return '';
  return `shortcuts://run-shortcut?name=${encodeURIComponent(env.SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(timeLabel)}`;
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
function barkBooking(env, title, body, link, copy) {
  return bark(env, title, body, link, copy, env.BARK_SOUND_BOOKING);
}

async function bark(env, title, body, link, copy, sound, group) {
  const urls = (env.BARK_URL || '').split(/[,\s]+/).map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!urls.length) return;
  const path = `/${encodeURIComponent(title)}/${encodeURIComponent(String(body || ' ').slice(0, 1500))}`;
  let query = `?group=${encodeURIComponent(group || env.BARK_GROUP || 'Bookings')}`;
  if (link) query += `&url=${encodeURIComponent(link)}`;
  if (copy) query += `&copy=${encodeURIComponent(copy)}`;
  if (sound) query += `&sound=${encodeURIComponent(sound)}`;
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
