# 自用打深（球费 AA + 水平分组 + 出勤统计）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给羽毛球报名小程序加三件自用向机能：球费 AA（总额均摊 / 固定人均，记账+导出，不接支付）、水平分组/双打搭档（蛇形/首尾配对，按需算）、出勤统计（跨活动聚合）。

**Architecture:** 后端继续走「`logic.js` 纯领域逻辑 + `index.js` 薄路由 + `store.txn` 串行写锁」；新逻辑全加在 `logic.js` 并用 `node:test` TDD，路由用 `wrap()` 包装。金额一律用「分」（整数）存。`grouping` 不入库（按需算）、`stats` 实时聚合。只给 `activity`/`registration` 加字段，不新增核心实体。

**Tech Stack:** Node 18+ / Express / node:test（后端）；微信小程序原生 JS / WXML / WXSS（前端）。

**Branch:** 在当前 `feat/phase1-organizer-features` 上继续（依赖 Phase 2 的 level/gender 字段）。

**参考：** 设计文档 `docs/plans/2026-06-20-self-use-depth-design.md`；架构与约定见 `CLAUDE.md`。

**实现顺序：** Task 1–7 后端（TDD），8–10 前端，11 文档。每个 Task 结束都提交。

---

## Task 1: 后端 — setFee（设置费用）+ PUT /fee

**Files:**
- Modify: `server/src/logic.js`（新增 `setFee`，加入 `module.exports`）
- Modify: `server/src/index.js`（新增路由 `PUT /api/activities/:id/fee`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

追加到 `server/tests/logic.test.js`（插在 `test('token sign/verify...` 之前）：

```js
test('setFee sets activity.fee; rejects bad combos and non-creator', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  // total mode
  const a = await logic.setFee(store, act.id, 'org', { totalCents: 12000, splitBy: 'confirmed' });
  assert.equal(a.fee.totalCents, 12000);
  assert.equal(a.fee.splitBy, 'confirmed');
  // fixed mode
  const b = await logic.setFee(store, act.id, 'org', { perPersonCents: 3000, splitBy: 'confirmed' });
  assert.equal(b.fee.perPersonCents, 3000);
  assert.equal(b.fee.totalCents, null);
  // must choose exactly one of total/perPerson
  await withError(400, logic.setFee(store, act.id, 'org', { splitBy: 'confirmed' })); // neither
  await withError(400, logic.setFee(store, act.id, 'org', { totalCents: 1000, perPersonCents: 1000, splitBy: 'confirmed' })); // both
  await withError(400, logic.setFee(store, act.id, 'org', { totalCents: 1000, splitBy: 'wednesday' })); // bad splitBy
  // non-creator rejected
  await withError(403, logic.setFee(store, act.id, 'stranger', { perPersonCents: 1000, splitBy: 'confirmed' }));
  // clear fee with empty input
  const c = await logic.setFee(store, act.id, 'org', {});
  assert.equal(c.fee, null);
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep setFee
```
Expected: FAIL — `logic.setFee is not a function`。

### Step 3: 实现

在 `server/src/logic.js`（放在 `updateActivity` 后面）加：

```js
// Set / clear an activity's fee. Exactly one of totalCents (split among the
// pool) or perPersonCents (fixed per head) must be given; empty input clears.
async function setFee(store, id, actorOpenid, input) {
  const totalCents = input.totalCents == null ? null : Number(input.totalCents);
  const perPersonCents = input.perPersonCents == null ? null : Number(input.perPersonCents);
  const splitBy = input.splitBy;
  const hasTotal = totalCents != null;
  const hasPer = perPersonCents != null;

  if (hasTotal && hasPer) throw httpError(400, '总额与固定人均只能二选一');
  if ((hasTotal || hasPer) && splitBy !== 'confirmed' && splitBy !== 'attended') {
    throw httpError(400, 'splitBy 取值非法');
  }
  if (hasTotal && (!Number.isInteger(totalCents) || totalCents < 0)) throw httpError(400, '总额需为非负整数（分）');
  if (hasPer && (!Number.isInteger(perPersonCents) || perPersonCents < 0)) throw httpError(400, '人均需为非负整数（分）');

  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以设置费用');
    if (!hasTotal && !hasPer) {
      a.fee = null;
    } else {
      a.fee = {
        totalCents: hasTotal ? totalCents : null,
        perPersonCents: hasPer ? perPersonCents : null,
        splitBy,
      };
    }
    return publicActivity(a);
  });
}
```

在 `module.exports` 里 `updateActivity,` 后面加 `setFee,`。

在 `server/src/index.js`，在 `PUT /api/activities/:id` 路由后面加：

```js
// Set / clear the activity fee (creator only).
app.put(
  '/api/activities/:id/fee',
  requireAuth,
  wrap(async (req) => logic.setFee(store, req.params.id, req.user.openid, req.body || {}))
);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS（比上一任务多 1 个用例）。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: setFee + PUT /api/activities/:id/fee"
```

---

## Task 2: 后端 — markPaid（标记已付）+ 路由

**Files:**
- Modify: `server/src/logic.js`（新增 `markPaid`，导出）
- Modify: `server/src/index.js`（新增 `POST /api/activities/:id/roster/:openid/paid`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

```js
test('markPaid toggles a confirmed registrant; organizer only', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  const r = await logic.markPaid(store, act.id, 'org', 'u1', true);
  assert.equal(r.paid, true);
  assert.ok(r.paidAt);
  // toggling off clears paidAt
  const r2 = await logic.markPaid(store, act.id, 'org', 'u1', false);
  assert.equal(r2.paid, false);
  assert.equal(r2.paidAt, null);
  // non-organizer rejected
  await withError(403, logic.markPaid(store, act.id, 'u1', 'u1', true));
  // unknown target
  await withError(404, logic.markPaid(store, act.id, 'org', 'ghost', true));
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep markPaid
```
Expected: FAIL — `logic.markPaid is not a function`。

### Step 3: 实现

在 `server/src/logic.js`（`setFee` 后面）加：

```js
// Mark a registrant paid/unpaid. Organizer only. Returns the updated slice.
async function markPaid(store, activityId, actorOpenid, targetOpenid, paid) {
  return store.txn((state) => {
    const a = state.activities[activityId];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    const r = state.registrations.find(
      (x) => x.activityId === activityId && x.openid === targetOpenid && x.status !== 'cancelled'
    );
    if (!r) throw httpError(404, '该用户未报名');
    r.paid = !!paid;
    r.paidAt = r.paid ? Date.now() : null;
    return { openid: r.openid, paid: r.paid, paidAt: r.paidAt };
  });
}
```

导出加 `markPaid,`。

在 `server/src/index.js`（`PUT .../fee` 后面）加：

```js
app.post(
  '/api/activities/:id/roster/:openid/paid',
  requireAuth,
  wrap(async (req) =>
    logic.markPaid(store, req.params.id, req.user.openid, req.params.openid, !!(req.body && req.body.paid))
  )
);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: markPaid + POST /roster/:openid/paid"
```

---

## Task 3: 后端 — markAttend（签到）+ 路由

**Files:**
- Modify: `server/src/logic.js`（新增 `markAttend`，导出）
- Modify: `server/src/index.js`（新增 `POST /api/activities/:id/roster/:openid/attend`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

```js
test('markAttend sets attended (true/false/null); organizer only', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  assert.equal((await logic.markAttend(store, act.id, 'org', 'u1', true)).attended, true);
  assert.equal((await logic.markAttend(store, act.id, 'org', 'u1', false)).attended, false); // 放鸽子
  assert.equal((await logic.markAttend(store, act.id, 'org', 'u1', null)).attended, null); // 清除
  await withError(403, logic.markAttend(store, act.id, 'u1', 'u1', true));
  await withError(404, logic.markAttend(store, act.id, 'org', 'ghost', true));
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep markAttend
```
Expected: FAIL — `logic.markAttend is not a function`。

### Step 3: 实现

在 `server/src/logic.js`（`markPaid` 后面）加：

```js
// Mark a registrant's attendance: true=到, false=放鸽子, null=未签/清除。
async function markAttend(store, activityId, actorOpenid, targetOpenid, attended) {
  return store.txn((state) => {
    const a = state.activities[activityId];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    const r = state.registrations.find(
      (x) => x.activityId === activityId && x.openid === targetOpenid && x.status !== 'cancelled'
    );
    if (!r) throw httpError(404, '该用户未报名');
    r.attended = attended === undefined ? null : attended;
    return { openid: r.openid, attended: r.attended };
  });
}
```

导出加 `markAttend,`。

在 `server/src/index.js` 加路由：

```js
app.post(
  '/api/activities/:id/roster/:openid/attend',
  requireAuth,
  wrap(async (req) => {
    const v = req.body && 'attended' in req.body ? req.body.attended : undefined;
    return logic.markAttend(store, req.params.id, req.user.openid, req.params.openid, v === null ? null : v);
  })
);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: markAttend + POST /roster/:openid/attend"
```

---

## Task 4: 后端 — enrichActivity 带费用（owedCents / paid / attended / feeSummary）

**Files:**
- Modify: `server/src/logic.js`（`enrichActivity` 加字段 + 新增纯函数 `perPersonOwedCents`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

```js
test('enrichActivity computes per-person owedCents + feeSummary', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  await logic.register(store, act.id, 'u2', 2000);
  await logic.register(store, act.id, 'u3', 3000); // 3 confirmed
  await logic.setFee(store, act.id, 'org', { totalCents: 9000, splitBy: 'confirmed' }); // 9000/3 = 3000 each
  let d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed[0].owedCents, 3000);
  assert.equal(d.feeSummary.totalOwedCents, 9000);
  assert.equal(d.feeSummary.totalPaidCents, 0);
  assert.equal(d.feeSummary.settled, false);

  await logic.markPaid(store, act.id, 'org', 'u1', true);
  d = await logic.getActivity(store, act.id);
  assert.equal(d.feeSummary.totalPaidCents, 3000);
  assert.equal(d.confirmed.find((x) => x.openid === 'u1').paid, true);

  // attended split: only attendees split the total
  await logic.markAttend(store, act.id, 'org', 'u1', true);
  await logic.markAttend(store, act.id, 'org', 'u2', true); // 2 attended
  await logic.setFee(store, act.id, 'org', { totalCents: 6000, splitBy: 'attended' }); // 6000/2 = 3000 each attendee
  d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed.find((x) => x.openid === 'u1').owedCents, 3000);
  assert.equal(d.confirmed.find((x) => x.openid === 'u3').owedCents, 0); // didn't attend → owes 0

  // fixed per-person mode
  await logic.setFee(store, act.id, 'org', { perPersonCents: 2500, splitBy: 'confirmed' });
  d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed[0].owedCents, 2500);
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep "per-person owedCents"
```
Expected: FAIL — `owedCents` undefined（enrichActivity 还没算）。

### Step 3: 实现

在 `server/src/logic.js` 顶部（`LEVELS`/`GENDERS` 附近）加纯函数：

```js
// Per-person amount owed given a fee config and the splitting-pool size.
function perPersonOwedCents(fee, poolSize) {
  if (!fee || !poolSize) return 0;
  if (fee.totalCents != null) return Math.round(fee.totalCents / poolSize);
  if (fee.perPersonCents != null) return fee.perPersonCents;
  return 0;
}
```

把 `enrichActivity` 改为（在现有 entry 构造里加 `paid`/`attended`，结尾加费用计算）。**完整替换 `enrichActivity` 函数**：

```js
function enrichActivity(state, a, viewerOpenid) {
  const regs = state.registrations
    .filter((r) => r.activityId === a.id && r.status !== 'cancelled')
    .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));

  const confirmed = [];
  const waitlist = [];
  for (const r of regs) {
    const u = state.users[r.openid] || { openid: r.openid, nickname: '未知球友', avatarUrl: '', level: '', gender: '' };
    const entry = {
      openid: r.openid,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      level: u.level || '',
      gender: u.gender || '',
      paid: !!r.paid,
      attended: r.attended === undefined ? null : r.attended,
      createdAt: r.createdAt,
    };
    (confirmed.length < a.capacity ? confirmed : waitlist).push(entry);
  }

  // fee: who owes what
  const fee = a.fee || null;
  const pool = fee
    ? fee.splitBy === 'attended' ? confirmed.filter((e) => e.attended === true) : confirmed
    : [];
  const owed = perPersonOwedCents(fee, pool.length);
  const inPool = new Set(pool.map((e) => e.openid));
  for (const e of confirmed) e.owedCents = inPool.has(e.openid) ? owed : 0;

  let feeSummary = null;
  if (fee) {
    let totalOwed = 0;
    let totalPaid = 0;
    for (const e of confirmed) {
      totalOwed += e.owedCents;
      if (e.paid) totalPaid += e.owedCents;
    }
    feeSummary = { totalOwedCents: totalOwed, totalPaidCents: totalPaid, settled: totalPaid >= totalOwed && totalOwed > 0 };
  }

  const mine = viewerOpenid ? regs.find((r) => r.openid === viewerOpenid) : null;

  return {
    ...publicActivity(a),
    fee,
    feeSummary,
    confirmedCount: confirmed.length,
    waitlistCount: waitlist.length,
    confirmed,
    waitlist,
    myStatus: mine ? mine.status : null,
  };
}
```

> 注意：`publicActivity` 不含 `fee`（它只暴露基础字段），`enrichActivity` 在返回里单独加 `fee` + `feeSummary`。

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS（全过；既有用例不应受影响——entry 多了字段不破坏旧断言）。

### Step 5: 提交

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: enrichActivity carries fee (owedCents/paid/attended/feeSummary)"
```

---

## Task 5: 后端 — CSV 导出 GET /fee/export

**Files:**
- Modify: `server/src/index.js`（新增路由，复用 `logic.getActivity`）

### Step 1: 实现（无单测——HTTP 层展示，靠 curl 自检）

在 `server/src/index.js`（`POST .../attend` 后面）加：

```js
// Export this activity's fee ledger as CSV (creator only).
app.get(
  '/api/activities/:id/fee/export',
  requireAuth,
  wrap(async (req, res) => {
    const d = await logic.getActivity(store, req.params.id, req.user.openid);
    if (d.createdBy !== req.user.openid) throw logic.httpError(403, '只有发起人可以导出');
    const rows = [['昵称', '应付(元)', '已付', '签到'].join(',')];
    for (const e of d.confirmed) {
      const name = '"' + String(e.nickname || '').replace(/"/g, '""') + '"';
      const owed = (e.owedCents / 100).toFixed(2);
      const paid = e.paid ? '是' : '否';
      const att = e.attended === true ? '到' : e.attended === false ? '缺' : '未签';
      rows.push([name, owed, paid, att].join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="fee-' + req.params.id + '.csv"');
    res.send('﻿' + rows.join('\n')); // BOM so Excel reads UTF-8
  })
);
```

> 注意：该路由**不是** `wrap`+`res.json` 的常规模式——它直接 `res.send(csv)`，所以放进 `wrap` 里、用 `res` 参数手动写响应。`wrap` 不强求返回 data（返回 undefined 时不写 JSON）。但这里我们已手动 `res.send`，需在 `wrap` 里别再 `res.json`。最稳妥：**不套 wrap**，直接写独立 handler：

替换上面的 `wrap(async (req, res) => {...})` 为独立 handler：

```js
app.get('/api/activities/:id/fee/export', requireAuth, async (req, res) => {
  try {
    const d = await logic.getActivity(store, req.params.id, req.user.openid);
    if (d.createdBy !== req.user.openid) {
      return res.status(403).json({ ok: false, error: '只有发起人可以导出' });
    }
    const rows = [['昵称', '应付(元)', '已付', '签到'].join(',')];
    for (const e of d.confirmed) {
      const name = '"' + String(e.nickname || '').replace(/"/g, '""') + '"';
      const owed = (e.owedCents / 100).toFixed(2);
      const paid = e.paid ? '是' : '否';
      const att = e.attended === true ? '到' : e.attended === false ? '缺' : '未签';
      rows.push([name, owed, paid, att].join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="fee-' + req.params.id + '.csv"');
    res.send('﻿' + rows.join('\n'));
  } catch (e) {
    const status = e.statusCode || 500;
    res.status(status).json({ ok: false, error: e.message || '服务器错误' });
  }
});
```

### Step 2: 语法自检 + curl 自检

```bash
cd server && node --check src/index.js
# 起服务后（或用现有 :3001）：
curl -s -X POST http://127.0.0.1:3001/api/auth/login -H 'Content-Type: application/json' -d '{"devUserId":"org"}'
# 用拿到的 token：
curl -s "http://127.0.0.1:3001/api/activities/<某个org活动id>/fee/export" -H "Authorization: Bearer <token>"
```
Expected: 输出 CSV（首行 `昵称,应付(元),已付,签到`，含 BOM）。

### Step 3: 跑全测确认无回归 + 提交

```bash
npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
git add server/src/index.js
git commit -m "feat: GET /api/activities/:id/fee/export (CSV ledger)"
```

---

## Task 6: 后端 — generateGroups（水平分组 / 双打搭档）+ 路由

**Files:**
- Modify: `server/src/logic.js`（新增纯函数 `generateGroups` + `levelWeight`，导出）
- Modify: `server/src/index.js`（新增 `GET /api/activities/:id/grouping`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

```js
test('generateGroups: snake-draft balances level across N groups', () => {
  // 6 players, levels 高/高/中/中/初/初 → 2 groups
  const confirmed = [
    { openid: 'a', nickname: 'A', level: '高级' },
    { openid: 'b', nickname: 'B', level: '高级' },
    { openid: 'c', nickname: 'C', level: '中级' },
    { openid: 'd', nickname: 'D', level: '中级' },
    { openid: 'e', nickname: 'E', level: '初级' },
    { openid: 'f', nickname: 'F', level: '初级' },
  ];
  const groups = logic.generateGroups(confirmed, { mode: 'groups', count: 2 });
  assert.equal(groups.length, 2);
  // snake order: A→g0, B→g1, C→g1, D→g0, E→g0, F→g1
  assert.deepEqual(groups[0].map((x) => x.openid), ['a', 'd', 'e']);
  assert.deepEqual(groups[1].map((x) => x.openid), ['b', 'c', 'f']);
  // weights balanced: g0 = 4+3+2=9, g1 = 4+3+2=9
  assert.equal(groups[0].reduce((s, x) => s + x.weight, 0), 9);
  assert.equal(groups[1].reduce((s, x) => s + x.weight, 0), 9);
});

test('generateGroups: pairs mode pairs strong with weak', () => {
  const confirmed = [
    { openid: 'a', level: '高级' }, // 4
    { openid: 'b', level: '中级' }, // 3
    { openid: 'c', level: '中级' }, // 3
    { openid: 'd', level: '初级' }, // 2
  ];
  const pairs = logic.generateGroups(confirmed, { mode: 'pairs' });
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0].map((x) => x.openid), ['a', 'd']); // strongest + weakest
  assert.deepEqual(pairs[1].map((x) => x.openid), ['b', 'c']);
});

test('generateGroups: empty level defaults to weight 2', () => {
  const confirmed = [{ openid: 'a', level: '' }, { openid: 'b', level: '高级' }];
  const pairs = logic.generateGroups(confirmed, { mode: 'pairs' });
  assert.equal(pairs[0][0].weight, 4); // 高级
  assert.equal(pairs[0][1].weight, 2); // empty → 2
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep generateGroups
```
Expected: FAIL — `logic.generateGroups is not a function`。

### Step 3: 实现

在 `server/src/logic.js`（`perPersonOwedCents` 附近）加：

```js
const LEVEL_WEIGHT = { 新手: 1, 初级: 2, 中级: 3, 高级: 4 };
function levelWeight(level) {
  return LEVEL_WEIGHT[level] || 2; // 未知水平按中级(2) 算
}

// Pure: split a confirmed roster into balanced groups (snake draft by level)
// or doubles pairs (strong + weak). Each returned item gains a `weight`.
function generateGroups(confirmed, { mode, count }) {
  const withWeight = (e) => ({ ...e, weight: levelWeight(e.level) });
  const sorted = [...confirmed].sort((a, b) => levelWeight(b.level) - levelWeight(a.level));
  if (mode === 'pairs') {
    const pairs = [];
    const n = Math.floor(sorted.length / 2);
    for (let i = 0; i < n; i++) {
      pairs.push([withWeight(sorted[i]), withWeight(sorted[sorted.length - 1 - i])]);
    }
    if (sorted.length % 2 === 1) pairs.push([withWeight(sorted[n])]); // 落单
    return pairs;
  }
  // groups: snake draft
  const c = Math.max(1, Number(count) || 1);
  const groups = Array.from({ length: c }, () => []);
  sorted.forEach((p, i) => {
    const round = Math.floor(i / c);
    const idxInRound = i % c;
    const idx = round % 2 === 0 ? idxInRound : c - 1 - idxInRound;
    groups[idx].push(withWeight(p));
  });
  return groups.filter((g) => g.length);
}
```

导出加 `generateGroups,`。

在 `server/src/index.js`（`GET .../fee/export` 后面）加：

```js
// Generate balanced groups / doubles pairs for the confirmed roster.
app.get(
  '/api/activities/:id/grouping',
  requireAuth,
  wrap(async (req) => {
    const d = await logic.getActivity(store, req.params.id, req.user.openid);
    const mode = req.query.mode === 'pairs' ? 'pairs' : 'groups';
    const count = Number(req.query.count) || 2;
    return { mode, groups: logic.generateGroups(d.confirmed, { mode, count }) };
  })
);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: generateGroups (snake/pairs) + GET /api/activities/:id/grouping"
```

---

## Task 7: 后端 — attendanceStats（出勤统计）+ 路由

**Files:**
- Modify: `server/src/logic.js`（新增 `attendanceStats`，导出）
- Modify: `server/src/index.js`（新增 `GET /api/stats/attendance`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

```js
test('attendanceStats aggregates confirmed/attended/noShow across organizer activities', async () => {
  const store = tmpStore();
  const a1 = await logic.createActivity(store, { title: 'A1', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org', 1000);
  const a2 = await logic.createActivity(store, { title: 'A2', startTime: '2099-02-01T10:00:00', capacity: 4 }, 'org', 2000);
  // u1: two confirmed, both attended
  await logic.register(store, a1.id, 'u1', 1100);
  await logic.register(store, a2.id, 'u1', 2100);
  await logic.markAttend(store, a1.id, 'org', 'u1', true);
  await logic.markAttend(store, a2.id, 'org', 'u1', true);
  // u2: one confirmed, no-show
  await logic.register(store, a1.id, 'u2', 1200);
  await logic.markAttend(store, a1.id, 'org', 'u2', false);
  // someone else's activity — must be excluded
  const other = await logic.createActivity(store, { title: 'X', startTime: '2099-03-01T10:00:00', capacity: 4 }, 'other', 3000);
  await logic.register(store, other.id, 'u1', 3100);

  const stats = logic.attendanceStats(store, 'org');
  const u1 = stats.find((s) => s.openid === 'u1');
  assert.equal(u1.confirmed, 2);
  assert.equal(u1.attended, 2);
  assert.equal(u1.noShow, 0);
  assert.equal(u1.rate, 1);
  const u2 = stats.find((s) => s.openid === 'u2');
  assert.equal(u2.confirmed, 1);
  assert.equal(u2.noShow, 1);
  assert.equal(u2.rate, 0);
  // sorted by attended desc → u1 first
  assert.equal(stats[0].openid, 'u1');
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep attendanceStats
```
Expected: FAIL — `logic.attendanceStats is not a function`。

### Step 3: 实现

在 `server/src/logic.js`（`myCreatedActivities` 附近）加：

```js
// Per-user attendance across the organizer's activities: confirmed / attended /
// noShow (confirmed but marked absent) / rate. Waitlisted and cancelled excluded.
function attendanceStats(store, organizerOpenid) {
  const state = store.snapshot();
  const mine = new Set(
    Object.values(state.activities)
      .filter((a) => a.createdBy === organizerOpenid)
      .map((a) => a.id)
  );
  const byUser = {};
  for (const r of state.registrations) {
    if (!mine.has(r.activityId) || r.status !== 'confirmed') continue;
    const u = byUser[r.openid] || (byUser[r.openid] = { openid: r.openid, confirmed: 0, attended: 0, noShow: 0 });
    u.confirmed++;
    if (r.attended === true) u.attended++;
    else if (r.attended === false) u.noShow++;
  }
  return Object.values(byUser)
    .map((u) => ({
      ...u,
      nickname: (state.users[u.openid] || {}).nickname || '球友',
      rate: u.confirmed ? u.attended / u.confirmed : 0,
    }))
    .sort((a, b) => b.attended - a.attended || b.confirmed - a.confirmed);
}
```

导出加 `attendanceStats,`。

在 `server/src/index.js`（`GET /api/registrations/me` 附近）加：

```js
app.get(
  '/api/stats/attendance',
  requireAuth,
  wrap(async (req) => logic.attendanceStats(store, req.user.openid))
);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS（后端全部完成）。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: attendanceStats + GET /api/stats/attendance"
```

---

## Task 8: 前端 — detail 页「费用」卡

**Files:**
- Modify: `miniprogram/pages/detail/detail.js`、`detail.wxml`、`detail.wxss`
- (无单测；`node --check` + 模拟器手测)

### Step 1: detail.js 加费用交互

在 `data` 加 `fee`（费用对象副本）、`feeSummary`、编辑态 `feeEdit: { mode:'total'|'fixed', amount:'', splitBy:'confirmed' }`。

在 `load()` 的 `this.setData({...})` 里带上 `fee: d.fee, feeSummary: d.feeSummary`。

新增方法（放 `goEdit` 附近）：

```js
  onFeeModeChange(e) {
    this.setData({ 'feeEdit.mode': e.detail.value === 'fixed' ? 'fixed' : 'total' });
  },
  onFeeSplitChange(e) {
    this.setData({ 'feeEdit.splitBy': e.detail.value === 'attended' ? 'attended' : 'confirmed' });
  },
  onFeeAmount(e) {
    this.setData({ 'feeEdit.amount': e.detail.value });
  },
  async saveFee() {
    const d = this.data;
    const yuan = parseFloat(d.feeEdit.amount);
    const cents = isNaN(yuan) ? 0 : Math.round(yuan * 100);
    const body = { splitBy: d.feeEdit.splitBy };
    if (d.feeEdit.mode === 'total') body.totalCents = cents;
    else body.perPersonCents = cents;
    if (!cents) body.totalCents = null, body.perPersonCents = null; // 清空
    try {
      await request('PUT', '/api/activities/' + d.id + '/fee', body);
      this.load();
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async togglePaid(e) {
    const { openid, paid } = e.currentTarget.dataset;
    try {
      await request('POST', '/api/activities/' + this.data.id + '/roster/' + openid + '/paid', { paid: !paid });
      this.load();
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async toggleAttend(e) {
    const { openid, attended } = e.currentTarget.dataset;
    const next = attended === true ? null : true; // 点一下：未到→到；到→清除
    try {
      await request('POST', '/api/activities/' + this.data.id + '/roster/' + openid + '/attend', { attended: next });
      this.load();
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  exportFee() {
    // 后端返回 CSV 文本；用 wx.saveFile 暂不支持，先打开下载链接（开发者工具会下载）
    wx.setClipboardData({
      data: this.data.qrcodeUrl.replace('/qrcode', '/fee/export'),
      success: () => wx.showToast({ title: '导出链接已复制（浏览器打开，带登录态需开发者工具）', icon: 'none' }),
    });
    // 注：小程序无法直接带 Authorization 头下载 CSV；正式版可在开发者工具/PC 端用。本 v1 先复制链接。
  },
```

> 注：CSV 导出在小程序内带 token 下载较麻烦，v1 先复制链接（开发者工具里可手动带 token 验证）。后续可改为前端用 `wx.request` 拿文本再 `wx.getFileSystemManager().writeFile` 落地——但留作后续，YAGNI。

### Step 2: detail.wxml 加费用卡（仅组织者可见）

在「正式名单」卡后面、二维码卡前面加：

```xml
<view class="card" wx:if="{{isCreator}}">
  <view class="section-title">费用 AA</view>
  <view class="row" style="margin-top:12rpx;align-items:center;">
    <text class="muted" style="width:140rpx;">计费</text>
    <picker bindchange="onFeeModeChange" value="{{feeEdit.mode==='fixed'?1:0}}" range="['总额均摊','固定人均']">
      <view class="input" style="flex:1;">{{feeEdit.mode==='fixed'?'固定人均':'总额均摊'}}</view>
    </picker>
  </view>
  <view class="row" style="margin-top:12rpx;align-items:center;">
    <text class="muted" style="width:140rpx;">{{feeEdit.mode==='fixed'?'人均(元)':'总额(元)'}}</text>
    <input class="input" style="flex:1;" type="digit" value="{{feeEdit.amount}}" bindinput="onFeeAmount" placeholder="留空清除" />
  </view>
  <view class="row" style="margin-top:12rpx;align-items:center;">
    <text class="muted" style="width:140rpx;">分摊</text>
    <picker bindchange="onFeeSplitChange" value="{{feeEdit.splitBy==='attended'?1:0}}" range="['按正式名单','按实到名单']">
      <view class="input" style="flex:1;">{{feeEdit.splitBy==='attended'?'按实到名单':'按正式名单'}}</view>
    </picker>
  </view>
  <button class="btn btn-primary" style="margin-top:16rpx;" bindtap="saveFee">保存费用</button>

  <view wx:if="{{feeSummary}}" class="muted" style="margin-top:16rpx;">
    应收 ¥{{feeSummary.totalOwedCents/100}} · 已收 ¥{{feeSummary.totalPaidCents/100}} · {{feeSummary.settled?'已结清':'未结清'}}
  </view>
  <block wx:if="{{detail.confirmed.length}}">
    <view class="roster-item" wx:for="{{detail.confirmed}}" wx:key="openid">
      <text class="roster-name">{{item.nickname}}</text>
      <text class="muted">应付 ¥{{item.owedCents/100}}</text>
      <text class="tag {{item.paid?'tag-open':'tag-wait'}}" data-openid="{{item.openid}}" data-paid="{{item.paid}}" bindtap="togglePaid" style="margin-left:12rpx;">{{item.paid?'已付':'未付'}}</text>
      <text class="tag {{item.attended===true?'tag-open':item.attended===false?'tag-closed':'tag-wait'}}" data-openid="{{item.openid}}" data-attended="{{item.attended}}" bindtap="toggleAttend" style="margin-left:8rpx;">{{item.attended===true?'到':item.attended===false?'缺':'未签'}}</text>
    </view>
  </block>
  <button class="btn btn-ghost" style="margin-top:16rpx;" bindtap="exportFee">导出费用表(CSV)</button>
</view>
```

普通球友看自己应付（在「my status + actions」区前面加一小条）：

```xml
<view class="card" wx:if="{{detail.myStatus === 'confirmed' && detail.confirmed.length}}">
  <block wx:for="{{detail.confirmed}}" wx:key="openid">
    <view wx:if="{{item.openid === detail.createdBy || true}}"></view>
  </block>
</view>
```
> 上面这条球友视图简化：直接在 action-bar 上方加一行——找出自己的 entry 显示应付/已付。最简做法：在 detail.js `load()` 里算出 `myFee = d.confirmed.find(x=>x.openid===me)` 并 setData，然后 wxml 里：
```xml
<view class="muted" wx:if="{{myFee}}" style="margin:8rpx 16rpx;">我的费用：应付 ¥{{myFee.owedCents/100}} · {{myFee.paid?'已付':'待付'}}</view>
```
（`load()` 里加 `myFee: d.confirmed.find((x) => x.openid === me) || null,`）

### Step 3: detail.wxss（如需）

`.tag-open`/`.tag-wait`/`.tag-closed` 已是全局类，复用即可，无需新样式。

### Step 4: 语法自检 + 提交

```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/
git commit -m "feat(ui): fee AA card on detail (organizer ledger + attendee self-view)"
```

---

## Task 9: 前端 — detail 页「分组」按钮

**Files:**
- Modify: `miniprogram/pages/detail/detail.js`、`detail.wxml`

### Step 1: detail.js 加分组

`data` 加 `grouping: null, groupMode: 'groups', groupCount: 2`。

新增方法：

```js
  onGroupModeChange(e) { this.setData({ groupMode: e.detail.value === 'pairs' ? 'pairs' : 'groups' }); },
  onGroupCount(e) {
    let v = parseInt(e.detail.value, 10); if (isNaN(v) || v < 1) v = 1; if (v > 20) v = 20;
    this.setData({ groupCount: v });
  },
  async genGroups() {
    try {
      const r = await request('GET', '/api/activities/' + this.data.id + '/grouping?mode=' + this.data.groupMode + '&count=' + this.data.groupCount);
      this.setData({ grouping: r });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
```

> `request` 第二参支持带 query 的 path（现有 `request(method, path)` 直接拼 `BASE_URL + path`，所以 query 随 path 走即可）。

### Step 2: detail.wxml 加分组卡（仅组织者）

在费用卡后面加：

```xml
<view class="card" wx:if="{{isCreator && detail.confirmed.length}}">
  <view class="section-title">水平分组</view>
  <view class="row" style="margin-top:12rpx;align-items:center;">
    <text class="muted" style="width:140rpx;">模式</text>
    <picker bindchange="onGroupModeChange" value="{{groupMode==='pairs'?1:0}}" range="['分N组(场地)','双打搭档']">
      <view class="input" style="flex:1;">{{groupMode==='pairs'?'双打搭档':'分N组(场地)'}}</view>
    </picker>
  </view>
  <view class="row" wx:if="{{groupMode==='groups'}}" style="margin-top:12rpx;align-items:center;">
    <text class="muted" style="width:140rpx;">组数</text>
    <input class="input" style="flex:1;" type="number" value="{{groupCount}}" bindinput="onGroupCount" />
  </view>
  <button class="btn btn-primary" style="margin-top:16rpx;" bindtap="genGroups">生成</button>
  <block wx:if="{{grouping}}">
    <view wx:for="{{grouping.groups}}" wx:for-item="grp" wx:key="*this" style="margin-top:16rpx;">
      <view class="muted" style="font-weight:600;">{{grouping.mode==='pairs'?'搭档':'组'}} {{index+1}}</view>
      <view wx:for="{{grp}}" wx:for-item="p" wx:key="openid" style="padding:4rpx 0;">
        {{p.nickname}}（{{p.level||'未填'}}）
      </view>
    </view>
  </block>
</view>
```

### Step 3: 语法自检 + 提交

```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/
git commit -m "feat(ui): level grouping button on detail"
```

---

## Task 10: 前端 — 出勤统计页

**Files:**
- Create: `miniprogram/pages/stats/stats.{js,wxml,wxss,json}`
- Modify: `miniprogram/app.json`（注册页面）、`miniprogram/pages/profile/profile.wxml`（加入口，仅组织者可见——简化：任何人都可见入口，进去看自己建的活动的统计）

### Step 1: stats.js

```js
const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: { stats: [], loading: true },
  async onShow() {
    try { await ensureLogin(); } catch (e) {}
    try {
      const list = await request('GET', '/api/stats/attendance');
      this.setData({ stats: list, loading: false });
    } catch (e) { this.setData({ loading: false }); wx.showToast({ title: e.message, icon: 'none' }); }
  },
});
```

### Step 2: stats.wxml

```xml
<view class="container">
  <view class="section-title">出勤统计（我发起的活动）</view>
  <view wx:if="{{stats.length}}" class="card">
    <view class="roster-item" wx:for="{{stats}}" wx:key="openid" style="font-size:26rpx;">
      <text class="roster-name">{{item.nickname}}</text>
      <text class="muted">到{{item.attended}}/报{{item.confirmed}}</text>
      <text class="tag {{item.noShow>=2?'tag-closed':'tag-open'}}" style="margin-left:8rpx;">鸽{{item.noShow}}</text>
      <text class="muted" style="margin-left:8rpx;">{{item.rate>=0.8?'靠谱':'待观察'}}</text>
    </view>
  </view>
  <view wx:elif="{{!loading}}" class="empty">还没有人报名过你发起的活动</view>
</view>
```

### Step 3: stats.wxss

```css
/* 复用全局 .container/.card/.roster-item/.muted/.tag */
```

### Step 4: stats.json

```json
{ "usingComponents": {}, "navigationBarTitleText": "出勤统计" }
```

### Step 5: app.json 注册页面

在 `pages` 数组加 `"pages/stats/stats"`。

### Step 6: profile.wxml 加入口

在「我的报名」section-title 上方加：

```xml
<view class="card" bindtap="goStats" style="margin-bottom:16rpx;">
  <view class="row between"><text class="title-md">出勤统计</text><text class="muted">我发起的活动 ›</text></view>
</view>
```

profile.js 加：

```js
goStats() { wx.navigateTo({ url: '/pages/stats/stats' }); },
```

### Step 7: 语法自检 + 提交

```bash
node --check miniprogram/pages/stats/stats.js
node --check miniprogram/pages/profile/profile.js
git add miniprogram/pages/stats/ miniprogram/app.json miniprogram/pages/profile/
git commit -m "feat(ui): attendance stats page + profile entry"
```

---

## Task 11: 收尾 — 文档 + 验证

### Step 1: 后端全测

```bash
cd server && npm test
```
Expected: 全过（比 Phase 2 多 7 个用例）。

### Step 2: 前端语法扫描

```bash
for f in miniprogram/pages/*/*.js miniprogram/utils/*.js; do node --check "$f" || echo "FAIL $f"; done
```

### Step 3: 更新 README/CLAUDE.md

- README 功能清单加：球费 AA（总额均摊/固定人均，记账+导出）、水平分组/搭档、出勤统计。
- API 表加：`PUT /api/activities/:id/fee`、`POST /api/activities/:id/roster/:openid/paid`、`POST .../attend`、`GET .../fee/export`、`GET .../grouping`、`GET /api/stats/attendance`。
- CLAUDE.md「这是什么」+ 架构要点补一段 Phase 3（fee 字段用分、分组蛇形、stats 聚合、attended 共用、CSV 导出）。

### Step 4: 提交

```bash
git add CLAUDE.md README.md
git commit -m "docs: self-use depth features (fee AA / grouping / attendance) in README/CLAUDE.md"
```

---

## 风险与备注

- **不接支付**：AA 是记账+导出，组织者仍需微信群收钱；本工具解决对账痛。
- **CSV 导出**在小程序内带 token 下载较麻烦（v1 复制链接，开发者工具验证）；可后续改为 `wx.request` 取文本 + `writeFile`。
- **签到**靠组织者手动标 `attended`；未签(null) 既不算实到也不算放鸽子。
- **分组**是贪心蛇形/首尾配对，可复现但不保证全局最优。
- **分摊按实到**依赖先签到，否则池子为空、人均为 0（边界，组织者按流程先签到再设按实到费用）。
