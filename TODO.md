# TODO

## 待做：AI 自动报价 💬

客人发消息询价时，AI 自动引导对话：

1. 客人发车型 → AI 查该车型需要多少冷媒重量
2. 客人发地址 → AI 根据距离计算出行费用
3. AI 综合车型 + 地址 → 自动生成报价回复给客人
4. AI 查询日历空闲时间窗口 → 给客人推荐可预约时间

适用渠道：Facebook Messenger、SMS

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
