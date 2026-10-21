# 维护指南

## 平时需要做什么

基本上不用管。只要养成两个习惯：

1. **每次发模板后看一眼 Bark 通知。** 收到 ⚠️ 就处理，不要等到当天才发现日历没有那个客人。
2. **偶尔打开检查页**（例如每个月一次，或者觉得怪怪的时候）：
   ```
   https://<worker 网址>/check?token=<VERIFY_TOKEN>
   ```

## 故障排查

先看 Bark 通知写了什么，再对照下表。

| 现象 | 可能原因 | 处理方法 |
|---|---|---|
| 发了消息，**完全没有 Bark 通知** | 开头不是五个关键词之一（例如写成 `Booking rescheduled`），或关键词不在消息最开头 | 改用已保存的回复重发 |
| 同上 | Meta 没有推送给 Worker | 检查 Meta App 的 Webhooks 是否还订阅了 `message_echoes`；回调网址是不是这个 Worker；App 是否还是 Live |
| 同上 | Bark 本身有问题 | 用浏览器打开 `https://api.day.app/<key>/测试`，看手机收不收得到 |
| `iCloud sign-in failed (401)` | 改过 Apple ID 密码，所有 App 专用密码会自动失效；或者密码被撤销 | 到 account.apple.com 重新生成 App 专用密码，更新 Cloudflare 的 `ICLOUD_APP_PASSWORD` |
| `iCloud calendar "…" not found` | 日历被改名或删除 | 检查页会列出所有日历名称，把 `ICLOUD_CALENDAR` 改成正确的名字，或重建日历 |
| `iCloud error 5xx` | iCloud 暂时出问题 | 过几分钟重发，或先手动改日历 |
| `The event was changed on another device at the same moment` | 你刚好在 iPhone 上改同一个事件 | 重发一次 |
| 通知标题是 `Customer` 而不是客人名字 | 两种查名字的方法都失败：`PAGE_ACCESS_TOKEN` 失效或权限不足 | 看 Worker 日志里 `name via …failed` 的错误；临时可以在模板加 `Name:` 行；必要时重新生成专页访问令牌 |
| 点通知或日历里的链接打不开对话 | `LINK_TEMPLATE` 格式不对，或 Facebook 改了网址格式 | 重新复制一个对话网址，按 SETUP.md 的说明更新模板 |
| `Couldn't read the date / time` | 自己写的 `Time:` 看不懂 | 改成 `Friday 30/10 10am` 这类写法重发 |
| `AI couldn't read the chat: …` | AI 服务出问题：额度用完、API Key 失效、服务暂时故障 | 看后面的原因。额度用完到 console.anthropic.com 充值；key 失效就新建一个更新 `ANTHROPIC_API_KEY`。暂时可以用 `Booked you in` / `Booking change` 手写资料 |
| `Facebook: couldn't read the messages` | 读不到对话：`PAGE_ACCESS_TOKEN` 失效或权限变了 | 重新生成专页访问令牌；暂时用 `Booked you in` / `Booking change` |
| `⚠️ AI unavailable` | 同上两种情况，但你的消息里有写资料，所以已经按你写的处理 | 自己确认日历资料，必要时手动发确认给客人 |
| `Couldn't find the booking date and time in the chat` | 对话里没有明确的时间 | 在消息后面加一行 `Time: …` 再发，或在对话里跟客人确认时间 |
| `…which is in the past` | AI 算出的时间已经过去（通常是误读） | 在消息后面加一行 `Time: …` 再发 |
| `Couldn't find any change in the chat` | 发了 `Booking updated`，但 AI 看不出改了什么 | 在消息后面加上改动的行，例如 `Time: Sunday 3pm` |
| `Confirmation NOT sent to the customer (…)` | 自动回复失败，最常见是客人超过 24 小时没发消息 | 预约已写入；复制通知里附的消息自己发 |
| 自动回复的内容不对（价格、时间抓错） | AI 误读对话 | 在对话里跟客人讲清楚正确的资料，再发 `Booking updated`；或用 `Booking change` 手动改 |
| `Booking not found` | 在别的客人的对话里发了；或那个预约已经被手动删掉；或那是手动建立的事件 | 确认对话，必要时手动改日历 |
| 日历出现两个一样的预约 | 想修改却发了 `Booking confirmed`，而且时间不同 | 删掉多的那个，之后修改要用 `Booking updated` |

### 看 Worker 的日志

Cloudflare 后台 → Workers & Pages → `fb-booking-andy-auto` → **Logs**，开始实时日志后，再发一次模板。每条处理都会印出 `confirm, psid = …` 之类的记录，出错时会印出完整的错误。

## 更换密码和令牌

所有密码都只放在 Cloudflare 后台的 Variables and Secrets 里。修改后**立即生效**，不需要重新部署。

| 要换的东西 | 什么时候 | 怎么做 |
|---|---|---|
| Apple App 专用密码 | 改了 Apple ID 密码、怀疑外泄、收到 401 | account.apple.com 生成新的 → 更新 `ICLOUD_APP_PASSWORD` → 撤销旧的 |
| `PAGE_ACCESS_TOKEN` | 名字查不到、令牌过期 | Meta 开发者后台重新生成 → 更新 |
| `APP_SECRET` | 在 Meta 重设了 App Secret | 更新，否则 Worker 会拒绝所有 Meta 推送（401 bad signature） |
| `ANTHROPIC_API_KEY` | 怀疑外泄、收到 key 无效的错误 | console.anthropic.com 新建 key → 更新 → 删除旧的 |
| `VERIFY_TOKEN` | 很少需要 | 改了的话，Meta 的 Webhook 设置也要改成一样 |
| Bark key | 换手机、加人、减人 | 更新 `BARK_URL`（逗号隔开） |

## 修改代码

本地仓库位置：`/Users/liuxinya/Projects/fb-booking-andy-auto`

1. 先拉最新版本：
   ```bash
   cd /Users/liuxinya/Projects/fb-booking-andy-auto
   git pull
   ```
2. 修改 `worker.js`（自己改，或用 Claude Code 打开这个文件夹让它改）。
3. **提交前先跑本地测试**（需要 Node.js 18 以上，不需要任何密码）：
   ```bash
   node tests/mock-icloud-test.mjs
   ```
   最后显示“全部通过 ✅”才提交。改了功能的话，也在测试文件里加对应的测试。
4. 提交并推送：
   ```bash
   git add worker.js tests
   git commit -m "说明这次改了什么"
   git push
   ```
5. Cloudflare 会自动 Build，状态变成 **Ready** 就生效。
6. 用朋友的对话实际测一次，看 Bark、日历和自动回复。

请 AI 帮忙改代码时，把这个仓库的 `README.md`、`docs/HISTORY.md` 和 `worker.js` 一起给它，它就能了解整个系统的来龙去脉。

### worker.js 的结构

| 区块 | 作用 |
|---|---|
| `export default { fetch }` | 入口：`/go` 链接中转、`/check` 检查页、Meta webhook 验证与接收 |
| `onPageMessage` / `detectAction` | 看消息开头，判断是哪一种操作、要不要用 AI |
| `doConfirm` / `doUpdate` / `doCancel` | 三种操作的入口；包含“AI 失败时改用消息内容”的后备 |
| `doConfirmFromChat` / `doUpdateFromChat` | AI 模式：读对话、整理、写日历、自动回复客人 |
| `readConversation` / `aiFromChat` | 从 Facebook 读对话；请 AI 用固定格式（工具调用 `save_booking`）回传资料 |
| `customerMessage` / `sendToCustomer` | 组合并发送给客人的确认消息 |
| `saveNewBooking` / `applyUpdate` | 写入新预约 / 套用修改（两种模式共用） |
| `findOverlaps` / `assertFuture` | 撞时间检查、时间已过检查 |
| `readFields` / `extraFields` / `mergeNotes` | 读取消息里的栏位、整理备注 |
| `parseDate` / `parseWhenParts` / `parseClock` / `buildTimes` | 读懂各种时间写法 |
| iCloud 日历（CalDAV）区块 | 登录、找日历、查询、写入、修改、删除事件 |
| iCalendar 区块 | 产生和修改 .ics 事件内容 |
| Meta / 链接 / Bark 区块 | 查客人名字（查不到就从对话参与者找）、产生对话链接、推送通知 |

### 几个设计上的重点（改代码时不要破坏）

- **客人编号存在事件的 UID 里**（格式 `<hash>-<psid>@fb-booking`），另外也存在隐藏栏位 `X-FB-PSID`。修改和取消就是靠它找到预约。UID 在 iPhone 上手动改事件也不会变。
- **防重复**：UID 由 Meta 的消息编号算出来，写入时带 `If-None-Match: *`，Meta 重复推送同一条消息也不会建出两个事件。
- **修改事件只换掉指定的栏位**，其他内容（例如在 iPhone 上加的提醒）原样保留；写入时带 `If-Match`，避免覆盖同时在别处做的修改。
- **只处理自己建立的事件**：没有客人编号的事件（手动建立的）不会被修改或删除。
- 旧事件的后备：备注里有 `Customer ID: <psid>` 的事件也找得到。
- **关键词只看消息开头**（`detectAction`）。聊天中间出现的不算，避免误触发。
- **Worker 发给客人的消息带 `metadata: "fb-booking"`**，Meta 回传时会被跳过；自动消息的第一行也不能以五个关键词开头。这两道防线避免自己触发自己。
- **AI 用工具调用回传资料**（`tool_choice` 强制使用 `save_booking`），不会回一段自由文字导致解析失败。
- **你写的栏位永远优先于 AI**；AI 或读对话失败时（`serviceError`），消息里有写栏位就照写的处理。
- **修改时只套用有变的栏位**：AI 回传的是“现在应该是什么”，程序跟日历上的资料比较后才写入。

## 回滚

新版本有问题时，任选一种：

- **Cloudflare**：Workers & Pages → `fb-booking-andy-auto` → Deployments，选上一个正常的版本回滚。最快。
- **GitHub**：在提交记录里找到上一个正常的 `worker.js`，把内容贴回去提交。这样仓库和线上保持一致。用了 Cloudflare 回滚之后，也要记得在 GitHub 做这一步，不然下次提交又会部署有问题的版本。

## 还没清理的东西

系统原本写入 Google 日历，后来改成 iCloud。确定不再回到 Google 版之后：

1. 删掉 Cloudflare 里的 `GOOGLE_SA_EMAIL`、`GOOGLE_SA_KEY`、`CALENDAR_ID`（现在的代码不会读取它们）。
2. 到 Google Cloud Console 的服务账号页面 →“密钥”分页，**删除那把 JSON 密钥**。这一步比较重要，只要密钥有效，拿到的人就能写那个 Google 日历。
3. 需要的话，在 iPhone“设置 → 日历 → 账户”关掉 Google 日历同步。

## 费用

Cloudflare Workers 免费方案、GitHub、Bark、iCloud 日历、Meta API 都不收费。

唯一的费用是 **Anthropic API**：每次发 `Booking confirmed` / `Booking updated` 会读一次对话，每单大约不到一分钱澳币，一个月几百单也只是几块钱。到 console.anthropic.com 可以看用量、设消费上限。额度用完时，Bark 会提示 `AI couldn't read the chat`，这时可以暂时用 `Booked you in` / `Booking change`。

不要在 Cloudflare 或 Google Cloud 开通付费方案或绑卡计费。

## 可能需要维护的情况

不会定期发生，遇到时处理：

1. **改了 Apple ID 密码** → App 专用密码失效（401）。
2. **专页访问令牌失效**（生成它的 Facebook 账号改密码、不再是管理员、移除了 App 授权）→ 名字变 `Customer`、读不到对话、发不了消息。
3. **Meta API 版本过期**（每个版本约支持两年）→ 在 Cloudflare 加 `GRAPH_VERSION`，填新版本号。
4. **Meta 的检查邮件**（例如年度数据使用检查）→ 照着完成，不然 App 可能被限制。
5. **换手机或重装 Bark** → key 可能会变，更新 `BARK_URL`。
6. **Facebook 改了收件箱网址格式** → 更新 `LINK_TEMPLATE`。
7. **AI 模型下架** → 在 Cloudflare 加 `AI_MODEL`，填新的模型名称。
8. **苹果改了 iCloud 日历的接口**（可能性很低）→ 代码需要调整。
