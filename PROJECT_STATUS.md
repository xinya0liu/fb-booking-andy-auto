# PROJECT_STATUS

> 项目当前进度快照。完成重要任务后请更新本文件（见 `CLAUDE.md` 的"模型分工"段落）。
> 完整待办看 [TODO.md](./TODO.md)；设计决策和时间线看 [docs/HISTORY.md](./docs/HISTORY.md)。

**更新时间：** 2026-11-21
**当前分支：** `main`（本次改动未 commit：`worker.js` + README + MAINTENANCE + TODO + HISTORY + 本文件；另 `fb-booking-admin` 两处）

---

## 当前聚焦 🎯

**Admin `/run` 页"一键联系客人"**（刚完成 FB 侧）
- SMS 客人已有 `sms:` 直达预设按钮（On my way / Arrived / Running late）
- FB 客人现在也一键直发——worker `POST /api/messages/send-fb` 走 Messenger Send API，admin 用 server action 调它；按钮 UI 显示 Sending… → Sent ✓
- 曾考虑的 FBID 深链接方案已否决（见 HISTORY 2026-11-21）

**Admin 后台 API**（之前在推进的 JSON 层）
- `GET /api/bookings` / `POST /api/bookings/create` / `GET /api/customers`
- 下一步：
  - [ ] 建配套的 Admin UI 页面消费这些 API
  - [ ] `/api/customers` 的聚合视图继续加字段（最近预约、payment summary 等）

## 下一步候选 📋

从 [TODO.md](./TODO.md) 里挑的几个方向（按优先级粗排）：

**CRM 第 2 波**
- [ ] 客户列表页（按电话/PSID 索引）
- [ ] 客户详情：历史服务记录
- [ ] 老客户自动识别（新预约时标 `repeat customer, 上次 6 个月前`）
- [ ] 车型记忆（客户的车自动绑定，下次不用再问）

**AI 自动报价（长期）** —— 需要 Andy 先准备：
- [ ] 整理附近 suburb 列表 + 每个 suburb 的附加费定价
- [ ] 确认未知 suburb 的距离附加费计算公式

**车型数据库维护**
- [ ] 补齐 2014+ 车型（GasBook2014 已过时，很多新车没覆盖）
- [ ] 建立"做完一单新车型 → 顺手录进 `/vehicles`"的流程

## 最近完成 ✅

**2026-11-21**
- Admin `/run` 页 FB 客人也能一键发预设消息：worker 加 `POST /api/messages/send-fb`，admin 加 `sendFbMessage` server action，`RunCard.tsx` 按钮直发（替代旧的"复制 + 跳收件箱"）

**2026-11-20 前后**
- `GET /api/customers` 增加 `psid` + `sources` 字段
- `/api/customers?phone=fb:PSID` 跳过电话号码 normalize（PSID 不是电话）
- 新增 `POST /api/bookings/create`（Admin 手动建单 + 跟进）
- 新增 `GET /api/bookings`（Admin 后台 JSON）

**2026-11-19**
- `/report` 按服务日期分组（之前按 `paid_at`，一次性补标把 63 单都塞进同一天）
- `bookings_meta` 加 `service_date_ms` 列
- 新增 `/admin/backfill-service-dates` 幂等端点

**2026-11-14（当天多项）**
- SMS AI 加固：`redactPriorTriggerMessages` + 把最新触发消息原文引用给 AI
- Notes 拆成 `AI notes:` + `Notes:`（AI 永远不覆盖 Andy 写的）
- Payment 金额支持负数（退定金 / 找零），每个金额输入框加 `±` 按钮（iOS 数字键盘没减号）
- 车型 DB 加第三个数据源 Hychill（9489 条，澳洲本地），总条数 14781
- Vehicles make/model 大小写 + hyphen 统一；admin 页同 make/model/年份/克数的多 variant 自动折叠

**2026-11-13**
- Phase 1 CRM 发布：`customers` + `bookings_meta` schema，打印页点击行弹 modal（Status/Payment/Actual Amount + Details 编辑），当日营业额 + Cash/PayID/Unpaid 小计，Gas 列查 vehicles DB，`/report` 月年报表 + CSV 导出
- Mixed payment 支持 `cash_portion` + `payid_portion`
- `/bookings/edit` 换成拉 ±400 天窗口在 Worker 里匹配 UID（iCloud `text-match` 返回 412）

更早的完成项看 [TODO.md 底部的"已完成"段落](./TODO.md) 和 [docs/HISTORY.md 时间线](./docs/HISTORY.md)。

## 已知坑 / 待讨论 ⚠️

- GasBook2014 数据覆盖主要到 2013，2014+ 的很多车型（Qashqai, DMax 2017, i40, C250 W205, CX-5 2014+）在 DB 里找不到 → Nissens 和 Hychill 补了一部分，但仍有缺口
- Suburb 距离附加费公式未定（AI 自动报价的前置依赖）
- 24h 窗口外的客人目前要手动确认（Meta 消息标签还没研究）
