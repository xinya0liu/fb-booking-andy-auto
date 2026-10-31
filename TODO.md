# TODO

## 进行中 🔧

- [ ] 确认崩溃循环是否彻底解决
  - 下次出现崩溃，检查日志是否有 "Received SIGTERM — shutting down cleanly."
  - 有 → launchd 主动杀进程，原因待查（网络超时？资源占用？）
  - 无 → 代码本身崩溃，截图发给 Claude

## 待做 📋

- [ ] 弄清楚 launchd 为什么会发 SIGTERM（正常运行时不应该发）
  - 怀疑：Worker 返回 500 时进程被卡住超时，launchd 强杀
  - 验证方法：在日志里对比 SIGTERM 时间和 Worker 500 时间

- [ ] 测试多设备发 "Booking confirmed" 是否都能正常触发
  - iPhone ✅（已测试）
  - iPad ❓
  - Mac ❓

- [ ] 考虑加 Bark 通知：回复客人失败时通知 Andy
  - 目前 SEND FAILED 只打印到日志，Andy 不会即时知道

- [ ] 客人回复消息后是否需要 AI 继续处理？
  - 目前只做单向：Andy 发关键词 → 回复客人 → 结束
  - 客人如果回复"谢谢"等，暂不处理

## 已完成 ✅

- [x] typedstream 解析 bug（`rBooking confirmed` 前缀）
- [x] AppleScript 发送 emoji 报错（`✅` 语法错误 -2741）
- [x] send_imessage 加 30 秒超时
- [x] send_imessage 失败时打印详细错误（SEND FAILED）
- [x] PID 锁（防止多个 server.py 同时运行）
- [x] SIGTERM handler（日志记录崩溃原因）
- [x] plist 加 ThrottleInterval 10（防止崩溃死循环）
- [x] 回复格式：`✅ Andy Auto AC Regas / Time: DD/MM Weekday, H:MMpm / See you then!`
- [x] upgrade.sh 一键升级（自动更新 server.py + plist + 重启）
