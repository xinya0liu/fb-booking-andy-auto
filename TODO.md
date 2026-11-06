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
- [ ] 车型冷媒重量数据库
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

## 待做：每日收入汇总 💰

- [ ] **`/summary` 页面**
  - 读取当天所有日历预约，列出每单 Service / Price / Customer
  - 每单旁边有按钮：Cash / PayID（点击记录支付方式）
  - 底部汇总：今日总收入、现金小计、PayID 小计
  - 支付方式存储在 Cloudflare KV（key: 日历事件 UID）
  - 需要先建好 D1 或 KV 存储方案

---

## 待做：CRM / 看板 📊

- [ ] 建一个看板，集中显示所有客人信息：
  - 姓名、电话、车型、地址、历史预约、报价记录
  - 支持后续跟踪（follow-up）
  - 可能用 Cloudflare D1 或外部工具实现

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
