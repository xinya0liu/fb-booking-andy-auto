# fb-booking-andy-auto

Andy Auto AC Regas 的预约自动化：在 Facebook Messenger 里给客人发出确认、改期、取消消息时，自动写入、修改、删除 **iCloud（苹果）日历**里的预约，并用 **Bark** 推送通知到管理员的 iPhone。

整个系统只有一个 Cloudflare Worker（`worker.js`），不需要服务器，也不需要另外安装任何 App（Bark 除外）。

## 它解决什么问题

客人大多通过 Facebook 专页的 Messenger 预约。以前确认预约后，要再手动把时间、地址、价格抄进日历，容易漏抄、抄错。现在只要用固定模板回复客人，预约就会自动出现在 iPhone 日历里，改期和取消也会自动同步。

## 运作方式

```
你在 Business Suite 回复客人
（Booking confirmed / updated / cancelled）
            │
            ▼
Meta 把“专页发出的消息”推送给 Worker（message_echoes）
            │
            ▼
Cloudflare Worker（worker.js）
  ├─ 读取消息里的 Service / Price / Time / Address 等栏位
  ├─ 写入 / 修改 / 删除 iCloud 日历里的事件（CalDAV）
  └─ 推送 Bark 通知给所有管理员（成功或失败都会通知）
            │
            ▼
iPhone 日历几乎马上更新；点事件里的链接可以回到那个客人的对话
```

## 三个触发关键词

| 用途 | 关键词 | 例子 |
|---|---|---|
| 新建预约 | `Booking confirmed` | `✅ Booking confirmed – Andy Auto AC Regas` |
| 修改预约 | `Booking updated` | `🔄 Booking updated – Andy Auto AC Regas` |
| 取消预约 | `Booking cancelled` | `❌ Booking cancelled – Andy Auto AC Regas` |

完整模板和使用规则见 **[使用说明](docs/USER_GUIDE.md)**。

## 文件说明

| 文件 | 内容 |
|---|---|
| `worker.js` | 全部程序代码（Cloudflare Worker） |
| `wrangler.jsonc` | Cloudflare 部署设置。`keep_vars: true` 让部署时保留后台填的变量，**不要删掉** |
| `tests/mock-icloud-test.mjs` | 本地测试，用模拟的 iCloud 跑完整流程，不需要任何密码 |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | 使用说明：模板、关键词、时间写法、通知的意思、常见问题 |
| [`docs/SETUP.md`](docs/SETUP.md) | 从零开始的完整设置步骤（Meta、Cloudflare、iCloud、Bark） |
| [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) | 日常维护、故障排查、更换密码、修改代码、回滚 |
| [`docs/HISTORY.md`](docs/HISTORY.md) | 建立原因、过程、每个设计决定的理由 |

## 快速检查系统是否正常

浏览器打开：

```
https://<worker 网址>/check?token=<VERIFY_TOKEN>
```

看到 `✅ Signed in to iCloud` 和 `✅ Found "Andy Auto AC Regas"` 就表示 iCloud 连接正常。

## 安全提醒

这个仓库是**公开的**，任何人都能看到里面的内容。所有密码、令牌（Apple App 专用密码、Meta 令牌、Bark key 等）都只放在 Cloudflare 后台的 Variables and Secrets 里，**绝对不要写进仓库的任何文件**。
