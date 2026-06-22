# 逐轮动态排场（会话模式）设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。建立在 Phase 5 轮转调度之上。

## 目标

给轮转加「逐轮动态」子模式：**不预排全表，每轮现场标记在场者 → 系统排当轮场地**。自然处理晚到（到了才勾）和早退（走了就取消勾），公平/不连休跨轮累计。

## 确认决策

1. **逐轮动态排**：每轮组织者勾在场 → "排本轮" → 系统按公平+水平+不连休排场地 → 打完 → "下一轮"。
2. **会话入库** `activity.session`（球员可看进度、刷新不丢）。
3. **在场默认全选**（多数准时，只取消少数晚到/早退）。
4. 与现有「轮转表」（预排全表）**并存**——模式 picker：分N组 / 双打搭档 / 轮转表(预排) / **逐轮(动态)**。

## 数据模型

`activity.session`（新，与 rotation 并列；覆盖式 start）：
```js
session: {
  courts: 3,
  levelMode: 'homogeneous',     // | 'balanced'
  matchFormat: 'any',           // | 'mens' | 'womens' | 'mixed'
  currentRound: 0,              // 当前轮（0-based，已排完的轮数）
  rounds: [],                   // [{courts:[[4人{openid,nickname,level,gender}]], resting:[openid], present:[openid]}]
  games: {},                    // openid → 上场次数（跨轮累计）
  lastRest: {},                 // openid → 上轮是否休息（不连休）
  startedAt: <ts>,
}
```
`publicActivity` 透出 `session`。

## 算法 — assignOneRound（从 generateRotation 抽出）

```js
function assignOneRound(presentPlayers, { courts, levelMode, matchFormat, games, lastRest }) {
  // presentPlayers: [{openid, nickname, level, gender}] — 本轮在场者
  // 1. 不连休硬约束：上轮休息者（在 present 里）本轮必上场
  // 2. 补满 4×courts：按 games 最少优先
  // 3. 分场：水平切片/蛇形 + 赛制 + 固定搭档归拢
  // 返回 { courts:[[4人]], resting:[openid], games:更新后, lastRest:更新后 }
}
```

逻辑与 `generateRotation` 循环体内的**单轮步骤完全一致**（prevResters→forced→fill→assignRotationCourts→update games/lastRest），只是：
- 输入是**本轮在场者**（而非全池），由调用方传入。
- 返回更新后的 `games`/`lastRest`，由调用方（session endpoint）写回 `activity.session`。
- `present < 4×courts` → 400（人不够填场）。

**重构**：把 `generateRotation` 循环体抽成 `assignOneRound`，`generateRotation` 内部循环调用它（消除重复）。

## 端点

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/api/activities/:id/session/start` | 初始化会话 `{courts, levelMode, matchFormat}`；池=confirmed；games/lastRest 清零 | 必须(发起人) |
| POST | `/api/activities/:id/session/assign` | body `{present:[openid]}` → 排当轮 → 存 rounds[current]、推进 currentRound | 必须(发起人) |
| GET | `/api/activities/:id/session` | 读会话（球员看进度） | 可选(公开) |
| DELETE | `/api/activities/:id/session` | 结束/清除 | 必须(发起人) |

**assign 流程**：
1. 从 `activity.session` 读 courts/levelMode/matchFormat/games/lastRest。
2. `{present}` 的 openids → 从 confirmed roster 取 player objects（含 level/gender）。
3. 调 `assignOneRound(presentPlayers, {courts, levelMode, matchFormat, games, lastRest})`。
4. 存 `rounds[currentRound] = {courts, resting, present}`；更新 `games`/`lastRest`；`currentRound++`。
5. 返回本轮结果 + 更新后的 session。

## UI（详情页分组卡加「逐轮」模式）

- 模式 picker 第四项：**逐轮(动态)**。
- 选后 → 设场数/水平/赛制 → 「**开始会话**」（POST start）。
- 每轮界面：
  - 球员列表，每个带「在场 ✓/✗」开关（默认全选）。
  - 「**排本轮**」按钮 → POST assign `{present}` → 显示当轮场地分配 + 休息者。
  - 「**下一轮**」按钮 → 进入下一轮（在场开关保留上轮状态，组织者按需调整）。
- 晚到：到了就在该轮勾上；早退：走了就取消勾。
- 历史轮次折叠展示（第1轮…第N轮的分配）。
- 可「复制会话(文本)」（和轮转表一样，号码+名字）。
- 「结束会话」（DELETE）。

## 测试（logic 单测）

- `assignOneRound`：不连休（上轮休的必上）、公平（最少上场优先）、水平同质/均衡、赛制、固定搭档——与 generateRotation 一致（因为是同一逻辑抽出）。
- 重构后 `generateRotation` 仍通过既有测试（用 assignOneRound 内部）。
- `startSession`：初始化 games/lastRest 清零、currentRound=0、rounds=[]。
- `assignSession`：排当轮、推进 currentRound、games 累计；`present < 4×courts` → 400。
- 晚到场景：前2轮 present 不含 X → X 不上场、games 不增；第3轮 present 含 X → X 可上场。
- 早退场景：第4轮后 present 不含 Y → Y 不上场。
- 非发起人 start/assign/delete → 403。

## 跨节 / 边界

- 池 = confirmed（到场者由组织者每轮勾选，不依赖 attended 字段——逐轮在场是独立的 present 标记）。
- `session` 与 `rotation`（预排）并列、互不影响。
- `assignOneRound` 是纯函数（无 store），TDD 友好。
- 会话刷新不丢（入库）；球员 GET 可看进度。
- 留口子：session 挂在 activity 上，将来加"群"不受影响。
