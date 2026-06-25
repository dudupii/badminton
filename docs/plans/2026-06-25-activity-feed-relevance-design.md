# 活动一览「相关性 feed」设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。

## 目标（动机）

首页一览现在 `GET /api/activities` 返回**全部**活动（`logic.js:442`），没有任何相关性/时间筛选，活动一多就全是和自己无关的噪声。

要让首页默认只显示**「与我相关的」+「今天及以后」**的活动，降噪；同时保留「全部」入口不丢发现能力。

## 三个已拍板的决策

1. **筛选策略 = 默认相关 + 可切全部**（非严格替换）。相关为空时自动回退显示全部，避免新用户/冷启动空白。
2. **「我参加过的组织者」中「参加过」= 报过名就算**（`registration.status !== 'cancelled'`，confirmed 或 waitlist 都算）。**不用 `attended`**——签到靠组织者手动、数据稀疏，靠它会漏。
3. **时间边界 = 今天及以后**（`startTime >= 今天0点`）。进行中/未开始都显示，今天刚打完的也在（方便 AA/签到结算）；昨天及更早默认不显示。比按 `endTime` 判断稳（很多活动 `endTime` 为空）。

## 「与我相关」的定义（三选一即算）

一个活动相关，当且仅当满足下列任一：

- **我创建的**：`activity.createdBy === 我的 openid`
- **我的群里的**：`activity.clubId ∈ 我加入的 clubs`（复用 `listMyClubs` 的 `members.includes(me)`）
- **我报过名组织者的**：`activity.createdBy ∈ {我所有非取消报名对应活动的 createdBy}`

> 注：我已报名的活动天然被第三条覆盖（我报了 → 该组织者进集合 → 其所有活动可见，包括我报的那场）。

## 架构：方案 A（后端新 feed 端点）

| | 做法 |
|---|---|
| **A（选定）** | 新增 `GET /api/activities/feed?mode=relevant\|all`（requireAuth），后端用现成 registrations+clubs 算相关集 + 时间窗 |
| B（否决） | 前端算：逻辑散到前端、多两个请求、全量传输后过滤 |
| C（否决） | 复用 `/api/activities` 加参数：老端点 public + clubs 页在用 + all-time，塞相关性会误伤 |

选 A 的理由：符合「领域逻辑全在 `logic.js`」约定、前端保持薄、只传相关活动省流量、**完全不动现有 `/api/activities`**（clubs 页继续用 `?clubId=`）。

## 后端（`server/src/logic.js` + `src/index.js`）

新增纯领域函数（复用 `enrichActivity`，**不新增表/字段**）：

```js
// now 可注入，与 createActivity/register 一致，便于测试
async function listFeed(store, openid, { mode = 'relevant', now = Date.now() } = {}) {
  const state = store.snapshot();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);

  // ① 我的相关集
  const myClubIds = new Set(Object.values(state.clubs)
    .filter(c => c.members.includes(openid)).map(c => c.id));
  const myRegOrgs = new Set(state.registrations
    .filter(r => r.openid === openid && r.status !== 'cancelled')   // 报过名就算
    .map(r => state.activities[r.activityId]?.createdBy).filter(Boolean));

  const isRelevant = a => a.createdBy === openid
    || myClubIds.has(a.clubId)
    || myRegOrgs.has(a.createdBy);
  const isTodayOrFuture = a => a.startTime >= startOfToday.getTime();

  return Object.values(state.activities)
    .filter(isTodayOrFuture)
    .filter(a => mode === 'all' ? true : isRelevant(a))
    .map(a => enrichActivity(state, a))   // 带 myStatus/名额等，与现有一致
    .sort((a, b) => a.startTime - b.startTime);
}
```

路由（`requireAuth`——相关集是用户私有的）：

```js
app.get('/api/activities/feed', requireAuth,
  wrap(async (req) => logic.listFeed(store, req.user.openid, req.query)));
```

## 前端（`miniprogram/pages/index`）

- 顶部加分段切换：「我相关的」/「全部」，默认「我相关的」。
- `load()` 按 toggle 调 `/api/activities/feed?mode=...`；渲染/排序（即将开始优先）/已结束变灰**沿用现有逻辑**。
- **空态回退**：拉 `relevant` 若为空 → 自动改拉 `all` + 显示一行提示「暂时没有与你相关的活动，以下是全部即将开始的」；`all` 也空才显示「还没有活动」。新用户因此直接看到全部即将开始的活动，冷启动不空白。
- 下拉刷新重新拉当前 mode。

## 测试（`server/tests/logic.test.js`，内存 Store + 注入 `now`）

1. 三条相关判据各覆盖：我建的 / 我的群里的 / 我报过名组织者的——在 `relevant` 都可见。
2. 无关活动（陌生组织者 + 非我的群）在 `relevant` 被滤掉、在 `mode=all` 可见。
3. 时间窗：注入 `now`，今天 0 点边界活动可见、昨天的不出现（两种 mode 都卡时间窗）。
4. 「报过名」边界：confirmed/waitlist 算、cancelled 不算。
5. mode=all 同样卡时间窗、但不过滤相关性。

前端 `node --check` + HTTP 实证（`curl` 带 dev token）。

## 已知简化（先这样，需要再调）

- **时区 = 服务器本地时间**。「今天 0 点」按服务器时区算（自用、服务器与用户都在国内时一致）。要更精确可让前端传 `tzOffset`——YAGNI 先不做。
- **feed 不含历史**：两种 mode 都只到「今天及以后」。过去活动通过「我的报名」/ profile「我创建的」到达（组织者在那里给历史活动签到/结 AA），feed 不承担回看职责。
- **性能**：每次 feed 全表扫 registrations+clubs，自用规模（数十~百级活动）可接受，和现有各 list 函数同一量级。

## 不做（YAGNI）

- 按 `endTime` 精确判断「进行中」（endTime 常空、且「今天及以后」已覆盖进行中场景）。
- feed 里带历史活动 / 分页。
- 前端传时区。
- 改动现有 `/api/activities` 或 clubs 页。
