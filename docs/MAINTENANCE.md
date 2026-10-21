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
| 发了模板，**完全没有 Bark 通知** | Meta 没有推送给 Worker | 检查 Meta App 的 Webhooks 是否还订阅了 `message_echoes`；回调网址是不是这个 Worker；关键词有没有拼错 |
| 同上 | Bark 本身有问题 | 用浏览器打开 `https://api.day.app/<key>/测试`，看手机收不收得到 |
| `iCloud sign-in failed (401)` | 改过 Apple ID 密码，所有 App 专用密码会自动失效；或者密码被撤销 | 到 account.apple.com 重新生成 App 专用密码，更新 Cloudflare 的 `ICLOUD_APP_PASSWORD` |
| `iCloud calendar "…" not found` | 日历被改名或删除 | 检查页会列出所有日历名称，把 `ICLOUD_CALENDAR` 改成正确的名字，或重建日历 |
| `iCloud error 5xx` | iCloud 暂时出问题 | 过几分钟重发，或先手动改日历 |
| `The event was changed on another device at the same moment` | 你刚好在 iPhone 上改同一个事件 | 重发一次 |
| 通知标题是 `Customer` 而不是客人名字 | `PAGE_ACCESS_TOKEN` 失效或权限不足 | 重新生成专页访问令牌，更新 Cloudflare |
| 点通知或日历里的链接打不开对话 | `LINK_TEMPLATE` 格式不对，或 Facebook 改了网址格式 | 重新复制一个对话网址，按 SETUP.md 的说明更新模板 |
| `Couldn't read the date / time` | `Time:` 写法看不懂 | 改成 `Friday 30/10 10am` 这类写法重发 |
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
| `VERIFY_TOKEN` | 很少需要 | 改了的话，Meta 的 Webhook 设置也要改成一样 |
| Bark key | 换手机、加人、减人 | 更新 `BARK_URL`（逗号隔开） |

## 修改代码

1. 在 GitHub 上编辑 `worker.js`（或在电脑上改好再提交）。
2. **提交前先跑本地测试**（需要 Node.js 18 以上，不需要任何密码）：
   ```
   node tests/mock-icloud-test.mjs
   ```
   全部显示 ✓ 才提交。
3. 提交后，Cloudflare 会自动 Build，状态变成 **Ready** 就生效。
4. 用个人 Facebook 账号发一次测试确认，看 Bark 和日历。

请 AI 帮忙改代码时，把这个仓库的 `README.md`、`docs/HISTORY.md` 和 `worker.js` 一起给它，它就能了解整个系统的来龙去脉。

### worker.js 的结构

| 区块 | 作用 |
|---|---|
| `export default { fetch }` | 入口：`/go` 链接中转、`/check` 检查页、Meta webhook 验证与接收 |
| `onPageMessage` / `detectAction` | 判断是确认、修改还是取消 |
| `doConfirm` / `doUpdate` / `doCancel` | 三种操作的主要逻辑 |
| `readFields` / `extraFields` / `mergeNotes` | 读取消息里的栏位、整理备注 |
| `parseDate` / `parseWhenParts` / `parseClock` / `buildTimes` | 读懂各种时间写法 |
| `aiParse` | 选用：格式看不懂时请 AI 解析 |
| iCloud 日历（CalDAV）区块 | 登录、找日历、查询、写入、修改、删除事件 |
| iCalendar 区块 | 产生和修改 .ics 事件内容 |
| Meta / 链接 / Bark 区块 | 查客人名字、产生对话链接、推送通知 |

### 几个设计上的重点（改代码时不要破坏）

- **客人编号存在事件的 UID 里**（格式 `<hash>-<psid>@fb-booking`），另外也存在隐藏栏位 `X-FB-PSID`。修改和取消就是靠它找到预约。UID 在 iPhone 上手动改事件也不会变。
- **防重复**：UID 由 Meta 的消息编号算出来，写入时带 `If-None-Match: *`，Meta 重复推送同一条消息也不会建出两个事件。
- **修改事件只换掉指定的栏位**，其他内容（例如在 iPhone 上加的提醒）原样保留；写入时带 `If-Match`，避免覆盖同时在别处做的修改。
- **只处理自己建立的事件**：没有客人编号的事件（手动建立的）不会被修改或删除。
- 旧事件的后备：备注里有 `Customer ID: <psid>` 的事件也找得到。

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

Cloudflare Workers 免费方案、Bark、iCloud 日历都不收费。Meta API 不收费。只有填了 `ANTHROPIC_API_KEY` 并真的用到 AI 解析时，才会产生很少的 API 费用。
