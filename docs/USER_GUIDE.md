# 使用说明

给专页管理员看的。只要照这里的模板回复客人，日历就会自动更新。

## 最重要的三条规则

1. **一定要在那位客人自己的对话里发出。** 系统是靠“这条消息发给了谁”来认客人的。在 A 客人的对话里发取消，系统只会去找 A 客人的预约。
2. **一条消息只用一个关键词。** 新建用 `Booking confirmed`，修改用 `Booking updated`，取消用 `Booking cancelled`。
3. **每次都看一下 Bark 通知。** 成功和失败都会推送。收到 ⚠️ 就表示日历没有更新，要手动处理或重发。

## 三个模板

建议存成 Business Suite 的“已保存的回复”，两位管理员共用。

### 1. 新建预约

```
✅ Booking confirmed – Andy Auto AC Regas
Service: Car AC regas
Price: $150
Time: Friday 30/10 10am
Address: 56 Smith St, Eagleby
Mobile: 0412 345 678

Any changes, reply here or call Andy on 0478 701 289. See you then!
```

- `Time:` 这一行**必须有**，其他栏位可以省略。
- 可以自己加任何“标签: 内容”的行，例如 `Vehicle: Corolla 2018`、`Notes: need change parts`，都会放进日历的备注。
- 开头那行和最后的客套话（包括 Andy 的电话）不会放进日历。

### 2. 修改预约（改期、改价格、补电话……）

```
🔄 Booking updated – Andy Auto AC Regas
Time: Saturday 31/10 2pm
```

- **只写有变的行。** 没写的资料保持不变。
- 例如只改价格和电话：
  ```
  🔄 Booking updated – Andy Auto AC Regas
  Price: $200
  Mobile: 0499 999 999
  ```
- 时间可以只写一部分：`Time: 3pm` 表示同一天改成 3 点；`Time: Monday` 表示改到星期一、时间不变。
- 修改的是这位客人**最近的那一个**预约。如果客人有好几个预约，要改后面的那个，请直接在 iPhone 日历里手动改。

### 3. 取消预约

```
❌ Booking cancelled – Andy Auto AC Regas
Your booking for Friday 30/10 10am has been cancelled. Feel free to message us anytime to rebook.
```

- 消息里写上**原本的日期**。客人有多个预约时，系统靠这个日期找到要取消的那一个。
- 没写日期的话，取消的是这位客人最近的那一个预约。

## 关键词规则

- 不分大小写，出现在消息任何位置都算，前面有没有 emoji 都没关系。
- 美式拼法 `Booking canceled` 也认得。
- 只认英文，写中文“预约确认”不会触发。
- 一条消息同时有多个关键词时，优先顺序是：取消 → 修改 → 新建。
- 平时聊天如果刚好写到这几个词（例如 “your booking updated time…”），也会被当成指令。

## 时间的写法

以下面这个日子为例：今天是 **21/10 星期三**。

| 你写的 | 系统理解成 |
|---|---|
| `tomorrow 10am` / `tmr 3pm` | 周四 22/10 |
| `day after tomorrow 9am` | 周五 23/10 |
| `Thursday 2pm` | 周四 22/10（接下来最近的星期四） |
| `next Thursday 2pm` | 周四 29/10（下个星期的星期四） |
| `Wednesday 9am` | 周三 28/10（今天就是星期三，所以算下星期） |
| `this Wednesday 4pm` / `today 4pm` | 周三 21/10（今天） |
| `30/10 7:20am` / `30 Oct 7:20am` / `Oct 30th 7:20am` | 周五 30/10 |
| `30/10/2026` / `2026-10-30` | 周五 30/10 |
| `Sat 1-3pm` | 周六 24/10 13:00–15:00 |
| `明天 下午3点` / `下周三 10点半` / `10月30日 15:00` | 也认得 |

- 日期是**澳洲写法：日/月**。`3/11` 是 11 月 3 日。
- 没写结束时间的话，默认 **90 分钟**。
- 写了已经过去一个星期以上的日期，会当成**明年**。
- 星期几和日期对不上时（例如 `Thursday 30/10`，其实 30/10 是星期五），系统**以日期为准**，同时 Bark 会提示 `Day mismatch`，请跟客人再确认。
- 像 `next week`、`whenever` 这种读不懂的写法，会推送 `⚠️ Booking not saved`。

## 日历上会看到什么

| 日历栏位 | 内容 |
|---|---|
| 标题 | 客人名字 – 服务 价格，例如 `John Smith – Car AC regas $150` |
| 时间 | `Time:` 那一行 |
| 地点 | `Address:` 那一行 |
| URL | 回到这个客人 Messenger 对话的链接 |
| 备注 | 消息里所有“标签: 内容”的行 |

- 备注里的电话号码 iPhone 会自动变成可以点的链接，点一下就能打给客人。苹果日历没有专门的电话栏位。
- 修改预约后，备注里同名的行会**直接换成新的**，最上面会记一笔改动，例如：
  ```
  Updated: Price, Mobile
  Rescheduled from Fri 30/10 10:00

  Service: Car AC regas
  Price: $200
  Time: Sat 31/10 14:00
  Address: 56 Smith St, Eagleby
  Mobile: 0499 999 999
  ```
- 你可以在 iPhone 上手动改事件（拖时间、加提醒等），系统之后修改时会读取最新的版本，你加的提醒会保留。

## Bark 通知的意思

| 通知 | 意思 | 要做什么 |
|---|---|---|
| 📅 Booking added | 新预约已写入日历 | 看一下时间对不对 |
| 🔄 Booking rescheduled | 已改期，会写“was …”原本的时间 | 无 |
| 🔄 Booking updated | 已修改其他资料 | 无 |
| ❌ Booking cancelled | 已从日历删除 | 无 |
| ℹ️ Already in calendar | 这位客人同一时间已经有预约，没有重复建立 | 如果是想改资料，请改用 Booking updated |
| ℹ️ This customer has other upcoming bookings | 这位客人还有别的预约 | 确认改到或取消的是对的那一个 |
| ⚠️ Day mismatch | 星期几和日期对不上，已按日期写入 | 跟客人确认 |
| ⚠️ Booking not saved / updated / cancelled | 失败了，下面会写原因 | 按原因改正后重发，或手动改日历 |
| ⚠️ Booking not found | 找不到这位客人的预约 | 检查是不是发错对话；不然手动改日历 |
| 💬 客人名字 | 客人发来消息（只有开启了 FORWARD_INCOMING 才会有） | 回复客人 |

点通知可以直接打开那个客人的对话。

## 常见问题

**同一位客人第二次预约怎么办？**
照样发 `Booking confirmed`，会建立第二个事件。只有同一时间的才会被当成重复。

**想改资料却发成了 Booking confirmed？**
如果时间不同，会多出一个预约，请在日历里删掉多的那个，再用 `Booking updated` 修改。如果时间相同，什么都不会改（会收到 `Already in calendar`）。

**我在 iPhone 上手动建的预约，可以用模板改期或取消吗？**
不行。系统只会处理它自己建立的事件，手动建的事件它不会碰，请继续手动处理。

**Google 日历时期建的旧事件呢？**
没有搬过来，只留在 Google 日历里。

**有些事件的备注里有 `Customer ID:` 这一行？**
那是刚改用 iCloud 时最早建立的几个事件。系统靠这一行找到它们，请不要删掉。之后建立的事件，客人编号藏在事件内部，备注里不会再有这一行。

**另一位管理员也想看日历？**
在日历 App 里点 “Andy Auto AC Regas” 旁边的 ⓘ →“添加人员”，输入他的 Apple ID。

**另一位管理员发模板也有效吗？**
有效。对 Meta 来说两位管理员发的都是“专页发出的消息”。日历上不会标注是谁确认的。
