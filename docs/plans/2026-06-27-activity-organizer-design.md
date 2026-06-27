# 活动组织者字段设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。

## 目标（动机）

活动目前只有 `createdBy`（openid），详情页仅在名单里给创建者挂个「发起人」标签，没有可读的「谁办的」展示。要给活动加一个**组织者**展示字段：缺省为创建者昵称，可改成别的（如俱乐部名）；一旦填了自定义值，该创建者今后建活动**缺省沿用上次用的**（记住偏好）。

## 三个已拍板的决策

1. **显示位置 = 详情页头部 + 首页列表卡片**（都加一行 👤 组织者）。
2. **纯展示标签 + 自由文本**：不驱动任何业务逻辑；和 `clubId`/选群**无关**（"俱乐部名"只是可填内容的举例，不自动联动）。
3. **记住偏好用显式 `user.defaultOrganizer` 字段**（方案 A），不从历史活动推断——活动删了/改了偏好还在，显式好测。

## 数据模型（新增 2 个字段）

- `activity.organizer`：字符串。
- `user.defaultOrganizer`：字符串，缺省 `''`。

## 后端（`server/src/logic.js`，**无新端点**）

- **`createActivity`**：
  ```js
  const creator = ensureUser(state, creatorOpenid);
  // ...
  organizer: (input.organizer || '').trim() || creator.nickname,  // 空了兜底昵称，永不为空
  ```
  在 txn 内同时：`creator.defaultOrganizer = a.organizer`（记住这次用的，**仅创建时更新**）。
- **`updateActivity`**：`if (input.organizer !== undefined) a.organizer = (input.organizer || '').trim() || a.organizer`（可编辑，但**不更新** `defaultOrganizer`——编辑老活动不该改默认）。
- **`publicActivity`**：透出 `organizer: a.organizer || null`。
- **`ensureUser`**：新用户加 `defaultOrganizer: ''`。
- **`GET /api/user/me`**：下发 `defaultOrganizer`（create 页预填用）。

> 注：`createRecurring` 循环调 `createActivity`，每场都带 organizer、`defaultOrganizer` 被覆盖为同值——幂等，没问题。

## 前端

### create 页（`pages/create/create.{js,wxml}`）
- `data.organizer: ''`。
- **`onLoad`**：拉 `GET /api/user/me` → 预填 `organizer = me.defaultOrganizer || me.nickname`。
- `loadForEdit`：`organizer = a.organizer`（编辑模式回填）。
- `copyLast`：带上 `last.organizer`（复制上一场一并带上）。
- `submit`：payload 带 `organizer`（即便空也带，后端兜底昵称）。
- wxml：标题下方加一行「组织者」输入框。

### 详情页（`pages/detail/detail.wxml`）
- 头部标题下加一行 `👤 {{detail.organizer}}`。

### 首页（`pages/index/index.wxml`）
- 卡片地点下方加 `👤 {{item.organizer}}`（muted 小字）。

## 「记住偏好」规则（明确）
- 每次创建用当次的组织者名覆盖 `user.defaultOrganizer` = 记住"最近一次创建用的"。
- 清空提交 → 活动存昵称，`defaultOrganizer` 也变成昵称 → 下次预填回昵称（等价"重置"）。
- 编辑活动改 organizer **不**影响 `defaultOrganizer`。

## 测试（`server/tests/logic.test.js`）
- 创建不传 organizer → `a.organizer === creator.nickname`，且 `creator.defaultOrganizer === nickname`。
- 创建传自定义 → 存自定义；`defaultOrganizer` 更新为该值。
- publicActivity 透出 organizer。
- updateActivity 能改 organizer，但**不动** `defaultOrganizer`。

## 已知简化
- 自由文本，不校验、不联动 clubId。
- 不做"组织者"维度的搜索/筛选/统计。
- 首页卡片加一行 👤，接受轻微变挤。

## 不做（YAGNI）
- 选群时自动用群名填组织者。
- 从历史活动推断默认（用显式字段）。
- 编辑活动时更新默认偏好。
- 组织者单独的实体/资料页。
