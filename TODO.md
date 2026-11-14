# TODO

## 待做：AI 自动报价 💬

### Preferences（产品决策）

**渠道：** 先做 Facebook Messenger，SMS 不急（SMS 客人少，基本打电话）

**阶段：** Trial 期草稿审批，满意后再考虑全自动

**对话状态机：**
```
问候 / 简单咨询
  → 模板回复（服务介绍 + 要求提供 Make / Model / Year / Suburb）

有部分信息
  → 有地址没车型 → 问车型
  → 有车型没地址 → 问地址

四项齐全（Make + Model + Year + Suburb）
  → 生成报价草稿 → Bark 推给 Andy（附审批链接）

Andy 打开审批页面
  → 显示报价明细（冷媒克数 × 冷媒单价 + 距离附加费）
  → 每项可手动调整（冷媒单价可随时改，存 KV，下次报价自动用新价格）
  → 确认后点发送 → 发给客人
  → 顺带问客人有没有想预约的日子

客人给日期
  → AI 查那天空档 → 给出时间建议 → Andy 选 → 发给客人

客人没回应
  → 几分钟后自动问 "Would you like to book in?"
  → 如客人说 "I'll reply next week / tomorrow" → AI 识别 → 下周 / 明天再跟进
```

**降级原则（马上转人工）：**
- 车型不在数据库
- Suburb 超出 40km（基地：Eagleby）
- 日历全满

**报价公式：** 冷媒克数 × 冷媒单价（$60/kg）+ suburb 附加费

**冷媒单价：** ~$60/kg，存 KV，审批页面可随时调整

**车型匹配：** AI 模糊匹配（客人写法不统一，不能精确匹配）

**Suburb 定价逻辑：**
- 数据库里有 → 直接用预设附加费（每个 suburb 各自定价）
- 数据库里没有 → Google Maps 算距离 → 按距离计算附加费（公式待定）
- 超出 40km（基地：Eagleby）→ 转人工
- Suburb 列表和定价由 Andy 整理后录入

**⚠️ 待定：** 未知 suburb 的距离附加费公式（每公里 $X？还是分段？）

**日历：** 工作时间 5am–10pm，每单 90 分钟

**状态存储：** Cloudflare D1（免费 5GB，按目前业务量可用 50 年以上，为后续 CRM 打基础）

**开始写代码前 Andy 需要先准备：**
- [ ] 整理附近 suburb 列表 + 每个 suburb 的附加费定价
- [ ] 确认未知 suburb 的距离附加费计算公式（每公里 $X？还是分段？）

### 待实现

- [ ] Suburb 距离数据库（Eagleby 40km 内）+ 定价区间（待讨论）
- [x] **车型冷媒重量数据库**（Cloudflare D1 + Web 管理页 `/vehicles`）—— 见下面"车型冷媒数据库"段落完整说明
- [ ] D1 对话状态表（PSID、车型、地址、状态、时间戳）
- [ ] Facebook 多轮对话逻辑（状态机）
- [ ] 审批页面（`/quote-review?id=xxx&secret=xxx`）
- [ ] 定时跟进（几分钟后 / 客人指定时间）
- [ ] 日历空档查询 + 时间推荐

---

## 待做：打印页 / 日程 🖨️

- [x] **"全副武装"提醒在打印纸上显示** ← 确认已正常打印，无需修改

- [x] **打印前确认弹窗（防止打错日期）**
  - 自定义 modal，日期加粗显示，Today/Tomorrow/Other 在同一行，Print 右对齐
  - 4 点前默认今天，4 点后默认明天
  - Tomorrow 按钮 bug 已修复（之前 4 点前点没反应）

---

## 待做：消息格式优化 💬

- [x] **Facebook Messenger 确认消息日期格式统一**
  - 已统一为 `3/11 Tuesday 5pm` 格式（与 SMS 一致）

- [ ] **时间标签一键复制（FB Messenger）**
  - 在 Worker 生成的确认消息里，时间部分（如 `31/10 Monday 4pm`）发送后 Andy 在手机/电脑端可以直接复制这段文字，方便直接粘贴做联系人标签
  - 技术限制：Messenger 消息是纯文本，无法嵌入按钮；只能把时间格式化得足够方便复制（独占一行，不带多余文字）

---

## 待做：AI 提取问题修复 🔧

- [x] **单元号地址被截断**（如 `2/32a XX St` → `2 XX St`）
  - Prompt 已加规则，AI 保留完整单元号格式

- [x] **Calendar 手动修改不反映在打印页**
  - 打印页现在优先读 SUMMARY（标题）里的 price/service，Calendar 改标题即时反映

- [x] **地址带 "QLD, Australia"**
  - Prompt 已加规则，AI 不再附加 postcode / QLD / Australia

---

## 待做：CRM 蓝图（2026-11-13 设计讨论）

Andy 希望打印页逐步演化成一个 CRM。所有阶段都基于一个核心架构决定：

### 架构决定（已同意）

**数据分层：**
- **iCloud Calendar 仍是预约时间/地点的 source of truth**（苹果多设备同步免费、稳定）
- **Cloudflare D1 存"所有预约之后沉淀的数据"**（付款、状态、客户档案、历史）
- 打印页/CRM 页从 Calendar events + D1 join 查询展示

**D1 Schema 扩展**（和 `vehicles` 表并列）：
```sql
customers (
  phone           TEXT PRIMARY KEY,
  name            TEXT,
  first_seen      INTEGER,          -- unix ts
  last_seen       INTEGER,
  visit_count     INTEGER DEFAULT 0,
  total_paid      INTEGER DEFAULT 0, -- cents
  notes           TEXT DEFAULT ''
);

bookings_meta (
  calendar_uid    TEXT PRIMARY KEY,  -- 对应 iCal event UID
  phone           TEXT,              -- fk → customers.phone
  status          TEXT,              -- done / partial / no_show / cancelled
  actual_amount   INTEGER,           -- cents
  payment_method  TEXT,              -- cash / payid / mixed / unpaid
  paid_at         INTEGER,
  gas_used_g      INTEGER,
  photos_url      TEXT,
  our_notes       TEXT DEFAULT ''
);
```

---

### 第 1 波（✅ 已实施 2026-11-13）

**实现顺序**（有依赖关系）：
1. `bookings_meta` + `customers` schema + 状态/支付/实收 modal ← 核心
2. 当日营业额 + Cash/PayID/Unpaid 小计
3. Edit 预约字段（独立，可并行）
4. 冷媒量显示（独立，可并行）
5. 月/年收入汇总（有数据后）

---

**D1 schema 定稿：**

```sql
customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT UNIQUE,         -- SMS 客户主键；FB 客户可能 NULL
  psid            TEXT UNIQUE,         -- FB 客户主键；SMS 客户 NULL
  name            TEXT,
  first_seen      INTEGER,
  last_seen       INTEGER,
  visit_count     INTEGER DEFAULT 0,
  total_paid      INTEGER DEFAULT 0,   -- cents
  notes           TEXT DEFAULT ''
);

bookings_meta (
  calendar_uid    TEXT PRIMARY KEY,
  phone           TEXT,                -- 快照存一份方便查询，不是 FK
  psid            TEXT,
  status          TEXT,                -- done / partial / no_show / cancelled
  actual_amount   INTEGER,             -- cents
  payment_method  TEXT,                -- cash / payid / mixed / unpaid
  paid_at         INTEGER,
  our_notes       TEXT DEFAULT ''
  -- 注意：不存 gas_used_g（Andy 没时间做这个动作）
);
```

---

**1. 工单标记 modal（核心）**

- 入口：点打印页任意一行 → 弹 modal
- 字段 + 默认值：
  - **Status**：`done`（默认） / `partial` / `no-show` / `cancelled`
  - **Payment**：上次这个客户用的方法，没记录就 Cash
  - **Actual amount**：默认 = 报价
  - **Notes**（可选）
  - **Clear** 按钮：清掉所有标记恢复"未标"状态
- **No-show 的单不删 Calendar 事件**（保留历史）
- 存 `bookings_meta` 表
- 已标记工单在打印页右侧显示 badge：`[💵 $155 Cash]` / `[⚠ $50 Partial]` / `[✗ No-show]`

**2. 当日营业额 + 小计（打印页）**

- 屏幕上顶部 h2：`9 bookings · Quoted $1,410 · Collected $1,245 (Cash $800, PayID $445) · 1 unpaid`
- **打印时**：底部单独一行印 `Collected $1,245 · Cash $800 · PayID $445 · Unpaid 1`（方便对账）

**3. Edit 预约字段**

- 跟工单标记 modal **合并成一个 modal 两个 tab**：
  - 📝 **Details**：Service / Price / Vehicle / Address / Customer / Mobile / Notes
  - 💵 **Status / Payment**：上面那 4 个字段
- 不改 Time / Date / Source
- 不通知客户
- 改 Price 会影响 Quoted 合计；改 Service 会影响 Calendar 标题

**4. 冷媒量显示（不输入）**

- Vehicle 字段解析走 **方案 C**：
  - AI 新建预约时在 schema 里多返回 `vehicle_make` / `vehicle_model` / `vehicle_year` / `vehicle_variant`
  - 存进 Calendar description 的 X-属性 或 单独字段
  - 打印页从结构化字段读 → 查 `vehicles` D1 → 显示建议克数
- 多候选处理：`"500g or 580g"`（variant 不明时）
- 老预约 fallback：无结构化字段 → 不显示（不猜）
- Andy **不输入**实际用量（没时间）；需要时参考打印页上的建议值

**5. 月/年收入报表**

- 新页面 `/report?secret=…[&year=2026&month=11|&period=ytd]`
- 最小版：**文本表，不做图表**
- 显示：
  - 时段内 N 个 bookings、Quoted 合计、**Collected 合计**（分别出：差额就是漏收）
  - Cash / PayID / Mixed / Unpaid 各自金额
  - 每天汇总（最近 30 天或选定月份）
  - Top services、Top vehicle makes
- 导出 CSV 按钮（给会计）

---

**UX 原则**（跨所有 Phase 1 功能）：
- 手机优先：按钮大、少打字
- 默认值预填到位：理想状态下标记一单只要 2-3 次点击
- 不做实时同步（SSE/polling）：手动 `Cmd+R` 刷新够用
- 刷新快，不到 2 秒

### 第 2 波（客户数据沉淀，上面做完再谈细节）

- [ ] **客户列表**（按电话索引）
- [ ] **历史服务记录**（点客户 → 看他所有预约）
- [ ] **老客户自动识别**（新预约时标 "repeat customer, 上次 6 个月前"）
- [ ] **车型记忆**（客户的车自动绑定，下次不用再问）
- [ ] **常用备注**（"难搞" / "现金优先" / "门口没停车位" 等）

### 第 3 波（主动营销）

- [ ] **年度回访提醒**（1 年没来 → Bark 推送提示发个短信）
- [ ] **拍照附件**（压力表、客户车，防纠纷。要规划存储，R2 适合）
- [ ] **"在路上了" 一键发短信**
- [ ] **CSV 导出给会计**
- [ ] **PayID 收款 QR 码生成**

### 长期（需要更大设计）

- [ ] **自动报价系统** — 见本文件顶部"AI 自动报价"段落
- [ ] **库存管理**（冷媒罐余量、O-ring/valve 库存）
- [ ] **路线优化**
- [ ] **拜访路径地图 / 区域热力图**
- [ ] **货车保养 / 保险 / 年检到期提醒**
- [ ] **Xero / MYOB 会计集成**
- [ ] **电子发票 SMS 自动发送**

### 车型数据库需要补齐 / 修正

- [ ] **GasBook2014 已过时** —— 覆盖范围主要到 2013，很多 2014+ 的车（Qashqai, DMax 2017, i40, C250 W205, IX35, CX-5 2014+ 等）都没有。需要补充新数据源：
  - Haynes Online / Autodata 订阅
  - 客人上门前要 AC 标签照片
  - 做完一单新车型 → 顺手录进 `/vehicles`
- [x] **~~Hyundai 数据被解析器搞砸~~** （2026-11-14 修复）—— parser 的 "pending_model 覆盖当前 model" 逻辑错误，把真实车型（如 Santa Fe SM）塞进 notes 字段，用 "Dual A/C" 等变体描述当 model。修 parser 后重新 import，48 条 Dual A/C + ~140 条其他 mislabel（Includes Turbo / MF Condenser / Denso Compressor 等）全部复位到正确车型的 variant/notes。只剩 2 条 BMW condenser 变体是边界情况。

### 备选 / 低优先（记下来但可能不做）

- 忙闲时段图表
- 常见车型 TOP 10（指导备什么耗材）
- 月环比、年同比收入 trend
- 区域热力图
- 设备校准日期管理
- 库存低自动提醒
- 服务后自动请求好评

---

## Backup（保留但不主动使用）🗄️

- 旧 Shortcut 预约流程：`/imessage-task` + `/imessage-poll` + `/imessage-result` + `poll()` in server.py
- 截图触发预约：`/sms-booking` + `doSmsBookingFromImage()` + `aiFromScreenshot()`

---

## 已完成 ✅

**iMessage 关键词触发**
- [x] "Booking confirmed" → 建日历 + 回复客人 + Bark 通知
- [x] "Booking updated" → AI 检测变更字段 → 更新日历 → 回复客人（只显示改了的字段）
- [x] "Booking cancelled" → 删除日历事件 → 回复 "Feel free to rebook anytime!"
- [x] 关键词可出现在消息任意位置（不限于开头）
- [x] 回复格式：`✅ Andy Auto AC Regas / Time: DD/MM Weekday, H:MMpm / See you then!`

**Bug 修复**
- [x] typedstream 解析 bug（`rBooking confirmed` 前缀）
- [x] decode_text 返回完整消息内容（不截断关键词前文字）
- [x] AppleScript 发送 emoji 报错（`✅` 语法错误 -2741）
- [x] send_imessage 加超时 + 失败详细日志

**稳定性**
- [x] PID 锁（防止多个 server.py 同时运行）
- [x] SIGTERM handler（日志记录崩溃原因）
- [x] plist 加 ThrottleInterval 10（防止崩溃死循环）
- [x] upgrade.sh 一键升级（自动更新 server.py + plist + 重启）

---

## 已完成 ✅ — 2026-11（SMS 稳定性 + 打印页改版）

**SMS 触发稳定性（server.py）**
- [x] macOS Sonoma 的 attributedBody 解码：NSUnarchiver（PyObjC）正确读取纯 SMS 的消息文本
- [x] Heuristic fallback（PyObjC 不可用时）：过滤 plist 元数据（`$version`/`$archiver`/`kIM*`），返回最长的候选字符串
- [x] **PyObjC 装在"对的"Python 上**（2026-11-13）：之前装在 Homebrew Python 3.11，但 launchd 实际跑 CommandLineTools Python 3.9。NSUnarchiver 没生效，heuristic 对 iOS 自动加超链接的消息（日期/价格）只能抓到 link 元数据碎片。装 `pyobjc 10.3.1`（Python 3.9 最后一个有预编译 wheel 的版本）到 3.9 后端到端验证通过。详细见 [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md#pyobjc-装在对的-python-上)
- [x] `clean_contact_name` 重写：剥离任意组合的日期/星期/时间前缀（如 `18/10 Sunday 3pm Bob` → `Bob`，`18/10 Sun` → ``）
- [x] `scan_keywords` SQL 加 LEFT JOIN + `chat_identifier` fallback，SMS 对话缺少 `chat_handle_join` 时也能查到
- [x] decode 失败时打日志（原本静默跳过，无法定位问题）

**AI 提取稳定性（worker.js）**
- [x] `trimToLastConfirmation` 修复多行 ✅ 块的 bug：原本只跳过标题行，`Time:` / `See you then!` 等后续行漏入 AI 视野
- [x] `redactOldConfirmationTimes`：对 CONFIRMED action 把历史 ✅ 的 `Time:` 行替换成 `[past booking]`，地址/车型保留，旧时间不再干扰
- [x] `appendTriggerMarker`：对话末尾明示"最后那条 Booking confirmed 才是触发点，旧 ✅ 的时间已被 redact"
- [x] `redactPriorTriggerMessages`（2026-11-14）：同一线程里 Andy 发了第二条 `Booking confirmed` 时，把前一条的正文换成 `[past booking trigger — ignore]`，防止上一次的 "for tonight 7:30pm" 被 AI 当成新时间复用；`appendTriggerMarker` 也升级成把最新触发消息原文**引用**给 AI
- [x] Prompt 加硬：contact label 永远不能作为日期/时间/地址/服务/价格/车型/手机号的来源
- [x] `service` schema 允许多项目描述（如 `Change O-ring, replace valves and regas`），不再被压缩成 1-3 字
- [x] `doKeywordBooking` 加日志（对话长度、AI 提取字段），失败可追溯

**地址规范化**
- [x] `normalizeAddress`：剥离 state（QLD/NSW/VIC/…）、country（Australia）、4 位邮编
- [x] 自动把末尾的 `Unit X`/`Apt X`/`Flat X` 移到地址前端
- [x] 三处调用：AI 后处理、历史地址 fallback、`splitAddress`（显示层），不用迁移数据

**打印页改版（`/print`）**
- [x] Service 从 description 读（保留完整多项描述），覆盖掉旧 `parseSummaryFields` 的首词截断
- [x] `parseSummaryFields` 无年份时整段当 service，不再被首个空格切开
- [x] 地址智能分两行：街道 + suburb（通过最后一个 comma，或街道后缀 Road/St/Ave/…）
- [x] Customer 和 Mobile 合并一列（名字加粗，电话灰色小字；name==mobile 时去重；email 格式识别为灰色小字）
- [x] FB/SMS pill 黑白友好：SMS 黑底白字实心，FB 白底黑字描边
- [x] 列宽重分配：# 和 Src 收窄，Service/Vehicle/Address 加宽，Customer 定宽 130px
- [x] 去除 SMS 行灰色背景（Src pill 已足够区分来源）
- [x] 空单元格留白（方便 Andy 手写），不显示 `—`
- [x] # 列左对齐
- [x] h2 简化为 `N bookings · $X total`
- [x] 📝 Notes 栏：顶部可编辑文本框，防抖自动存 Cloudflare KV，每天独立 key，60 天 TTL；空的时候打印不显示
- [x] 打印时字号 1.2x（0.94em 表格字号）+ 紧凑 padding
- [x] 1-9 单压缩一页；10+ 自动在第 10 行强制换页，避免被截断

---

## 已完成 ✅ — 2026-11（车型冷媒数据库 + 打印页二次优化）

**车型冷媒数据库（Cloudflare D1 + Web 管理页 `/vehicles`）**

初版 schema + CRUD：
- [x] D1 数据库 `andy-auto-db`（Oceania/SYD 区），binding `DB`
- [x] `schema.sql`：`vehicles` 表（id, make, model, year_start, year_end, variant, refrigerant, charge_g, notes, updated_at）+ `idx_vehicles_make_model` 索引
- [x] `wrangler.jsonc` d1_databases binding 挂好
- [x] CRUD API `/vehicles/api?secret=…`
  - GET list / search（带 `q=` 和 `year=` 参数）
  - POST create（含字段校验：refrigerant 必须 R134a/R12，charge_g 1-5000，year 1950-2100）
  - PUT ?id=… / DELETE ?id=…
- [x] 查询 API `/vehicle-lookup?make&model&year&variant`：精确 variant 匹配优先，fallback 到 generic（variant 空）条目，用于未来的自动报价系统
- [x] Admin HTML 页面：搜索框 + 列表 + Add/Edit modal + Delete 确认
- [x] R1234yf 从 UI 完全移除（Andy 目前不提供这项服务；validation 只接受 R134a/R12；form dropdown、price bar、highlight 样式全部清理）
- [x] 砍掉 oil_type + oil_ml 字段（远程 D1 `ALTER TABLE DROP COLUMN` 已执行）
- [x] Admin 列表显示：Make / Model / Variant **拆成 3 列**（原来挤在一起）
- [x] `.gitignore` 加 `.wrangler/`，不再跟踪本地 miniflare 缓存

数据导入：
- [x] 从 CoolDrive GasBook2014 Online PDF（72 页）解析 **1979 条**车型数据
- [x] `scripts/parse_gasbook.py`：
  - 按字体过滤 watermark（AvenirNextCondensed vs 内容字体 HelveticaNeueLTStd）
  - 按坐标分列：model / notes / years / charge
  - 已知 make 白名单防止误识别（如 `320i, 323i, M3` 不会被当新 make）
  - 跨行条目合并（BMW 冷凝器变体等）
- [x] `scripts/gen_sql.py`：
  - 年份格式归一化（`88-92` → 1988-1992，`07>` → 2007-2100 哨兵值，`5/00-08` → 2000-2008 月份丢弃）
  - charge 范围取中位数四舍五入到 5g（原范围保留在 notes）
  - 从 model 拆出 variant（如 `A4 (8K)` → model=`A4`/variant=`8K`）
  - refrigerant 默认 R134a（book 是 2014 的，R1234yf 车很少，遇到手动改）
- [x] 覆盖 67 个品牌：Toyota 179, Nissan 129, Mercedes-Benz 113, Ford 112, BMW 90, Mitsubishi 90, Holden 84, Mazda 76, Honda 72 …

搜索增强：
- [x] 搜索框自动识别 4 位年份：`camry 2013` → text=`camry` + year=`2013`，后端 SQL 加 `? BETWEEN year_start AND year_end`
- [x] 绿色 `year 2013` 芯片显示识别到的年份
- [x] 搜索按 token 拆分，每个 token 都要匹配：`mazda cx-5 2018` 拆成 `['mazda','cx','5']`，能命中 DB 里的 `Mazda CX5`
- [x] 开放式年份显示：`2007-2100` 改成 `2007+`（后端存储不变，纯显示层）

冷媒价格 + Cost 列：
- [x] 顶部黄色价格条：R134a $/kg 输入（R1234yf 已移除），防抖自动存 KV（`BARK_COOLDOWN` key `refrigerant_prices`，JSON blob）
- [x] 新增 `GET/POST /refrigerant-prices?secret=…` endpoint
- [x] Cost 列实时计算 `charge_g × 单价 ÷ 1000`，键盘输入价格时表格立刻更新（不用刷新）
- [x] 决策记录：**不在每行存 cost**，避免冷媒价格一变要批量 UPDATE 1979 行；用单一 KV 值派生

**打印页二次优化（`/print`）**
- [x] 街道后缀 regex 扩充：新增 `Cr`（Crescent/Court）、`Gr`/`Grv`（Grove）、`Sq`（Square）、`Pkwy`（Parkway）、`Mews`、`Link`、`Rise`、`Quay`、`Bay`。例：`30 Bedford Cr Eagleby` → `30 Bedford Cr` / `Eagleby`
- [x] Service 列优先级反转：**Calendar 标题（summary）优先**，fallback 到 description 的 `Service:` 行。之前 description-first 会让 Andy 手动编辑的标题（如 `Change O-ring, replace valves and regas`）在打印页仍显示旧的短 `Regas`
- [x] 删除 `parseSummaryFields` 的 `MANUAL_SERVICE_KEYWORDS` 关键词替换逻辑（遗留的过度简化）
  - Bug：匹到关键词就丢掉整句，例：`Repair Philip crv` → `repair`；`regas and orings` → `regas + oring`；`add uv dye and pressure test` → `add uv dye + uv dye + pressure test`（重复）
  - 修复：手动标题直接用完整文本（减去 `$price` token），所见即所得
  - AI 自动创建的 Calendar 路径不受影响（AI prompt 已要求保留多项目服务，后处理只 `.trim()` 不替换）
