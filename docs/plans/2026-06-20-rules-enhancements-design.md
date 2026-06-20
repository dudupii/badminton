# 报名规则增强（级别双模式 + 性别限制 + 缺席惩罚警告/迟到取消）设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。建立在 Phase 4 `activity.rules` 之上。

## 目标

在 Phase 4 两条规则基础上做三项增强：
1. **级别限制双模式**：保留现有"指定水平（白名单）"模式，新增"某级以上"模式。
2. **性别限制**（新规则，缺省不限）：仅指定性别可报名。
3. **缺席惩罚警告 + 迟到取消算缺席**：缺席惩罚生效时在报名页显示警告横幅；新增"取消截止时间"，过点再取消也算缺席（触发禁报）。

## 确认的关键决策

1. `minLevel` = **该级及以上**（权重 ≥）。
2. `allowedLevels`（白名单）与 `minLevel`（以上）**互斥**——UI 三选一（关 / 指定水平 / 某级以上），validateRules 拒绝两者同设。
3. `cancelDeadlineHours` = **开赛前 N 小时**（相对偏移），不是绝对时间点。
4. 迟到取消既把 reg 标 `attended = false`（喂禁报扫描），**不影响**候补上位（上位照常）。
5. 性别限制开启时，**"不公开"性别用户被拦**（不在允许集合里）。
6. 缺席判定仍依赖 Phase 3 签到（`attended === false`）；迟到取消是产生 `attended=false` 的另一条路径。

## 架构

- 复用 Phase 4 的 `rules` 对象与 compute-on-demand 校验；`validateRules` 增量校验新字段；`register()` 增量检查；`cancel()` 增量处理迟到取消。
- 无新端点、无新核心实体。新增字段皆可选、缺省关，向后兼容（既有 `allowedLevels`/`noShowBanDays` 活动行为不变）。

## 数据模型

`activity.rules` 扩展为（所有子字段可选）：

```js
rules: {
  noShowBanDays: 7,              // 既有：缺席后禁报天数
  cancelDeadlineHours: 2,        // 新：开赛前 N 小时为取消截止；过点取消算缺席
  allowedLevels: ['新手', '初级'],// 既有：白名单模式
  minLevel: '中级',               // 新：该级及以上；与 allowedLevels 互斥
  allowedGenders: ['男', '女'],    // 新：⊆{男,女}；缺省/空=不限
}
```

校验（`validateRules` 增量）：
- `cancelDeadlineHours`：若提供需为正整数（否则 400）。
- `minLevel`：若提供需 ∈ `LEVELS`（否则 400）；**与 `allowedLevels` 不可同设**（否则 400）。
- `allowedGenders`：若提供需是 `{男,女}` 的非空子集（否则 400）；空数组=不限（不写入）。
- `publicActivity` 已透出 `rules`（Phase 4），无需再改。

## 报名校验（`register()` txn 内，既有级别/缺席块基础上增量）

- **级别**：若 `rules.minLevel` 在 → 用户水平权重须 ≥ `minLevel` 权重（空水平 → 400「请先填水平」；不达标 → 400「本活动限 {minLevel} 及以上水平」）。否则若 `rules.allowedLevels` 在 → 白名单（既有）。
- **性别**：若 `rules.allowedGenders` 非空 → 用户 gender 须在集合；`不公开`/不在集合 → 400「本活动限 {genders} 报名」。
- **缺席禁报**：既有（同组织者 + 窗口内 + `attended===false`）。迟到取消产生的 `attended=false` 也会被此扫描命中。

## 取消逻辑（`cancel()` —— 新机制）

在既有取消流程里（把 `mine.status` 置 `cancelled`、触发候补上位之外），追加：

- 若活动 `rules.cancelDeadlineHours` 存在、且被取消者原 `wasConfirmed`、且 `now > a.startTime − rules.cancelDeadlineHours·3600000`（即已过取消截止）→ 给该 reg 设 `mine.attended = false`（迟到取消 = no-show）。
- 截止前取消：不设 `attended`，无惩罚（既有行为）。
- 未配置 `cancelDeadlineHours`：取消永不产生 `attended=false`（既有行为）。
- 该标记只影响禁报扫描（`r.attended === false`），不进名单/统计（cancelled 已被过滤）。

## 详情页警告（第 3 条 —— 前端展示）

detail 页（`detail.wxml`）在报名区上方加横幅，**当活动 `rules.noShowBanDays` 生效时**显示：
- 有 `cancelDeadlineHours`：「⚠️ 缺席惩罚：开赛前 {N} 小时后取消或未到场，将 {banDays} 天内禁报该组织者活动」。
- 无：「⚠️ 缺席惩罚：报名后未到场（组织者签到标缺），将 {banDays} 天内禁报」。

`detail.js load()` 已有 `fee`/`feeSummary`；新增 `rules`（从 `d.rules`）供模板渲染。

## UI（create / edit）

- **级别限制**改三态（单选 picker：关 / 指定水平 / 某级以上）：
  - 指定水平 → 多选 tag（既有）。
  - 某级以上 → 单个水平 picker（新）。
- **缺席惩罚**：开关 + 禁报天数（既有）+ 新「取消截止：开赛前 N 小时」输入（仅开关开时显示）。
- **性别限制**：开关 + 男/女 多选 tag（新）；缺省关。
- `loadForEdit` 回填新字段；`buildRules` 产出新字段。

## 测试（logic.js 单测）

- `minLevel`：达标放行 / 不达标拦 / 空水平拦。
- `allowedLevels` 与 `minLevel` 同设 → 400（validateRules）。
- 性别：在集合放行 / 不在拦 / 不公开拦 / 未启用不限。
- `cancelDeadlineHours`：
  - 截止前取消 → reg `attended` 仍为 null（无惩罚）。
  - 截止后取消 → reg `attended === false`，且候补照常上位；该用户随后报名同组织者（带 noShowBanDays）的活动、在原活动 startTime 之后 → 被禁报。
  - 无 `cancelDeadlineHours` → 取消永不设 `attended`。
- 回归：既有 Phase 4 规则用例不受影响（新字段缺省）。

## 依赖与边界

- 迟到取消产生的禁报，同样要等原活动 `startTime` 过后（禁报扫描要求 `pa.startTime <= now`）才在新报名时命中——与既有"缺席后 N 天"窗口一致。
- `cancelDeadlineHours` 只在配了 `noShowBanDays` 时才有意义（否则迟到取消标了 attended 也无禁报可触发）；UI 可把"取消截止"放在"缺席惩罚"开关内。
- 性别/级别限制对**空资料**用户的处理：级别空 → 拦（提示先填）；性别"不公开" → 拦。
- 兼容性：既有活动的 `rules`（只有 `noShowBanDays`/`allowedLevels`）行为完全不变。
