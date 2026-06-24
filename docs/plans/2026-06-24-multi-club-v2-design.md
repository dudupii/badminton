# 多群/俱乐部 v2（独立页面）设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。

## 目标

组织者建群（邀请码）→ 球友加群 → 群内活动隔离。**不修改任何现有页面**（index/create 零改动、profile 只加一行入口）。

## 与上次（v1）的区别

上次同时改了 index + profile + create 三个重页面，导致 nwjs 编译器冻结。本次只新增 1 个独立页面 + profile 加 1 行入口。

## 后端（从 backup-post-v2 恢复，已测过 55→57）

- `state.clubs` + `club.members:[openid]`
- `createClub / joinClub / listMyClubs / getClub / deleteClub`
- `activity.clubId`（可选，null = 全局）
- `listActivities({clubId})` 过滤
- 路由：`POST/GET /api/clubs`、`POST /api/clubs/:code/join`、`GET/DELETE /api/clubs/:id`

## 前端

### 新增 `pages/clubs/clubs` 页面（自包含）
- **群列表**：我的群（名字/成员数/邀请码/复制按钮）
- **建群**：输入群名 → POST → 显示邀请码
- **加群**：输入邀请码 → POST join → 加入
- **群内活动**：点群 → `GET /api/activities?clubId=xxx` → 列表
- **删群**：创建者可删

### Profile 改动（仅 1 行 wxml + 1 个方法）
```xml
<view class="card" bindtap="goClubs">球友群 ›</view>
```
```js
goClubs() { wx.navigateTo({ url: '/pages/clubs/clubs' }); }
```

### app.json 改动
`pages` 数组加 `"pages/clubs/clubs"`

### 不改动
- `index/index.{js,wxml}` — 零改动
- `create/create.{js,wxml}` — 零改动
- `detail/detail.{js,wxml}` — 零改动

## v1 不做（v2 再加）
- 列表群筛选 tab（改 index）
- Create 页选群 picker（改 create）
- 确认 v1 不冻结后再加

## 测试
- 后端 Club CRUD + activity.clubId（从 backup 恢复，已有测试）
- 前端 `node --check`
- HTTP 实证
