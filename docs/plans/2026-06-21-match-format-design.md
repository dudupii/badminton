# 轮转赛制选项（男双/女双/混双）设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。建立在 Phase 5 轮转调度之上。

## 目标

给轮转加「赛制」选项：`不限`(缺省) / `男双` / `女双` / `混双`。选了某赛制后，**每轮尽量组出 1 场该赛制的场地**（按当轮上场者的性别够不够），其余场地照常按水平分。公平轮转、不连休**完全不受影响**（赛制只改"怎么分场"，不改"谁上场"）。

## 确认的关键决策

1. **作用范围 = 尽量 1 场**：当轮上场者里该性别够 4 人（混双够 2 男 2 女）→ 组**第 1 场**为该赛制；不够则该轮全部按水平分（退回现行为）。不是"所有场"、也不是"每轮保证"。
2. **公平/不连休不动**：选人步骤（上一轮休息者必上 + 按最少上场补）完全不变；赛制只作用于分场步骤。
3. **水平模式照叠**：第 1 场（赛制场）内部按水平排序取人；其余场地按既有 `homogeneous`/`balanced` 分。
4. 缺省 `不限` = 现行行为，无任何赛制约束。

## 固有限制（已知、已接受）

赛制场出现的频率 ≈ 由「场地数/人数比 + 该性别占比」决定，**不是每轮保证**。例：14 人 5 女 2 场（每轮 8 打）→ 每轮上场者平均 ~3 女 < 4 → 女双场很少组出；但 3 场（每轮 12 打）→ 几乎人人上场 → 5 女可凑 4 → 女双场每轮都有。这是"公平不动"的代价；要每轮保证得改选人逻辑（微调公平），本期不做。

## 数据模型

`generateRotation(players, params)` 的 `params` 与 `activity.rotation` 各加一个字段：
```js
matchFormat: 'any' | 'mens' | 'womens' | 'mixed'   // 缺省 'any'
```
存入 `rotation.matchFormat`（与 courts/rounds/levelMode 并列）。

## 算法（只改 `assignRotationCourts`，选人步骤不动）

每轮拿到 playing（4×courts 人）后：

1. 若 `matchFormat === 'any'` → 现行分场（按 levelMode 切片/蛇形 + 固定搭档归拢）。
2. 否则尝试组**赛制场**（取 4 人作为 court[0]）：
   - `mens`：playing 里男 ≥ 4 → 取 4 男（按 level 排序取前 4）。
   - `womens`：playing 里女 ≥ 4 → 取 4 女。
   - `mixed`：playing 里男 ≥ 2 且 女 ≥ 2 → 取 2 男 + 2 女（各按 level 排序取前 2）。
   - 不满足 → 该轮无赛制场，走第 3 步把所有人按现行为分。
3. 剩余 playing（= playing − 赛制场 4 人，或 playing 全体当无赛制场时）填入其余 `courts−1`（或 `courts`）个场地，按既有 `homogeneous`/`balanced` + `reunitePairs` 分。
4. 赛制场放 `court[0]`，其余依次。

> 固定搭档（`fixedPairs`）仍只对其余场地生效（赛制场按性别抽，搭档若被抽进赛制场则自然同场；不强行）。YAGNI：不为搭档破坏赛制。

## UI（详情页轮转卡）

- 加「赛制」picker：`不限 / 男双 / 女双 / 混双`，存 `rotMatchFormat`。
- 生成时随 `matchFormat` 一起 POST。
- 赛制场在展示时可标「(女双)」之类，便于识别（可选）。

## 测试（logic 单测）

- `matchFormat='womens'` + 每轮都够女的场景（如 8 男 8 女、4 场人人上场）→ court[0] 全女（4 人）。
- `matchFormat='mens'` → court[0] 全男。
- `matchFormat='mixed'` → court[0] = 2 男 2 女。
- `matchFormat='any'` → 无赛制约束（court[0] 可能任意性别混合），与现行一致。
- 当轮不够该性别（构造上场者女 < 4）→ 无赛制场，全部按水平分（不断言赛制场）。
- 公平/不连休 跨赛制不变（复用既有断言）。
- `rotation.matchFormat` 持久化 + 透出。

## 跨节 / 边界

- 池 = 签到到场者（含性别），与 Phase 5 一致。
- 赛制只影响分场，不引入新端点（随 `POST .../rotation` 的 body 传）。
- 与水平模式叠加：赛制场内部 level 排序、其余场按 levelMode。
- 向后兼容：既有 `rotation`（无 matchFormat）按 `'any'` 行为。
