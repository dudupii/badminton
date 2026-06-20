# 自用打深：球费 AA + 水平分组 + 出勤统计 设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出（`docs/plans/2026-06-20-self-use-depth-plan.md`）。

## 定位与目标

**定位**：先服务好组织者自己那个固定球友群，架构上保留将来开放给更多群的口子（不做"硬刚通用报名工具的支付/表单/导出"那条跟跑路线）。

**目标**：让本群觉得这个 app 比「微信群接龙」明显好用——补齐每周打球组织者最痛的三件事：收钱对账、分组公平、看出勤。

**成功标准**：组织者每周用它能完成「建场→报名→候补上位→收钱对账→签到→分组→看出勤」全流程，不再回到微信群手工记账。

## 架构原则

- 复用现有架构：领域逻辑全在 `server/src/logic.js`（TDD）、`server/src/index.js` 薄路由、`store.txn` 串行写锁；前端原生 JS 无构建。
- **不引入新依赖**、**不接微信支付**（需商户号、门槛高）。球费做"记账 + 导出"。
- 数据仍以**活动（activity）为核心实体**；本设计只加字段、不新增核心实体。将来加"群/俱乐部"概念时给 activity 套 `clubId` 过滤即可，不被本设计阻碍（留口子）。
- 金额一律用**「分」存（整数）**，显示时 /100，避免浮点坑。

## 数据模型变更

`activity` 加一个**可选** `fee` 对象（无费用的活动不建）：

```js
fee: {
  totalCents: number | null,      // 模式 A：总额均摊（与 perPersonCents 二选一）
  perPersonCents: number | null,  // 模式 B：固定人均（如 ¥30/人 = 3000）
  splitBy: 'confirmed' | 'attended', // 谁参与分摊/交费：正式名单 or 实到名单
}
```

- `totalCents` 与 `perPersonCents` **必须二选一**非空（校验：两者都空或都非空 → 400）。
- 计费模式由"哪个字段非空"隐式决定，无需单独 `mode` 字段。

`registration` 加三个字段：

```js
paid: false,        // 是否已交费
paidAt: null,       // 交费时间戳
attended: null      // 签到：null=未签 / true=到 / false=放鸽子
```

无新核心实体。`grouping` 不入库；`stats` 实时聚合。

## 机能 1：球费 AA

### 每人应付（owedCents）—— 纯逻辑函数，单测

池子 = `splitBy === 'confirmed'` 取正式名单、`'attended'` 取 `attended === true` 者。

- 模式 A（总额）：`owedCents = Math.round(totalCents ÷ 池子人数)`。
- 模式 B（固定人均）：`owedCents = perPersonCents`（池里每人这个数）。

### 端点（组织者才能改）

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| PUT | `/api/activities/:id/fee` | 设置/更新费用 `{totalCents?, perPersonCents?, splitBy}` | 必须(发起人) |
| POST | `/api/activities/:id/roster/:openid/paid` | 标记已付/未付 `{paid:bool}` | 必须(发起人) |
| POST | `/api/activities/:id/roster/:openid/attend` | 签到 `{attended:bool}` | 必须(发起人) |
| GET | `/api/activities/:id/fee/export` | 导出 CSV（昵称,应付,已付） | 必须(发起人) |

### 详情接口承载

`enrichActivity` 的每个名单 entry 增加：`owedCents`、`paid`、`attended`；活动级增加 `feeSummary = { totalOwedCents, totalPaidCents, settled: bool }`。

### 前端（detail 页「费用」卡）

- 组织者：选「总额」或「固定人均」→ 填金额 → 选按正式/按实到；列出每人 `应付 ¥X · 已付✓/未付`（点切换）；签到开关；「导出 CSV」按钮。
- 普通球友：只看到**自己的应付 + 是否已付**。

### 明确不做（YAGNI）

- 不接微信支付（先记账+导出，微信群转账 + 本工具对账已比纯群接龙强）。
- 不做每人自定义金额（manual 模式）——v1 只支持总额均摊 / 固定人均两种。

## 机能 2：水平分组 / 双打搭档

### 水平权重

新手=1 / 初级=2 / 中级=3 / 高级=4；`level` 为空按 **2** 算（中庸假设）。

### 算法（纯逻辑函数，单测）

- **分 N 组（场地）**：正式名单按权重降序排（同级按 `createdAt`），**蛇形分发**到 N 组（第 1 轮 1→N、第 2 轮 N→1…），使各组总权重尽量均衡；除不尽时后若干组少一人。
- **双打搭档**：按权重降序排，**首尾配对**（最强+最弱），每对实力尽量均衡。

### 端点

`GET /api/activities/:id/grouping?mode=groups|pairs&count=N`（requireAuth；纯计算，读正式名单 + level）→ 返回 `[[{openid,nickname,level,weight},…],…]`。

### 前端

detail 页（组织者）「分组」按钮 → 选模式 + 组数 → 展示分组/搭档（可截图发群）。

### 明确不做（YAGNI）

- v1 **不入库**（每次重算）、不做手动微调。持久化/手动调整留待将来。

## 机能 3：出勤统计

### 每人汇总（组织者名下所有活动，跨活动聚合）

- `confirmed`：报名（正式）次数
- `attended`：实到（`attended === true`）次数
- `noShow`：放鸽子（confirmed 但 `attended === false`）次数
- `rate`：出勤率 = `attended / confirmed`

依赖机能 1 的「签到」标记 `attended`。

### 端点

`GET /api/stats/attendance`（requireAuth；范围 = 我创建的活动）→ `[{openid,nickname,confirmed,attended,noShow,rate}]`，按出勤次数降序。

### 前端

新增 `pages/stats/`「出勤统计」页，组织者从个人页入口进，看常客/鸽子榜单；普通球友无入口（不是他们建的活动）。

## 跨机能一致性

- `attended` 字段被机能 1（签到 / 按实到均摊）和机能 3（放鸽子统计）共用。
- 三机能只读/扩展现有实体，无新核心实体；`grouping` 不入库、`stats` 实时算。
- 留口子：将来加"群"时，stats 按 `clubId` 过滤、fee/grouping 不变。

## 风险与备注

- **不接支付**意味着 AA 是"辅助对账"，组织者仍需在微信群收钱——但本工具解决"谁交了/没交/欠多少"的对账痛，已显著减负。
- **签到**靠组织者手动标 `attended`（场地口播/点名后一键标）；未签到的 `attended=null` 既不算实到也不算放鸽子。
- **分组算法**是贪心蛇形/首尾配对，不保证全局最优，但对球友群场景够用且可复现。
- **导出 CSV** 用原生字符串拼接（无新依赖）；注意 CSV 注入（金额字段是数字，无 `=` 风险）。
