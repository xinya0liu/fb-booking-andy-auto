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

**状态存储：** Cloudflare D1（为后续 CRM 打基础）

### 待实现

- [ ] Suburb 距离数据库（Eagleby 40km 内）+ 定价区间（待讨论）
- [ ] 车型冷媒重量数据库
- [ ] D1 对话状态表（PSID、车型、地址、状态、时间戳）
- [ ] Facebook 多轮对话逻辑（状态机）
- [ ] 审批页面（`/quote-review?id=xxx&secret=xxx`）
- [ ] 定时跟进（几分钟后 / 客人指定时间）
- [ ] 日历空档查询 + 时间推荐

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
