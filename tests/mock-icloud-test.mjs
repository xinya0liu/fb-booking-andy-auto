/**
 * 本地测试：用一个模拟的 iCloud 日历跑一遍 worker.js 的完整流程。
 * 不会连接真正的 iCloud、Facebook 或 Bark，也不需要任何密码。
 *
 * 用法（需要 Node.js 18 以上）：
 *   node tests/mock-icloud-test.mjs
 *
 * 改完 worker.js 之后、提交到 GitHub 之前跑一次，全部显示 ✓ 才提交。
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// worker.js 是 ES module，先复制成 .mjs 再载入（这样仓库里不需要 package.json）
const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'fbw-')), 'worker.mjs');
writeFileSync(tmp, readFileSync(join(here, '..', 'worker.js')));
const worker = (await import(pathToFileURL(tmp).href)).default;

// ---------- 模拟的外部服务 ----------
const USER = 'test@example.com', PASS = 'aaaa-bbbb-cccc-dddd';
const HOME = 'https://p01-caldav.icloud.com/1000/calendars/';
const CAL = HOME + 'CAL-1/';
const store = new Map();
let etagN = 1;
let barks = [];
let sentToCustomer = [], echoes = [], aiPrompts = [], sendFails = false, aiReply = {};

const multistatus = x => new Response(`<?xml version="1.0"?><multistatus xmlns="DAV:">${x}</multistatus>`, { status: 207 });
const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

globalThis.fetch = async (input, opt = {}) => {
  const url = String(input);
  const method = opt.method || 'GET';
  const h = opt.headers || {};

  if (url.startsWith('https://api.day.app/')) {
    const [title, body] = url.split('?')[0].split('/').slice(4).map(decodeURIComponent);
    barks.push({ title, body });
    return new Response('ok');
  }
  if (url.includes('graph.facebook.com/v23.0/me/messages')) {
    const j = JSON.parse(opt.body);
    sentToCustomer.push(j);
    if (sendFails) return Response.json({ error: { message: 'Outside of allowed window' } });
    // 真实情况下 Meta 会把这条消息回传给 Worker（带 metadata），这里也模拟一次
    echoes.push({ sender: { id: 'PAGE' }, recipient: j.recipient, message: { is_echo: true, mid: 'echo-' + sentToCustomer.length, text: j.message.text, metadata: j.message.metadata } });
    return Response.json({ message_id: 'm' });
  }
  if (url.includes('/me/conversations') && url.includes('fields=id&')) return Response.json({ data: [{ id: 't_123' }] });
  if (url.includes('/t_123/messages')) {
    const now = Date.now();
    const at = mins => new Date(now - mins * 60000).toISOString().replace('Z', '+0000');
    return Response.json({ data: [ // Meta 是新的在前
      { message: 'Booking confirmed', from: { id: 'PAGE' }, created_time: at(0) },
      { message: 'Sunday 7pm works', from: { id: '111' }, created_time: at(5) },
      { message: 'Thanks. Address is 3 Molly Court Eagleby, mobile 0438 407 598', from: { id: '111' }, created_time: at(10) },
      { message: 'It would be $150. Call Andy on 0478 701 289', from: { id: 'PAGE' }, created_time: at(20) },
      { message: 'Hi, how much for an AC check on a 2015 Mazda 3? Not cold', from: { id: '111' }, created_time: at(30) },
    ] });
  }
  if (url.includes('graph.facebook.com')) return Response.json({ first_name: 'Test', last_name: 'Customer' });
  if (url.startsWith('https://api.anthropic.com/')) {
    aiPrompts.push(JSON.parse(opt.body).messages[0].content);
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(aiReply) }] });
  }

  if (h.authorization !== 'Basic ' + btoa(`${USER}:${PASS}`)) return new Response('unauthorized', { status: 401 });
  if (method === 'PROPFIND' && url === 'https://caldav.icloud.com/') {
    return multistatus(`<response><href>/</href><propstat><prop><current-user-principal><href>/1000/principal/</href></current-user-principal></prop></propstat></response>`);
  }
  if (method === 'PROPFIND' && url === 'https://caldav.icloud.com/1000/principal/') {
    return multistatus(`<response><href>/1000/principal/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">https://p01-caldav.icloud.com:443/1000/calendars/</href></calendar-home-set></prop></propstat></response>`);
  }
  if (method === 'PROPFIND' && url === HOME) {
    const cal = (id, name) => `<response><href>/1000/calendars/${id}/</href><propstat><prop><displayname>${name}</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop></propstat></response>`;
    return multistatus(`<response><href>/1000/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>` +
      cal('home', 'Home') + cal('CAL-1', 'Andy Auto AC Regas'));
  }
  if (method === 'REPORT' && url === CAL) {
    let x = '';
    for (const [k, v] of store) {
      x += `<response><href>${new URL(k).pathname}</href><propstat><prop><getetag>${v.etag}</getetag>` +
        `<calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${xmlEsc(v.ics)}</calendar-data></prop></propstat></response>`;
    }
    return multistatus(x);
  }
  if (method === 'PUT' && url.startsWith(CAL)) {
    if (h['if-none-match'] === '*' && store.has(url)) return new Response(null, { status: 412 });
    if (h['if-match'] && store.get(url)?.etag !== h['if-match']) return new Response(null, { status: 412 });
    store.set(url, { ics: opt.body, etag: `"e${etagN++}"` });
    return new Response(null, { status: 201 });
  }
  if (method === 'DELETE' && url.startsWith(CAL)) {
    return new Response(null, { status: store.delete(url) ? 204 : 404 });
  }
  return new Response('unexpected request: ' + method + ' ' + url, { status: 400 });
};

const env = {
  VERIFY_TOKEN: 'verify', ICLOUD_USER: USER, ICLOUD_APP_PASSWORD: PASS, ICLOUD_CALENDAR: 'Andy Auto AC Regas',
  BARK_URL: 'https://api.day.app/KEY1,https://api.day.app/KEY2', PAGE_ACCESS_TOKEN: 'x',
  LINK_TEMPLATE: 'https://business.facebook.com/latest/inbox/all?selected_item_id={psid}',
};

async function deliver(messaging) {
  const jobs = [];
  const body = { object: 'page', entry: [{ messaging: [messaging] }] };
  await worker.fetch(new Request('https://worker.test/', { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil: p => jobs.push(p) });
  await Promise.all(jobs);
}
async function send(text, mid, psid = '111') {
  const jobs = [];
  const body = { object: 'page', entry: [{ messaging: [{ sender: { id: 'PAGE' }, recipient: { id: psid }, message: { is_echo: true, mid, text } }] }] };
  await worker.fetch(new Request('https://worker.test/', { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil: p => jobs.push(p) });
  await Promise.all(jobs);
}
const events = () => [...store.values()].map(v => v.ics.replace(/\r\n[ \t]/g, ''));
const prop = (ics, name) => {
  const m = ics.match(new RegExp(`^${name}[;:].*$`, 'm'));
  return m ? m[0].slice(m[0].indexOf(':') + 1).replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1') : '';
};
const inDays = n => {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date()).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCDate()}/${t.getUTCMonth() + 1}`;
};
const ok = msg => console.log('✓ ' + msg);

// ---------- 测试 ----------

{
  const r = await worker.fetch(new Request('https://worker.test/check?token=verify'), env, {});
  const t = await r.text();
  assert.equal(r.status, 200, t);
  assert.match(t, /Found "Andy Auto AC Regas"/);
  ok('/check 检查页能登录并找到日历');
}

const confirm = `✅ Booking confirmed – Andy Auto AC Regas
Service: Car AC regas
Price: $150
Time: tomorrow 10am
Address: 56 Smith St, Eagleby
Mobile: 0412 345 678

Any changes, reply here or call Andy on 0478 701 289. See you then!`;

{
  await send(confirm, 'mid-1');
  assert.equal(store.size, 1);
  const e = events()[0];
  assert.match(prop(e, 'UID'), /-111@fb-booking$/);
  assert.equal(prop(e, 'SUMMARY'), 'Test Customer – Car AC regas $150');
  assert.equal(prop(e, 'LOCATION'), '56 Smith St, Eagleby');
  assert.match(prop(e, 'DESCRIPTION'), /Mobile: 0412 345 678/);
  assert.doesNotMatch(prop(e, 'DESCRIPTION'), /0478/);
  assert.match(prop(e, 'URL'), /selected_item_id%3D111/);
  assert.equal(barks.length, 2); // 两个 Bark 都收到
  assert.match(barks[0].title, /Booking added/);
  ok('确认：建立事件，备注不含商家电话，两个 Bark 都收到');
}

{
  barks = [];
  await send(confirm, 'mid-1');
  assert.equal(store.size, 1);
  assert.equal(barks.length, 0);
  ok('Meta 重复推送同一条消息不会重复建立');
}

{
  await send(`Booking confirmed\nService: Leak test\nPrice: $90\nTime: day after tomorrow 2-4pm\nAddress: 1 Long Rd`, 'mid-2');
  assert.equal(store.size, 2);
  ok('同一位客人可以有第二个预约');
}

{
  barks = [];
  await send(`🔄 Booking updated – Andy Auto AC Regas\nPrice: $200\nMobile: 0499 999 999`, 'mid-3');
  const e = events().find(x => prop(x, 'SUMMARY').includes('regas'));
  assert.equal(prop(e, 'SUMMARY'), 'Test Customer – Car AC regas $200');
  const notes = prop(e, 'DESCRIPTION');
  assert.match(notes, /^Updated: Price, Mobile/);
  assert.match(notes, /Mobile: 0499 999 999/);
  assert.doesNotMatch(notes, /0412/);
  assert.match(barks[0].title, /Booking updated/);
  ok('修改价格和电话：标题更新，备注里的旧值被替换');
}

{
  await send(`Booking updated\nTime: 3pm`, 'mid-4');
  const e = events().find(x => prop(x, 'SUMMARY').includes('regas'));
  assert.match(prop(e, 'DESCRIPTION'), /Time: \w{3} \d+\/\d+ 15:00/);
  ok('只改时间（保留日期）：备注里的 Time 行更新');
}

{
  barks = [];
  await send(`❌ Booking cancelled – Andy Auto AC Regas\nYour booking for ${inDays(2)} 2pm has been cancelled.`, 'mid-5');
  assert.equal(store.size, 1);
  assert.ok(events()[0].includes('regas'), '应该删掉的是第二个预约');
  assert.match(barks[0].title, /Booking cancelled/);
  ok('取消：按消息里的日期取消正确的那一个');
}

{
  barks = [];
  await send(`Booking cancelled`, 'mid-6', '999');
  assert.match(barks[0].title, /Booking not found/);
  ok('别的客人对话里取消：提示找不到，不会误删');
}

{
  barks = [];
  await send(`Booking confirmed\nService: x\nTime: whenever`, 'mid-7');
  assert.match(barks[0].title, /Booking not saved/);
  ok('时间看不懂：推送“Booking not saved”提醒');
}

{
  const r = await worker.fetch(new Request('https://worker.test/check?token=verify'), { ...env, ICLOUD_APP_PASSWORD: 'wrong' }, {});
  assert.match(await r.text(), /401/);
  ok('密码错误时检查页会显示 401 提示');
}

// ---------- 一键确认（从对话整理） ----------
store.clear();
const aiEnv = { ANTHROPIC_API_KEY: 'test-key' };
Object.assign(env, aiEnv);
const nextSunday = (() => {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date()).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); const add = ((7 - t.getUTCDay()) % 7) || 7;
  const s = new Date(t.getTime() + add * 864e5);
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`;
})();

{
  barks = []; sentToCustomer = []; echoes = []; aiPrompts = [];
  aiReply = { date: nextSunday, start: '19:00', end: '', service: 'Car AC check', price: '$150', address: '3 Molly Court Eagleby', mobile: '0438 407 598', vehicle: '2015 Mazda 3', notes: 'AC not cold' };
  await send('Booking confirmed', 'mid-ai-1');
  assert.equal(store.size, 1);
  const e = events()[0];
  assert.equal(prop(e, 'SUMMARY'), 'Test Customer – Car AC check $150');
  assert.equal(prop(e, 'LOCATION'), '3 Molly Court Eagleby');
  const notes = prop(e, 'DESCRIPTION');
  assert.match(notes, /^Auto-filled from chat/);
  assert.match(notes, /Mobile: 0438 407 598/);
  assert.match(notes, /Vehicle: 2015 Mazda 3/);
  assert.match(aiPrompts[0], /Customer: Hi, how much for an AC check/); // 对话按时间先后交给 AI
  assert.ok(aiPrompts[0].indexOf('Mazda') < aiPrompts[0].indexOf('Sunday 7pm'));
  assert.equal(sentToCustomer.length, 1);
  const msg = sentToCustomer[0].message.text;
  assert.match(msg, /^✅ Booking details – Andy Auto AC Regas/);
  assert.match(msg, /Time: Sunday \d+\/\d+, 7:00pm/);
  assert.doesNotMatch(msg, /AC not cold/); // 内部备注不发给客人
  assert.match(barks[0].body, /Confirmation sent/);
  ok('一键确认：从对话整理资料、写入日历、自动回复客人');

  barks = [];
  await deliver(echoes[0]);
  assert.equal(store.size, 1);
  assert.equal(barks.length, 0);
  ok('自动回复的消息回传时不会再次触发');
}

{
  barks = []; sentToCustomer = [];
  await send('Booking confirmed', 'mid-ai-1');
  assert.equal(sentToCustomer.length, 0);
  ok('Meta 重复推送：不会重复建立，也不会重复发消息给客人');
}

{
  store.clear(); barks = []; sentToCustomer = [];
  await send('Booking confirmed\nTime: Saturday 9am\nPrice: $120', 'mid-ai-2');
  const e = events()[0];
  assert.equal(prop(e, 'SUMMARY'), 'Test Customer – Car AC check $120');
  assert.match(prop(e, 'DESCRIPTION'), /Time: Sat \d+\/\d+ 09:00/);
  assert.match(sentToCustomer[0].message.text, /Time: Saturday \d+\/\d+, 9:00am/);
  ok('一键确认时自己写的 Time:、Price: 优先于 AI');
}

{
  store.clear(); barks = []; sendFails = true;
  await send('Booking confirmed', 'mid-ai-3');
  assert.equal(store.size, 1);
  assert.match(barks[0].body, /NOT sent[\s\S]*Booking details/);
  sendFails = false;
  ok('发消息失败：仍然写入日历，Bark 附上消息让你手动发');
}

{
  store.clear(); barks = [];
  aiReply = { date: '', start: '', service: 'Car AC check', price: '', address: '', mobile: '', vehicle: '', notes: '' };
  await send('Booking confirmed', 'mid-ai-4');
  assert.equal(store.size, 0);
  assert.match(barks[0].title, /Booking not saved/);
  assert.match(barks[0].body, /Add a Time: line/);
  ok('对话里找不到时间：不建立预约，提醒补上 Time:');
}

{
  barks = [];
  delete env.ANTHROPIC_API_KEY;
  await send('Booking confirmed', 'mid-ai-5');
  assert.match(barks[0].body, /ANTHROPIC_API_KEY/);
  ok('没有设置 ANTHROPIC_API_KEY 时会提示');
}

console.log('\n全部通过 ✅');
