# 轮转表号码 + 图片导出 设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。建立在 Phase 5 轮转调度之上。

## 目标

两项改善：
1. **名字加号码**：轮转表里每个球友名字前加报名序号（如「1-小张」），屏幕展示和导出图片都加。
2. **导出 PNG**：把轮转表画成图片，预览/存相册/转发给微信群（小程序不能自动发群，靠生成后手动转发）。

## 确认决策

1. 号码 = **报名序号**：`detail.confirmed` 里第几个报名就是几号（1-based，与正式名单显示的序号一致）。
2. **前端注入**（不改后端）：生成/加载轮转后，给 schedule 里每个 player entry 注入 `no`。屏幕和 canvas 都显示「N-名字」。
3. 导出入口：轮转结果区一个「导出轮转表(图片)」按钮 → 画 canvas → 预览图（长按存/转发）。
4. 休息者也编号列出（对照谁没打）。
5. **不做** PDF（后端库、不能直接存，重）；不做自动发群（平台限制）。

## ① 名字加号码

- `detail.confirmed` 按序（registration order）就是 1..N。
- 生成轮转（`genRotation`）拿到 `r.rotation` 后，及 `load()` 里若已有 `detail.rotation`，都做一次注入：
  ```js
  const noMap = {}; (this.data.detail.confirmed || []).forEach((x, i) => { noMap[x.openid] = i + 1; });
  schedule = schedule.map(rd => rd.map(c => c.map(p => ({ ...p, no: noMap[p.openid] || '?' }))));
  ```
- wxml 展示改「`{{p.no}}-{{p.nickname}}`」（court 内每人；休息者也带 no）。

## ② 导出 PNG（canvas）

- 复用现有离屏 `<canvas id="poster">`（Phase 1 海报用的；CSS 仍屏外隐藏）。导出时**动态设 buffer 高度**（按行数）。
- `exportRotation()`：
  1. 取 `detail.rotation.schedule`（已注入 no）+ `detail.rotation.resting`。
  2. 估算行数 = 标题 + Σ(每轮: 1 轮头 + courts 场行 + 1 休息行)；canvas buffer 高 = 行数 × lineHeight + padding。
  3. `createSelectorQuery('#poster').fields({node:true})` 取 node；设 `c.width=750*dpr, c.height=H*dpr, ctx.scale(dpr,dpr)`。
  4. 画：白底；标题（活动名 + 「轮转表」）；逐轮「第 N 轮」+「场 C: 1-名/3-名/5-名/7-名」+「休息: 2-名, 4-名…」。
  5. `wx.canvasToTempFilePath({canvas})` → `wx.previewImage({urls:[temp]})`（长按存/转发）。
- 入口：轮转结果区（`detail.rotation` 存在时）加按钮「导出轮转表(图片)」。

## UI 改动

- 轮转结果展示：court 内「N-名字」、休息行「N-名字」。
- 新按钮「导出轮转表(图片)」（`bindtap="exportRotation"`），仅 `detail.rotation` 存在时显示。

## 测试

- 前端无单测；`node --check` + 模拟器/真机手测（canvas 渲染真机为准）。
- 后端无改动（号码是前端注入、导出是前端 canvas）。

## 跨节 / 边界

- 号码是**报名序号**，与名单一致；若名单变动（取消），已存轮转的号码在 load 时按当前 confirmed 重新注入（永远和当前名单一致）。
- canvas 导出复用 `#poster` 节点（与活动海报互斥使用，不同时）。
- 图片为 PNG，预览后长按可存相册/转发；小程序无法自动发指定群。
