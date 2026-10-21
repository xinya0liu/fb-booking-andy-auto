# 设置步骤（从零开始）

系统已经在运作。这份文件用在：重新部署、换一个 Apple ID、换一个专页，或者交给别人接手时照着重建。

需要准备的账号：Facebook 专页（管理员权限）、Meta 开发者账号、Cloudflare 账号、GitHub 账号、开启了双重认证的 Apple ID、装了 Bark 的 iPhone、Anthropic 账号（AI 用）。

## 1. iCloud 日历

1. 在 iPhone 的“日历”App → 底部“日历”→“添加日历”。
2. 名称填 `Andy Auto AC Regas`（或任何名字，之后填进 `ICLOUD_CALENDAR`）。
3. 账户一定要选 **iCloud**，不要选“我的 iPhone”、Gmail 或 Hotmail。

## 2. Apple App 专用密码

iPhone 的“设置”里**没有**这个选项，只能在网页上生成。

1. 用浏览器打开 **account.apple.com**，用 Apple ID 登录。
2. “登录与安全”→“App 专用密码”→“生成 App 专用密码”，名称填 `Cloudflare Worker`。
3. 复制显示的 `xxxx-xxxx-xxxx-xxxx`。这串密码只显示一次。

找不到这个选项，通常是 Apple ID 没开双重认证。网页一直提示“到 iPhone 上继续”的话，换电脑浏览器试试。

## 3. Bark

每位要收通知的管理员：

1. 在 iPhone 安装 **Bark**，打开 App，允许通知。
2. 复制 App 首页的网址，格式是 `https://api.day.app/<key>`。
3. 用浏览器打开 `https://api.day.app/<key>/测试`，确认手机收到通知。

多个网址用逗号连起来，填进 `BARK_URL`。

## 4. Anthropic API Key（AI 整理对话用）

1. 到 console.anthropic.com 注册并登录。
2. 在 Billing 充值少量额度（最低额度就能用很久）。
3. 在 API Keys 新建一个 key，名称例如 `fb-booking`，复制下来，之后填进 `ANTHROPIC_API_KEY`。

没有这个 key 的话，`Booking confirmed` / `Booking updated` 只能照消息里写的栏位处理，不会读对话，也不会自动回复客人。

## 5. Cloudflare Worker

Worker 名称是 `fb-booking-andy-auto`，连接这个 GitHub 仓库自动部署：

1. Cloudflare 后台 → Workers & Pages → Create → 导入 GitHub 仓库 `fb-booking-andy-auto`。
2. 部署设置使用仓库里的 `wrangler.jsonc`，入口是 `worker.js`。Settings → Build 里，Production branch 要是 `main`，Deploy command 要是 `npx wrangler deploy`。
3. 之后每次提交到 GitHub，Cloudflare 会自动 Build 并部署，状态显示 **Ready** 就生效。

`wrangler.jsonc` 里的 `"keep_vars": true` 很重要：它让每次部署时保留后台填的变量。删掉的话，部署后普通变量会被清空。

### 变量（Settings → Variables and Secrets）

**必填**

| 名称 | 类型 | 内容 |
|---|---|---|
| `VERIFY_TOKEN` | Secret | 自己编一串**只有英文字母和数字的长字串**（不要用 `123` 这种容易猜的）。Meta 验证 webhook 用，也是 `/check` 检查页的密码 |
| `APP_SECRET` | Secret | Meta App 的 App Secret（App 设置 → 基本资料） |
| `PAGE_ACCESS_TOKEN` | Secret | 专页访问令牌，用来查客人名字、读对话、自动回复客人 |
| `ICLOUD_USER` | 普通 | Apple ID 邮箱 |
| `ICLOUD_APP_PASSWORD` | Secret | 第 2 步的 App 专用密码 |
| `ICLOUD_CALENDAR` | 普通 | 日历名称，例如 `Andy Auto AC Regas`。不填的话默认找 `客人预约` |
| `BARK_URL` | Secret | 一个或多个 Bark 网址，用逗号隔开 |
| `ANTHROPIC_API_KEY` | Secret | 第 4 步的 API Key。读对话、AI 整理、自动回复客人需要 |

**选填**

| 名称 | 默认 | 作用 |
|---|---|---|
| `FORWARD_INCOMING` | 关 | 设成 `true` 时，客人发来的消息也推送 Bark（Messenger 通知不稳定时的备用） |
| `DEFAULT_MINUTES` | `90` | 没写结束时间时的预约时长（分钟） |
| `TIMEZONE` | `Australia/Brisbane` | 时区 |
| `BARK_GROUP` | `Bookings` | Bark 里的分组名称 |
| `INBOX_URL` | `https://business.facebook.com/latest/inbox/all` | 客人卡片上“打开收件箱”按钮的网址 |
| `ICLOUD_CALENDAR_URL` | 自动 | 直接指定日历网址。一般不用填，Worker 会按名称自动找 |
| `GRAPH_VERSION` | `v23.0` | Meta Graph API 版本 |
| `AUTO_REPLY` | 开 | 设成 `false` 时，`Booking confirmed` / `updated` 照样整理和写日历，但不自动发消息给客人 |
| `CONFIRM_HEADER` | `✅ Booking details – Andy Auto AC Regas` | 自动确认消息的第一行。**不能**以五个开头之一开始，否则会再次触发 |
| `UPDATE_HEADER` | `🔄 Updated booking details – Andy Auto AC Regas` | 自动更新消息的第一行，同上 |
| `CONFIRM_FOOTER` | `Any changes, reply here or call Andy on 0478 701 289. See you then!` | 自动消息的最后一行 |
| `AI_MODEL` | `claude-haiku-5-5` | AI 用的模型 |

### 通知和日历里的链接

不需要设置。链接会打开 Worker 的客人卡片页面（`/c?n=客人名字`），一键复制名字并打开收件箱。旧版本用过的 `LINK_TEMPLATE`、`LINK_DIRECT` 已经不再使用，可以从变量里删除。

## 6. Meta App 和 Webhook

1. 在 developers.facebook.com 的 App 里加入 **Messenger** 产品，连接专页。App 要切换成 **Live** 模式。
2. Webhooks 设置：
   - 回调网址：Worker 的网址（例如 `https://fb-booking-andy-auto.<账号>.workers.dev/`）
   - 验证令牌：跟 `VERIFY_TOKEN` 一样
3. 订阅栏位勾选 **`messages`** 和 **`message_echoes`**。少了 `message_echoes`，Worker 收不到你们发出的消息，什么都不会发生。
4. 权限：`pages_messaging` 显示 “Ready for testing”（标准访问）就够用。只处理自己专页的消息，实测可以收到一般客人的对话、读取对话和发消息。**不要**按 “Add to App Review”：它会要求申请成为 Tech Provider，那是给帮其他商家开发软件的公司用的，而且不能撤销。
5. 一个 App 只能设一个回调网址。如果以前有别的 Worker 在接收（例如旧的 Bark 通知 Worker），可以由这个 Worker 取代它，并把 `FORWARD_INCOMING` 设成 `true`。

## 7. 检查和测试

1. 浏览器打开 `https://<worker 网址>/check?token=<VERIFY_TOKEN>`，应该看到：
   ```
   ✅ Signed in to iCloud.
   ✅ Found "Andy Auto AC Regas". Bookings will be saved there.
   ```
2. 本地测试（不需要任何密码）：`node tests/mock-icloud-test.mjs`，应该全部显示 ✓。
3. 请一位**跟 App 没有任何关系**的朋友扮演客人，按下面的对话测试（以星期四为例）：

   | 谁 | 消息 |
   |---|---|
   | 朋友 | Hi, my car AC is blowing warm air. How much for a check? It's a 2016 Toyota Camry. |
   | 你 | Hi! An AC check is $150. If it needs a regas as well it's $220 all up. |
   | 朋友 | Ok let's do the check and regas then. |
   | 你 | No worries, that'll be $220. What's your address and best contact number? |
   | 朋友 | 12 Test Street, Eagleby. My mobile is 0400 123 456 |
   | 你 | Thanks! I can do Saturday 10am or Sunday 2pm. Or call Andy on 0478 701 289 if easier. |
   | 朋友 | Saturday doesn't work, Sunday 2pm is good. Oh and the car will be in the driveway. |
   | 你 | Booking confirmed 👍 I'll send through your booking details shortly. |

   应该看到：朋友收到自动确认消息（$220、星期日 2:00pm、电话是 0400 123 456 而不是你的号码）；日历出现事件；Bark 写 “Confirmation sent”。
4. 再测修改：朋友说想改到 4pm，你回复同意后发 `Booking updated 👍 I'll send through your updated booking details shortly.`
5. 最后取消：`Booking cancelled – your booking for Sunday … 4pm has been cancelled.`
