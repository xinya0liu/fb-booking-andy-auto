# 建立原因、过程与设计决定

记录这个系统为什么这样做，方便以后维护或修改时了解前因后果。

## 背景

Andy Auto AC Regas 是上门的汽车冷气加氟、检修服务，营业范围在 Eagleby 一带。客人主要通过 Facebook 专页的 Messenger 联系、预约，专页由两位管理员一起回复。

原本的痛点：

- **预约要手动抄进日历。** 确认预约后，要再把时间、地址、价格、服务抄一遍，忙的时候容易漏抄或抄错。改期、取消也要记得回去改。
- **Messenger 的通知不稳定。** 有时候客人发了消息，手机却没有提醒。为此之前已经做了一个 Cloudflare Worker，把客人消息转推到 Bark，当作备用通知。

## 目标

1. 在 Messenger 回复客人确认预约的同时，预约自动出现在 iPhone 日历上。
2. 改期、取消也自动同步，不用另外操作。
3. 每次自动操作都有回执，失败时马上知道，不会默默漏单。
4. 两位管理员都能用，都能收到通知。
5. 不用租服务器、不用每月付费，维护越少越好。

## 过程与每个决定的理由

### 1. 用“专页发出的消息”触发，而不是读客人的消息

客人的写法千奇百怪，很难可靠地判断“这算不算确认预约”。真正确定预约的那一刻，是**我们回复客人确认**的时候，所以系统只读专页自己发出的消息（Meta 的 `message_echoes`）。这样内容格式由我们控制，也不会把客人随口问的时间当成预约。

### 2. 继续用 Cloudflare Worker

之前的 Bark 备用通知已经跑在 Cloudflare Worker 上，免费、不用管服务器、全年在线。这个系统沿用同一套做法，后来改成连接 GitHub 自动部署，改代码只要提交就会上线。

### 3. 用 Bark 做回执和失败提醒

Bark 原本就装在手机上。Worker 每次写入日历后推一条回执；格式写错、日历出问题时推一条 ⚠️，并附上链接，方便回到那位客人。这解决了“以为写进去了，结果当天才发现没有”的风险。

### 4. 日历：Google → iCloud

日历选择前后考虑过三种：

| 方案 | 优点 | 缺点 |
|---|---|---|
| Hotmail / Outlook | iPhone 上推送即时 | 个人微软账号只能用 OAuth 登录，refresh token 会轮换、会过期，需要另外存储，多一个容易坏的环节 |
| Google 日历 | 有“服务账号”，设置一次长期稳定，权限只限一个日历 | iPhone 上是定时获取，新事件可能要等几分钟才出现 |
| **iCloud 日历（现在用的）** | iPhone 上几乎马上出现；苹果生态内，共享给另一位管理员也方便 | 只能用 App 专用密码（权限较大，改 Apple ID 密码会失效）；CalDAV 不是苹果正式提供给开发者的 API |

一开始先用 Google 做出能用的版本，确认整个流程可行。之后为了让新预约更即时地出现在 iPhone 上，改写成直接写入 iCloud（CalDAV）。读取消息、时间解析、Bark 这些部分完全沿用，只替换了日历那一层。

### 5. 消息模板的演变

- **第一版**：一行用 `｜` 分隔的格式，例如 `✅预约｜明天 下午3点｜…`。程序好读，但发给客人不好看。
- **第二版**：认 “have booked you in” 加 `Time:` 行。比较自然，但没办法区分改期和取消。
- **现在**：三个英文模板，开头分别是 `Booking confirmed`、`Booking updated`、`Booking cancelled`，资料一行一个“标签: 内容”。客人看得清楚，程序也读得准，而且可以随时加新的栏位（例如 `Mobile:`、`Vehicle:`、`Notes:`）。

时间解析后来补强了 `next Thursday`、`this Wednesday`、`30 Oct`、中文写法等，并在星期几和日期对不上时提醒。

### 6. 怎么知道“改期、取消的是哪一位客人”

每段 Messenger 对话都有一个固定的客人编号（PSID），Meta 推送的资料里一定有。建立预约时把这个编号记在事件里，改期、取消时用编号把预约找回来。所以规则是：**改期、取消必须在那位客人的对话里发**。

客人编号放在哪里也改过几次：

- Google 时期放在 Google 日历的隐藏栏位，备注里也写一份 `Customer ID`。
- 改成 iCloud 后，起初也写在备注里。为了让备注干净，后来改成藏在事件的 **UID**（事件的内部编号）里，另外也放在隐藏栏位 `X-FB-PSID`。UID 在 iPhone 上手动修改事件也不会变，比放在备注里更可靠。

### 7. 两位管理员

Meta 推送时不区分是哪一位管理员发的，所以两个人发模板都有效，不用额外设定。Bark 改成支持多个网址，通知同时推给两个人。

### 8. 日历上显示什么

- 标题放客人名字、服务、价格，在日历总览就看得到重点。
- 链接放在苹果日历的 URL 栏位，可以直接点开；没有再重复放进备注。
- 备注放消息里所有“标签: 内容”的行，资料完整；但不放开头那行和结尾的客套话，避免 Andy 自己的电话被 iPhone 识别成可以点的号码，误以为是客人的电话。
- 修改时备注里同名的行直接换成新的，最上面记一笔改动，所以备注永远是最新、完整的资料，又看得到改过什么。

### 9. 客人名字：从对话参与者找

App 只有标准权限时，查不到一般客人的个人资料，通知上的名字会变成 `Customer`。改成查不到时，从**专页自己的对话**里找参与者的名字。读自己专页的对话不需要额外权限，实测可行。另外也可以在消息里写 `Name: …` 指定。

### 10. Meta App：Live、标准权限就够用

新的 App 原本是开发模式，改成 Live 后，`pages_messaging` 仍是“Ready for testing”（标准访问）。用一位跟 App 无关的朋友实测，收得到他的对话推送、读得到对话、也能发消息给他，所以**不需要 App 审核**。尝试“Add to App Review”时，Meta 要求先申请成为 Tech Provider（给帮其他商家开发软件的公司，且不可撤销），所以没有走这条路。

### 11. 让 AI 读对话、整理资料、自动回复客人

即使有了模板，资料还是要自己整理：客人先问车型和价格，你报价，客人给地址和电话，最后约时间，这些散落在好几条消息里。

考虑过三种做法：一键确认并自动回复客人、先推送草稿给管理员确认、网页确认单。选了**一键确认**：谈好后只发一句 `Booking confirmed 👍 …`，Worker 读最近 30 天的对话，交给 AI 整理，写进日历，再用专页自动发一条完整的确认消息。客人也会看到这条消息，所以就算 AI 抓错，双方都看得到，可以马上更正。

几个细节：

- AI 必须用**工具调用**回传固定栏位。最初让它回 JSON 文字，遇到“确认 → 取消 → 又确认”这种来回的对话时，AI 回了一段说明文字，导致解析失败。
- 修改（`Booking updated`）时，把**日历上目前的资料**也交给 AI，请它回传“现在应该是什么”，程序再比较出改了哪些栏位。
- AI 算出的时间已经过去就拒绝建立；同一时段已有别的事件就提醒撞时间。
- Worker 自动发出的消息带标记，Meta 回传时会跳过，避免自己触发自己。
- AI 或读对话失败时，消息里有写资料就照写的处理（后备），不会漏单。

### 12. 关键词的最后定案

加入 AI 之后，一度出现“同一个关键词，会因为消息里有没有写栏位而有不同处理”的规则，结果太难记。最后改成**只看消息开头**：

| 开头 | 用 AI | 自动回复客人 |
|---|---|---|
| `Booking confirmed` / `Booking updated` | ✅ | ✅ |
| `Booked you in` / `Booking change` | ❌ | ❌ |
| `Booking cancelled` | ❌ | ❌ |

想交给 AI 就用前两个；自己写好资料、只想更新日历就用中间两个。关键词也改成必须在消息开头，聊天中间顺口打出来的不会触发。

### 13. 回到客人对话的链接：改成客人卡片

一开始用 `LINK_TEMPLATE` 拼出 Business Suite 的对话网址，但点了打不开正确的客人。做了一个测试页，用 iPhone 逐一试了 5 种写法（客人编号、对话编号、Meta 提供的对话链接等），结果每一种都只会打开收件箱、显示最新的对话。看起来“成功”的那位客人，只是刚好是最新的对话。结论是 **iPhone 上的 Business Suite 不支持直接打开某一个对话**。

所以改成客人卡片：点链接打开一个页面，显示客人名字，一个按钮同时复制名字并打开收件箱，在搜索框贴上就能找到。原本考虑加“打电话”按钮，但电话已经在日历备注里可以直接点，就没有加。测试页因为会显示客人名字，确定写法之后就删掉了。

### 14. 部署没有更新的问题

有一次 GitHub 上已经是新版本、Cloudflare 的 Build 也显示 Ready，线上却还是旧代码。版本列表里最新那笔显示 “Empty commit message”，很可能是在 Edit code 页面按了 Deploy，把旧代码重新部署。用一个空提交（`git commit --allow-empty`）重新触发部署后恢复正常。之后的规则：Edit code 只用来查看线上代码，不在那里按 Deploy。

### 15. 车型冷媒数据库选 D1 不选 KV

数据量近 2000 条，有搜索（按品牌/年份过滤）和多条件查询需求。KV 是键值存储，做这种查询要全部拉下来在代码里 filter，不优雅。D1 是 Cloudflare 的 SQLite 服务，免费额度覆盖远超业务需要，天生适合这种关系型查询。

Admin 页用 Fetch API 直接对接 `/vehicles/api`，无需额外 ORM 或框架。

### 16. 冷媒单价存 KV 而不是数据库字段

冷媒价格会随供应商定价偶尔变动。如果把 `cost` 字段存到每一行 `vehicles` 表，每次价格变动要 UPDATE 1979 行。改成单价存 KV（`refrigerant_prices` JSON blob），打印/显示时实时算 `charge_g × 单价 ÷ 1000`。

好处：价格变动只改一个值，瞬间所有车型的 Cost 都更新；数据表保持纯净。

### 17. 打印页字体和分页策略

Andy 一天最多 9 单的时候居多。原先 landscape A4 一页只能塞 ~8 单，第 9 单有时被静默剪掉。改成：
- 打印时字体放大约 1.2x（0.94em），padding 压到 4-5px
- 一页目标容量 9 单
- 第 10 行强制 `page-break-before: always`，确保超过 9 单必然翻页不丢失

屏幕显示不变，只在 `@media print` 范围内生效。

### 18. 地址规范化两层防御

AI 的 prompt 已经告诉它"不要带 QLD/Australia/邮编"，但模型偶尔还是会保留。地址干净不干净直接影响打印和 Google Maps 导航。

两层防御：
1. **写入时**：AI 后处理 + 历史地址 fallback 都走 `normalizeAddress` 一遍
2. **显示时**：`splitAddress` 调用前再过一次 `normalizeAddress`

这样即使有脏数据漏进 Calendar，打印页也会把它清干净再分两行显示。还顺手解决了 `Unit 84` 被写在地址尾部（应该在头部）的问题。

## 时间线

| 日期 | 事件 |
|---|---|
| 2026 年 10 月以前 | 已有 Bark 备用通知 Worker（转推客人消息） |
| 2026-10-21 | 建立预约自动化：Google 日历版上线并测试；加入改期、取消、多个 Bark、新模板 |
| 2026-10-21 | 改写为 iCloud 日历版；整理备注内容；客人编号改存在 UID；建立本仓库文件和本地测试 |
| 2026-10-21 | 新 App 改为 Live；用朋友实测确认一般客人可用；客人名字改从对话参与者找 |
| 2026-10-22 | 加入 AI 读对话、自动回复客人；撞时间与时间已过检查；一键修改；后备机制；关键词定案为五个开头 |
| 2026-10-22 | 测试确认 iPhone 上无法直接打开指定对话，链接改为客人卡片；排除部署没有更新的问题 |
| 2026-11-上旬 | iMessage/SMS 稳定性：macOS Sonoma 的 attributedBody 用 NSUnarchiver 正确解码；heuristic fallback 过滤 plist 元数据；clean_contact_name 重写剥离任意日期前缀；scan_keywords SQL 加 LEFT JOIN fallback |
| 2026-11-上旬 | AI 提取稳定性：trimToLastConfirmation 修多行 ✅ bug；redactOldConfirmationTimes 保留地址但清掉旧时间；appendTriggerMarker 明示触发点；prompt 禁止从 contact label 提取任何预约字段 |
| 2026-11-上旬 | 地址规范化：normalizeAddress 剥离 QLD/Australia/邮编，自动把末尾 Unit X 移到前端；AI 后处理、历史地址 fallback、splitAddress 三处调用 |
| 2026-11-中旬 | 打印页大改版：街道/suburb 两行显示、Customer+Mobile 合并、B&W 友好 pill、顶部 📝 Notes 栏（KV 存）、紧凑打印（9 单/页，10+ 自动换页）；Service 列优先读 Calendar 标题 |
| 2026-11-中旬 | 车型冷媒数据库：Cloudflare D1 建 `vehicles` 表 + `/vehicles` Admin 页 + CRUD/查询 API；从 CoolDrive GasBook2014 PDF 解析导入 1979 条数据（67 个品牌） |
| 2026-11-中旬 | 冷媒单价 KV + 实时 Cost 列（价格变动一键生效，不用批量 UPDATE）；R1234yf 从 UI 移除（Andy 目前不做这项服务） |
| 2026-11-中旬 | 车型搜索增强：自动识别年份 `camry 2013` → text + year；按 token 拆分支持 `cx-5` 匹配 `CX5`；开放式年份显示 `2007+` |
| 2026-11-13 | 建立"文档同步要求"规则：README/USER_GUIDE/SETUP/MAINTENANCE/TODO/HISTORY 需要和大改动一起更新；小修不用 |
| 2026-11-13 | 定位 SMS 不触发的最后一个坑：launchd 跑的是 CommandLineTools Python 3.9，之前 PyObjC 装在 Homebrew Python 3.11。装了 `pyobjc 10.3.1`（Python 3.9 最后一个有预编译 wheel 的稳定版）到 3.9 后，NSUnarchiver 能正确解码 iOS 自动给日期/价格加超链接的消息（之前 heuristic 只能抓到 link 元数据碎片 `'sunday 15/11 ... xdatetime'`） |
| 2026-11-13 | Phase 1 CRM 一次性发布：D1 新增 `customers` + `bookings_meta`；打印页加点击行弹 modal（Status/Payment/Actual Amount + Service/Price/Vehicle/Address 等 Calendar 字段编辑），统一入口两个 tab；行末 Mark 列显示工单 badge，表下 Collected/Cash/PayID/Unpaid 汇总；Gas 列从 vehicles DB 查建议克数（AI prompt 加 `vehicle_make/model/year/variant` 结构化字段 → X-VEH-* 属性）；新增 `/report` 月年收入报表 + CSV 导出 |
| 2026-11-13 | Phase 1 修 bug：（1）Mixed 支付加 `cash_portion` + `payid_portion` 两个列，选 Mixed 时弹两个输入框分别填，汇总自动拆进 Cash/PayID 总计；（2）`/bookings/edit` 之前用 iCloud `text-match` prop-filter 查 UID，iCloud 返回 412——改用拉 ±400 天窗口在 Worker 里 UID 匹配 |
| 2026-11-14 | 修 GasBook 导入 parser：之前"pending_model 覆盖当前 model"的 merge 逻辑把真实车型（如 Santa Fe SM）写进 notes，用 `Dual A/C` / `Includes Turbo` 等变体描述当 model。48 条 `Dual A/C` + ~140 条其他 mislabel 全部复位为正确车型 + variant/notes。重新 parse 后 import，保留了手动添加的 4 条。顺带修了 `gen_sql.py` 从 `/tmp/parse_gasbook.py` 导入的 bug（应从 `scripts/`）|
| 2026-11-14 | 加第二个车型数据源 Nissens AC Refrigerant DB（3309 条，比 GasBook 更新也更详细）。schema 加 `source` 列标数据来源（`manual` / `nissens` / `cooldrive`），`/vehicle-lookup` 按 manual > nissens > cooldrive 优先级排序；admin 页行首加 M/N/C 彩色 badge；admin POST/PUT 自动把 source 设成 'manual' 固化 Andy 的判断。新增 `scripts/parse_nissens.py` 解析 CSV（处理欧式小数、月.年、范围、RHD 变体、斜杠备选、R123yf 拼写错误、R744 等不支持的冷媒跳过）|
| 2026-11-14 | 加第三个数据源 Hychill（澳洲本地，9489 条，覆盖最广且带 variant 代号如 J10/KE/8K5）。lookup 优先级更新为 manual > nissens > hychill > cooldrive；admin 加橙色 H badge。跳过 R12/Minus30 老车（1566 条）和 1729 条农业/工业设备（无年份）。新增 `scripts/parse_hychill.py`。总 DB 条数到 **14781**|
| 2026-11-14 | 数据清理：make 大小写统一（`Mercedes-benz` → `Mercedes-Benz` 等 4 处），model hyphen 统一（Mazda CX-5/BT-50/MX-5 等、Honda CR-V/HR-V 等、Isuzu D-Max、Nissan GT-R）；Hyundai `ix35` 小写 + `H-1` 带连字符。Admin 页加自动折叠：同 make/model/年份/冷媒/克数的多个 variant 合并成一行，点击展开（Ford Transit 2020 从 63 行 → 25 行显示）|

## 未来可以考虑的方向

- **客人超过 24 小时才确认**：目前要手动发确认。可以研究 Meta 允许的消息标签。
- **其他渠道的预约**：电话、短信、Instagram 的预约目前要手动加进同一个日历。Instagram 也是 Meta 的，未来可以用类似方式接进来。
- **当天提醒**：在事件里自动加一个提醒（例如出发前 1 小时）。
- **每日摘要**：每天早上用 Bark 推送当天所有预约。
- **给客人的提醒**：预约前一天自动用 Messenger 提醒客人（要注意 Meta 对专页主动发消息的 24 小时规则）。
