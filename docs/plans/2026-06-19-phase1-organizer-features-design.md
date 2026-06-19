# Phase 1 设计 — 组织者三件套 + 玩家标签

- 日期：2026-06-19
- 状态：已确认（细化）
- 定位：面向大众的公开产品 + **组织工具楔子（靠 B 端组织者传播）**
- 目标：让组织者愿意从「群接龙 + 群收款」切换过来——缓解重复建场、补齐留存通知、自带传播、给名单增加可读维度。

## 范围（Phase 1 = 4 项）

1. 复制上一场（缓解每周重复建场）
2. 订阅消息·**候补上位通知**（仅此一条；开始提醒/调度器留到 Phase 2）
3. 可分享活动海报（运动主题背景）
4. 水平标签 + 性别标签（玩家自填，名单展示）

> 不做（Phase 2+）：微信支付收费、活动开始提醒（需调度器）、成员 CRM/出勤统计、玩家日历/历史、自动分队/均衡。

---

## 功能 1 · 复制上一场

**后端**
- 新增 `GET /api/activities/created-by/me`（`requireAuth`）。
- `logic.js` 加 `myCreatedActivities(store, openid)` → 按 `createdAt desc` 返回 `publicActivity[]`（复用现有结构，无 schema 变更）。

**前端**（`pages/create`）
- 顶部「复制上一场」按钮 → 拉最近一场 → 预填 `title/location/description/capacity`；`start = 上一场.startTime + 7 天`（保持同星期几），时间沿用；用户微调后照常提交。

**数据**：无变更。

---

## 功能 2 · 订阅消息·候补上位通知

**模板**：在小程序后台「订阅消息 → 公共模板/自建」创建「候补上位通知」，取 `templateId`，配置进 `server` config 与小程序 config。字段建议：`活动名称 / 时间 / 地点 / 备注`（具体字段以后台模板为准）。

**前端**（`pages/detail`）
- 点「报名」时，先 `wx.requestSubscribeMessage([上位模板id])` → 把用户**同意**的 templateId `POST /api/subscriptions`。

**后端**
- `user.subs = { [templateId]: 数量 }`（一次性订阅 = 一次发送配额）。
- 新增 `POST /api/subscriptions {templateId}`（`requireAuth`）→ 该 openid 该模板 +1。
- `wxapi.js` 加 `sendSubscribeMessage(openid, templateId, data, page)`（复用 `getAccessToken`，走 `cgi-bin/message/subscribe/send`）。
- `logic.cancel`：候补**上位后**，若上位者在 `subs` 里有该模板配额 → 调 `sendSubscribeMessage` 发送并 -1；失败/无配额则跳过（不影响上位本身）。

**设计取舍**：不引入调度器；上位通知是事件驱动（cancel 触发），无需定时任务。开始提醒（需 cron）留 Phase 2。

**数据**：`user.subs`；`activity` 无变更。

---

## 功能 3 · 可分享活动海报（运动主题背景）

**纯前端**，`pages/detail`
- 「生成海报」按钮 → `<canvas type="2d">` 绘制：
  - **背景**：品牌绿渐变 + 🏸 motif（`fillText`/几何形状），**不依赖外部图片**；后续可换成打包的 bg 图。
  - **内容**：标题、时间、地点、名额（X/Y）、活动说明摘要。
  - **二维码**：`wx.downloadFile(GET /api/activities/:id/qrcode)` → `drawImage`。
- `wx.canvasToTempFilePath` → 存相册 / 分享图片。

**后端**：零改动（二维码端点已存在）。

---

## 功能 4 · 水平标签 + 性别标签

**数据**（`user`）
- `level`：枚举 `新手 / 初级 / 中级 / 高级`，可空。
- `gender`：枚举 `男 / 女 / 不公开`，可空。

**后端**
- `updateProfile` 增加对 `level`、`gender` 的白名单 + 枚举校验。
- `enrichActivity` 的名单 entry（`confirmed`/`waitlist`）每项追加 `level`、`gender`，用于名单展示。

**前端**
- `pages/profile`：加水平 `<picker>` + 性别 `<picker>` → `PATCH /api/user/me`；首次进入引导填写。
- `pages/detail` 名单：每人名后挂水平/性别小徽章；名单顶部可选汇总「男 X / 女 Y」。

---

## 跨功能：数据模型与端点汇总

**变更**
- `user`：`+ level, gender, subs{}`。
- `activity`：Phase 1 无变更。

**新端点**
- `GET /api/activities/created-by/me`（requireAuth）
- `POST /api/subscriptions`（requireAuth）

**复用**
- `PATCH /api/user/me`、`GET /api/activities/:id/qrcode`、`wxapi.getAccessToken`。

---

## 测试策略

- **后端（node:test，针对 logic）**：
  - `myCreatedActivities` 只返回本人发起、排序正确。
  - `updateProfile` 拒绝非法 `level`/`gender` 枚举值。
  - 名单 entry 含 `level`/`gender`。
  - `cancel` 上位后触发「上位通知」：注入一个假的 `sendSubscribeMessage`，断言被调用且 `subs` 配额 -1；无配额时不发送、上位不受影响。
  - `POST /api/subscriptions` 配额 +1。
- **前端**：海报 canvas 渲染靠真机；复制上一场 / 标签用模拟器 + 真机验证。

---

## 实现顺序

1. **复制上一场**（后端小 + 前端小，先落地、低风险）。
2. **水平 / 性别标签**（后端 schema + 前端，与其它功能正交）。
3. **海报**（纯前端，独立）。
4. **订阅消息·上位通知**（依赖后台模板 id + access_token，最后做）。
