# TODO

## 紧急 / 清理 🧹

- [ ] **删除旧的 Shortcut 预约代码**（用电话号码触发那套）
  - 已不再使用，拖慢程序，直接删掉
  - 涉及 worker.js 里的相关 endpoint

---

## 待做：iMessage 关键词触发 📲

- [ ] **Booking Updated**
  - Andy 发 "Booking updated" → AI 识别变更内容（时间 / 地点 / 项目）→ 更新日历 → 回复客人

- [ ] **Booking Cancelled**
  - Andy 发 "Booking cancelled" → 删除或标记日历事件 → 回复客人取消确认

---

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

## 已完成 ✅

- [x] iMessage "Booking confirmed" 自动触发：建日历 + 回复客人 + Bark 通知
- [x] typedstream 解析 bug（`rBooking confirmed` 前缀）
- [x] AppleScript 发送 emoji 报错（`✅` 语法错误 -2741）
- [x] send_imessage 加超时 + 失败详细日志
- [x] PID 锁（防止多个 server.py 同时运行）
- [x] SIGTERM handler（日志记录崩溃原因）
- [x] plist 加 ThrottleInterval 10（防止崩溃死循环）
- [x] 回复格式：`✅ Andy Auto AC Regas / Time: DD/MM Weekday, H:MMpm / See you then!`
- [x] upgrade.sh 一键升级
