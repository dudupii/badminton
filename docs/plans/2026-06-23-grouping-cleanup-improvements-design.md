# 分组清理 + 轮转改进设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。

## 目标

删除不用的「分N组」「双打搭档」模式；给保留的「轮转表」和「逐轮动态」做 9 项改进。

## A. 清理：删「分N组」「双打搭档」

- 模式 picker 从 4 项 → 2 项：`['轮转表','逐轮(动态)']`
- 删 detail.wxml 里 groups/pairs 的 UI block + genGroups 调用
- `generateGroups` 后端保留（GET /grouping 端点不变；只是 UI 不再暴露）

## B. 轮转表改进（3 项）

### #1 当前轮高亮
- `rotation.currentRound`（0-based，缺省 0）；`POST .../rotation/current` `{round:N}`（仅发起人）
- 组织者：轮转结果上方「◀ 第 N 轮 ▶」翻页（存库）
- 球友：进详情页看到当前轮高亮（其余灰显）
- 复制文本标注「▶ 当前」

### #2 刷新提示
- 生成时存 `rotation.headcount`（当时池人数）
- 前端比较 `detail.confirmed.length !== rotation.headcount` → 黄色提示「名单有变动，建议重新生成」

### #3 单轮复制
- 每轮右侧小「复制」按钮 → 只复制该轮文本

## C. 逐轮动态改进（4 项）

### #4 撤销上一轮
- 每次 assign 时在 round 对象存 `before: {games:{...}, lastRest:{...}}`（深拷贝快照）
- `POST .../session/undo` → 弹出最后一轮、从 before 恢复 games/lastRest、currentRound−1
- 前端：「撤销上一轮」按钮

### #5 公平仪表盘
- 排完后显示一行：按 session.games 降序「阿强3 · 小李2 · …」

### #6 休息提示
- 本轮结果下显示：「休息：1-小张、5-小李 → 下轮必上场」

### #7 中途加减场
- 会话进行中显示场地数输入（可改）；改了 → `POST .../session/courts` `{courts:N}` 更新 session.courts → 下一轮用新场数

## D. 通用改进（2 项）

### #9 大字显示
- 当前轮场地分配用大号字 + 每场独立深色卡片（白字），方便远处看
- 轮转表和逐轮都适用

### #10 球员只读视图
- 分组卡当前 `wx:if="{{isCreator}}"` — 球员看不到
- 改为：创建者看完整控制面板；球友看只读「当前进度」卡（轮转/逐轮最新结果 + 当前轮高亮，不能操作）

## 端点汇总（新）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/activities/:id/rotation/current` | 设当前轮 `{round:N}` |
| POST | `/api/activities/:id/session/undo` | 撤销最后一轮 |
| POST | `/api/activities/:id/session/courts` | 改场地数 `{courts:N}` |

## 数据模型变更

- `rotation.currentRound`（number，0-based，缺省 0）
- `rotation.headcount`（number，生成时池人数）
- `session.rounds[i].before`（`{games:{...}, lastRest:{...}}` 深拷贝快照）

## 测试

- `setCurrentRound`：设置 + 透出；非创建者 403。
- `undoSession`：撤销后 currentRound−1、games/lastRest 恢复、rounds 弹出最后一轮；空会话 undo → 400。
- `setSessionCourts`：更新 session.courts；非创建者 403。
- 既有测试不受影响。

## 风险

- 删 groups/pairs 模式不影响后端（generateGroups 端点保留）。
- undo 的深拷贝快照每轮多存一份 games/lastRest——自用规模（几十人）内存可忽略。
- 球员只读视图是 `isCreator` 分支：创建者卡片不变，球友卡片是精简只读版。
