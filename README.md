# fb-booking-andy-auto

Andy Auto AC Regas 的预约自动化。在 Facebook Messenger 回复客人时，用固定的开头（例如 `Booking confirmed`），系统就会：

- 读取这段对话，用 AI 整理出时间、服务、价格、地址、电话、车型；
- 写入、修改或删除 **iCloud（苹果）日历**里的预约；
- 自动把完整的预约资料发给客人；
- 用 **Bark** 推送结果给两位管理员（成功、失败、撞时间都会通知）。

整个系统只有一个 Cloudflare Worker（`worker.js`），不需要服务器。

## 它解决什么问题

客人的资料通常散落在好几条消息里：先问车型和价格，你报价，再给地址和电话，最后约时间。以前要自己把这些整理成确认消息、再抄进日历。现在谈好之后只要发一句 `Booking confirmed 👍 …`，剩下的都自动完成。

## 五个开头

| 开头 | 做什么 | 用 AI | 自动回复客人 |
|---|---|---|---|
| `Booking confirmed` | 新建预约，资料从对话整理 | ✅ | ✅ |
| `Booking updated` | 修改预约，从对话找出改动 | ✅ | ✅ |
| `Booked you in` | 新建预约，只照消息里写的 | ❌ | ❌ |
| `Booking change` | 修改预约，只照消息里写的 | ❌ | ❌ |
| `Booking cancelled` | 删除预约 | ❌ | ❌ |

开头前面可以有 emoji，不分大小写。聊天中间顺口打出这些词不会触发。

完整说明见 **[使用说明](docs/USER_GUIDE.md)**。

## 运作方式

```
你在 Business Suite 回复客人（开头是上面五个之一）
            │
            ▼
Meta 把“专页发出的消息”推送给 Worker（message_echoes）
            │
            ▼
Cloudflare Worker（worker.js）
  ├─ Booking confirmed / updated：读取对话 → AI 整理资料
  ├─ 写入 / 修改 / 删除 iCloud 日历里的事件（CalDAV）
  ├─ Booking confirmed / updated：用专页自动回复客人完整资料
  └─ 推送 Bark 通知给所有管理员
            │
            ▼
iPhone 日历几乎马上更新；点通知或事件里的链接，打开客人卡片，一键复制名字并打开收件箱
```

## 文件说明

| 文件 | 内容 |
|---|---|
| `worker.js` | 全部程序代码（Cloudflare Worker） |
| `wrangler.jsonc` | Cloudflare 部署设置。`keep_vars: true` 让部署时保留后台填的变量，**不要删掉** |
| `tests/mock-icloud-test.mjs` | 本地测试：用模拟的 iCloud、Facebook、AI 跑完整流程，不需要任何密码 |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | 使用说明：五个开头、常用句子、时间写法、通知的意思、常见问题 |
| [`docs/SETUP.md`](docs/SETUP.md) | 从零开始的完整设置步骤 |
| [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) | 日常维护、故障排查、更换密码、修改代码、回滚、费用 |
| [`docs/HISTORY.md`](docs/HISTORY.md) | 建立原因、过程、每个设计决定的理由 |

## 快速检查系统是否正常

浏览器打开：

```
https://<worker 网址>/check?token=<VERIFY_TOKEN>
```

看到 `✅ Signed in to iCloud` 和 `✅ Found "Andy Auto AC Regas"` 就表示 iCloud 连接正常。

确认线上跑的是最新代码：Cloudflare → `fb-booking-andy-auto` → Edit code，搜索最近一次新增的函数名称（只看，不要按 Deploy）。

## 安全提醒

这个仓库是**公开的**。所有密码、令牌（Apple App 专用密码、Meta 令牌、Anthropic API Key、Bark key 等）都只放在 Cloudflare 后台的 Variables and Secrets 里，**绝对不要写进仓库的任何文件**。
