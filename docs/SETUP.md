# 设置步骤（从零开始）

系统已经在运作。这份文件用在：重新部署、换一个 Apple ID、换一个专页，或者交给别人接手时照着重建。

需要准备的账号：Facebook 专页（管理员权限）、Meta 开发者账号、Cloudflare 账号、GitHub 账号、开启了双重认证的 Apple ID、装了 Bark 的 iPhone。

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

## 4. Cloudflare Worker

Worker 名称是 `fb-booking-andy-auto`，连接这个 GitHub 仓库自动部署：

1. Cloudflare 后台 → Workers & Pages → Create → 导入 GitHub 仓库 `fb-booking-andy-auto`。
2. 部署设置使用仓库里的 `wrangler.jsonc`，入口是 `worker.js`。
3. 之后每次提交到 GitHub，Cloudflare 会自动 Build 并部署，状态显示 **Ready** 就生效。

`wrangler.jsonc` 里的 `"keep_vars": true` 很重要：它让每次部署时保留后台填的变量。删掉的话，部署后普通变量会被清空。

### 变量（Settings → Variables and Secrets）

**必填**

| 名称 | 类型 | 内容 |
|---|---|---|
| `VERIFY_TOKEN` | Secret | 自己编一串字符。Meta 验证 webhook 用，也是 `/check` 检查页的密码 |
| `APP_SECRET` | Secret | Meta App 的 App Secret（App 设置 → 基本资料） |
| `PAGE_ACCESS_TOKEN` | Secret | 专页访问令牌，用来查客人名字和对话链接 |
| `ICLOUD_USER` | 普通 | Apple ID 邮箱 |
| `ICLOUD_APP_PASSWORD` | Secret | 第 2 步的 App 专用密码 |
| `ICLOUD_CALENDAR` | 普通 | 日历名称，例如 `Andy Auto AC Regas`。不填的话默认找 `客人预约` |
| `BARK_URL` | Secret | 一个或多个 Bark 网址，用逗号隔开 |
| `LINK_TEMPLATE` | 普通 | 对话链接模板，见下面说明 |

**选填**

| 名称 | 默认 | 作用 |
|---|---|---|
| `FORWARD_INCOMING` | 关 | 设成 `true` 时，客人发来的消息也推送 Bark（Messenger 通知不稳定时的备用） |
| `DEFAULT_MINUTES` | `90` | 没写结束时间时的预约时长（分钟） |
| `TIMEZONE` | `Australia/Brisbane` | 时区 |
| `BARK_GROUP` | `Bookings` | Bark 里的分组名称 |
| `LINK_DIRECT` | 关 | 设成 `true` 时，通知和日历里的链接直接指向 Facebook，不经过 Worker 中转 |
| `ICLOUD_CALENDAR_URL` | 自动 | 直接指定日历网址。一般不用填，Worker 会按名称自动找 |
| `GRAPH_VERSION` | `v23.0` | Meta Graph API 版本 |
| `ANTHROPIC_API_KEY` | 不用 | 填了的话，时间格式看不懂时会请 AI 帮忙解析确认消息 |
| `AI_MODEL` | `claude-haiku-5-5` | 上面那个功能用的模型 |

### LINK_TEMPLATE

点 Bark 通知或日历事件里的链接时，要打开的对话网址。可以用的占位符：

- `{psid}`：客人编号
- `{conv}`：对话编号（`t_` 后面的数字）
- `{linkid}`：收件箱链接里 `/inbox/` 后面的数字
- `{fblink}`：Meta 提供的完整对话链接

做法：在 Business Suite 打开任何一个客人的对话，复制网址，把里面客人编号的部分换成 `{psid}`。例如：

```
https://business.facebook.com/latest/inbox/all?selected_item_id={psid}
```

链接默认经过 Worker 的 `/go` 中转，在 iPhone 上比较容易正确打开 Facebook。

## 5. Meta App 和 Webhook

1. 在 developers.facebook.com 的 App 里加入 **Messenger** 产品，连接专页。
2. Webhooks 设置：
   - 回调网址：Worker 的网址（例如 `https://fb-booking-andy-auto.<账号>.workers.dev/`）
   - 验证令牌：跟 `VERIFY_TOKEN` 一样
3. 订阅栏位勾选 **`messages`** 和 **`message_echoes`**。少了 `message_echoes`，Worker 收不到你们发出的消息，什么都不会发生。
4. 一个 App 只能设一个回调网址。如果以前有别的 Worker 在接收（例如旧的 Bark 通知 Worker），可以由这个 Worker 取代它，并把 `FORWARD_INCOMING` 设成 `true`。

## 6. 检查和测试

1. 浏览器打开 `https://<worker 网址>/check?token=<VERIFY_TOKEN>`，应该看到：
   ```
   ✅ Signed in to iCloud.
   ✅ Found "Andy Auto AC Regas". Bookings will be saved there.
   ```
2. 用个人 Facebook 账号给专页发一条消息，然后在 Business Suite 的这个对话里依次发：
   ```
   ✅ Booking confirmed – Andy Auto AC Regas
   Service: Test
   Price: $1
   Time: tomorrow 10am
   Address: Test address
   ```
   ```
   🔄 Booking updated – Andy Auto AC Regas
   Time: tomorrow 2pm
   ```
   ```
   ❌ Booking cancelled – Andy Auto AC Regas
   Your booking for tomorrow has been cancelled.
   ```
3. 每一步都应该收到 Bark 通知，日历也跟着变。
