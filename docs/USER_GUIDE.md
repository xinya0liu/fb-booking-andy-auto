# 使用说明

给专页管理员看的。

## 只要记住这两件事

1. **消息的开头决定会发生什么。** 只有下面五个开头会触发，其他任何消息都不会。
2. **每次都看一下 Bark。** 成功、失败、撞时间都会通知。收到 ⚠️ 就表示日历没有照预期更新，要处理一下。

另外，一定要在**那位客人自己的对话里**发。系统是靠对话来认客人的。

## 五个开头

| 开头 | 做什么 | 用 AI | 自动回复客人 |
|---|---|---|---|
| `Booking confirmed` | 新建预约，资料从对话整理 | ✅ | ✅ |
| `Booking updated` | 修改预约，从对话找出改动 | ✅ | ✅ |
| `Booked you in` | 新建预约，只照消息里写的 | ❌ | ❌ |
| `Booking change` | 修改预约，只照消息里写的 | ❌ | ❌ |
| `Booking cancelled` | 删除预约 | ❌ | ❌ |

**记法：** `Booking confirmed` / `Booking updated` 交给 AI，并且会自动回复客人；`Booked you in` / `Booking change` 是你自己写好资料，只更新日历。

- 开头前面可以有 emoji（例如 `✅`、`🔄`、`❌`），有没有空格都可以。
- 不分大小写。`Booking changed`、`Booking canceled`（一个 l）也认得。
- 必须是**消息的开头**。“Sure, your booking confirmed time is…” 这种句子不会触发。
- 其他写法都**不会触发，也不会有任何提醒**，例如 `Booking rescheduled`、`Booking changes`。建议全部存成“已保存的回复”，用点选的，不要手打。

## 平常最常用的三句（AI）

存成 Business Suite 的“已保存的回复”，两位管理员共用：

```
Booking confirmed 👍 I'll send through your booking details shortly.
```

```
Booking updated 👍 I'll send through your updated booking details shortly.
```

```
Booking cancelled – your booking for Sunday 25/10 2pm has been cancelled.
```

### Booking confirmed：谈好了就发

系统会读这位客人**最近 30 天**的对话，AI 整理出时间、服务、价格、地址、电话、车型和备注，写进日历，然后几秒内自动回复客人：

```
✅ Booking details – Andy Auto AC Regas
Service: AC check and regas
Price: $220
Time: Sunday 25/10, 2:00pm
Address: 12 Test Street, Eagleby
Vehicle: 2016 Toyota Camry

Any changes, reply here or call Andy on 0478 701 289. See you then!
```

- AI 会采用**最后谈定**的内容：最后一次报的价格、客人最后接受的时间。
- 你的电话 0478 701 289 不会被当成客人的电话。
- 发给客人的消息**不包含内部备注**（例如 “need change parts”）。
- 想指定某一项，就在同一条消息后面加一行，你写的优先：
  ```
  Booking confirmed 👍 I'll send through your booking details shortly.
  Price: $199
  ```

### Booking updated：有改动就发

在对话里跟客人谈好改动后发这一句。系统会把**日历上目前的资料**和对话一起交给 AI，找出改了什么（时间、价格、地址……），只更新有变的部分，然后自动回复客人：

```
🔄 Updated booking details – Andy Auto AC Regas
...
```

- 同样可以在后面加一行指定，例如 `Time: Saturday 2pm`，你写的优先。
- 对话里找不到任何改动时，不会乱改，Bark 会提醒你。
- 修改的是这位客人**最近的那一个**预约。客人有好几个预约、要改后面那个的话，请在 iPhone 日历手动改。

### 资料不对或缺了怎么办

在对话里跟客人讲清楚（例如 “Just to confirm, the address is 12 Test Street”），再发一次 `Booking updated 👍 …`。

### Booking cancelled：取消

- 写上**原本的日期**，客人有多个预约时，系统靠这个日期找到要取消的那一个。
- 没写日期的话，取消这位客人最近的那一个预约。
- 取消不用 AI，也不会另外回复客人（你这条消息本身就是通知）。

## 不用 AI 的两个模板

适合你已经把资料写好、只想更新日历的时候。客人看到的就是你这条消息，系统**不会**再自动回复。

### Booked you in：新建

```
Booked you in – Andy Auto AC Regas
Service: Car AC
Price: $
Time:
Address:

Any changes, reply here or call Andy on 0478 701 289. See you then!
```

- `Time:` **一定要填**，没填会收到 ⚠️，不会建立。
- 可以自己加任何“标签: 内容”的行，例如 `Mobile: 0412 345 678`、`Vehicle: Corolla 2018`、`Notes: need change parts`，都会放进日历备注。
- 想指定客人名字，加一行 `Name: John Smith`。

### Booking change：修改

```
Booking Change – Andy Auto AC Regas
Time:
Address:

Any changes, reply here or call Andy on 0478 701 289. See you then!
```

- 只填有变的行。**空着的行会被忽略**，原来的资料保持不变。
- 时间可以只写一部分：`Time: 3pm` 表示同一天改成 3 点；`Time: Monday` 表示改到星期一、时间不变。

## 时间的写法

AI 会自己看懂对话里的时间。下面的规则适用于你**自己写的 `Time:` 行**。以 **22/10 星期四**为例：

| 你写的 | 系统理解成 |
|---|---|
| `tomorrow 10am` / `tmr 3pm` | 周五 23/10 |
| `day after tomorrow 9am` | 周六 24/10 |
| `Saturday 2pm` | 周六 24/10（接下来最近的星期六） |
| `next Saturday 2pm` | 周六 31/10（下个星期的星期六） |
| `Thursday 9am` | 周四 29/10（今天就是星期四，所以算下星期） |
| `this Thursday 4pm` / `today 4pm` | 周四 22/10（今天） |
| `30/10 7:20am` / `30 Oct 7:20am` / `Oct 30th 7:20am` | 周五 30/10 |
| `Sat 1-3pm` | 周六 24/10 13:00–15:00 |
| `明天 下午3点` / `下周三 10点半` / `10月30日 15:00` | 也认得 |

- 日期是**澳洲写法：日/月**。`3/11` 是 11 月 3 日。
- 没写结束时间的话，默认 **90 分钟**。
- 星期几和日期对不上时（例如 `Thursday 30/10`，其实 30/10 是星期五），以**日期为准**，Bark 会提示 `Day mismatch`。

## 日历上会看到什么

| 日历栏位 | 内容 |
|---|---|
| 标题 | 客人名字 – 服务 价格，例如 `John Smith – Car AC regas $150` |
| 时间 | 预约时间 |
| 地点 | 地址 |
| URL | 回到这个客人 Messenger 对话的链接 |
| 备注 | Service、Price、Time、Address、Mobile、Vehicle、Notes 等全部资料 |

- AI 建立的预约，备注第一行是 `Auto-filled from chat`。
- 备注里的电话 iPhone 会自动变成可以点的链接，点一下就能打给客人。
- 修改后，备注里同名的行会**直接换成新的**，最上面记一笔改动，例如：
  ```
  Updated: Price, Mobile
  Rescheduled from Fri 30/10 10:00

  Service: Car AC regas
  Price: $200
  Time: Sat 31/10 14:00
  ...
  ```
- 你可以在 iPhone 上手动改事件（拖时间、加提醒等），系统之后修改时会读取最新的版本，你加的提醒会保留。

## Bark 通知的意思

| 通知 | 意思 | 要做什么 |
|---|---|---|
| 📅 Booking added | 新预约已写入日历，下面列出整理的资料 | 核对一下 |
| ✉️ Confirmation sent to the customer | 已自动回复客人 | 无 |
| ℹ️ Not found in chat: Price, Address | 对话里找不到这几项，日历上空着 | 需要的话在对话里补问，再发 `Booking updated` |
| ⚠️ Overlaps with: … | 同一时段日历里已有别的事件 | 确认是不是撞单了 |
| 🔄 Booking rescheduled / updated | 已修改，会写“was …”原本的时间 | 无 |
| ❌ Booking cancelled | 已从日历删除 | 无 |
| ℹ️ Already in calendar | 这位客人同一时间已经有预约，没有重复建立 | 想改资料请用 `Booking updated` |
| ℹ️ This customer has other upcoming bookings | 这位客人还有别的预约 | 确认改到或取消的是对的那一个 |
| ⚠️ Day mismatch | 星期几和日期对不上，已按日期写入 | 跟客人确认 |
| ⚠️ Confirmation NOT sent to the customer | 预约已写入，但自动回复失败（通常是客人超过 24 小时没发消息） | 复制通知里附的消息，自己发给客人 |
| ⚠️ AI unavailable | AI 出问题，已按你消息里写的资料处理，没有回复客人 | 自己确认资料，必要时发给客人 |
| ⚠️ Booking not saved / updated / cancelled | 失败了，下面写原因和怎么补发 | 照提示处理 |
| ⚠️ Booking not found | 找不到这位客人的预约 | 检查是不是发错对话；不然手动改日历 |
| 💬 客人名字 | 客人发来消息（开启了 FORWARD_INCOMING 才有） | 回复客人 |

点通知可以直接打开那个客人的对话。

## 常见问题

**客人超过 24 小时才回来确认？**
Meta 不允许专页在客人最后一条消息 24 小时后主动发消息。预约照样会写入，Bark 会附上确认消息，复制后自己发。

**客人用照片或语音给资料？**
AI 只读文字。找不到的项目 Bark 会写 “Not found in chat”，在对话里用文字补问一下，或在关键词那条消息后面加一行。

**老客人隔很久再约？**
AI 只读最近 30 天的对话。更早给过的地址、电话不会被抓到，请客人重新确认，或自己加一行。

**同一位客人第二次预约？**
照样发 `Booking confirmed`，会建立第二个事件。只有同一时间的才会被当成重复。

**我在 iPhone 上手动建的预约，可以用这些开头改期或取消吗？**
不行。系统只会处理它自己建立的事件，手动建的事件它不会碰。

**有些事件的备注里有 `Customer ID:` 这一行？**
那是刚改用 iCloud 时最早建立的几个事件。系统靠这一行找到它们，请不要删掉。

**另一位管理员也想看日历？**
在日历 App 里点 “Andy Auto AC Regas” 旁边的 ⓘ →“添加人员”，输入他的 Apple ID。

**另一位管理员发也有效吗？**
有效。对 Meta 来说两位管理员发的都是“专页发出的消息”。
