# 活动轮转调度 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 多轮场地轮转调度——给定到场人数/场地数/轮数，生成"每轮每场谁打"的赛程表（双打、不连休、公平、水平同质/均衡、固定搭档），入库 `activity.rotation`，详情页可生成/查看/清除。

**Architecture:** 后端纯函数 `generateRotation(players, params)`（贪心，TDD）+ `index.js` 三个路由（POST 生成并存、GET 读、DELETE 清）。池 = 签到到场者（`attended === true`）。结果存 `activity.rotation`，`publicActivity` 透出。前端详情页分组卡新增「轮转表」模式。

**Tech Stack:** Node 18+ / Express / node:test（后端）；微信小程序原生 JS（前端）。

**Branch:** 在当前 `feat/phase1-organizer-features` 上继续。

**参考：** 设计 `docs/plans/2026-06-21-rotation-design.md`。

**实现顺序：** Task 1 后端算法（TDD）→ Task 2 路由/入库 → Task 3 前端 → Task 4 收尾。

---

## Task 1: 后端 — generateRotation 纯函数（贪心 + 全测试）

**Files:** `server/src/logic.js`（新增 `generateRotation` + 辅助 `assignCourts`/`reunitePairs`/`pickFewestGames`，导出 `generateRotation`），`server/tests/logic.test.js`。

### Step 1: 写失败测试（插在 `test('token sign/verify...` 前）

```js
test('generateRotation: structure + feasibility + no-2-rests (feasible) + fairness', () => {
  const mk = (id, level) => ({ openid: id, nickname: id, level });
  // 16 players, 2 courts (slots=8, 8C=16 ⇒ feasible), 4 rounds
  const ps = Array.from({ length: 16 }, (_, i) => mk('u' + i, ['新手', '初级', '中级', '高级'][i % 4]));
  const res = logic.generateRotation(ps, { courts: 2, rounds: 4, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(res.schedule.length, 4);
  res.schedule.forEach((round) => {
    assert.equal(round.length, 2); // 2 courts
    round.forEach((court) => assert.equal(court.length, 4)); // 4 each
  });
  // hard constraint: no one rests 2 rounds in a row (feasible ⇒ must hold)
  const restRounds = {};
  ps.forEach((p) => (restRounds[p.openid] = []));
  res.resting.forEach((ids, r) => ids.forEach((id) => restRounds[id].push(r)));
  Object.entries(restRounds).forEach(([id, rs]) => {
    for (let i = 1; i < rs.length; i++) assert.ok(rs[i] !== rs[i - 1] + 1, id + ' rested 2 in a row');
  });
  // fairness: games played max-min <= 1 over the feasible alternation
  const played = {};
  res.schedule.forEach((round) => round.forEach((c) => c.forEach((p) => (played[p.openid] = (played[p.openid] || 0) + 1))));
  const counts = Object.values(played);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'unfair: ' + counts.join(','));
});

test('generateRotation: relaxes no-2-rests when infeasible (players > 8*courts)', () => {
  const mk = (id) => ({ openid: id, nickname: id, level: '中级' });
  const ps = Array.from({ length: 20 }, (_, i) => mk('u' + i)); // 20 > 8*1=8
  const res = logic.generateRotation(ps, { courts: 1, rounds: 3, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(res.schedule.length, 3);
  res.schedule.forEach((round) => {
    assert.equal(round.length, 1);
    assert.equal(round[0].length, 4); // still 4 per court, no crash
  });
});

test('generateRotation: 400 when too few players to fill courts', () => {
  const ps = Array.from({ length: 5 }, (_, i) => ({ openid: 'u' + i, level: '中级' })); // 5 < 8
  assert.throws(() => logic.generateRotation(ps, { courts: 2, rounds: 2 }), (e) => e.statusCode === 400);
});

test('generateRotation: homogeneous vs balanced court composition', () => {
  const mk = (id, lv) => ({ openid: id, level: lv });
  const ps = [mk('a', '高级'), mk('b', '高级'), mk('c', '中级'), mk('d', '中级'), mk('e', '初级'), mk('f', '初级'), mk('g', '新手'), mk('h', '新手')];
  const w = (p) => ({ 新手: 1, 初级: 2, 中级: 3, 高级: 4 }[p.level]);
  // homogeneous: contiguous slice ⇒ court0 all >= court1
  const hom = logic.generateRotation(ps, { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] });
  const top0 = Math.min(...hom.schedule[0][0].map(w));
  const top1 = Math.max(...hom.schedule[0][1].map(w));
  assert.ok(top0 >= top1, 'homogeneous should tier courts');
});

test('generateRotation: fixed pairs end up on the same court', () => {
  const mk = (id) => ({ openid: id, level: '中级' });
  const ps = Array.from({ length: 8 }, (_, i) => mk('u' + i));
  const res = logic.generateRotation(ps, { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [['u0', 'u5']] });
  const courtOf = {};
  res.schedule[0].forEach((court, ci) => court.forEach((p) => (courtOf[p.openid] = ci)));
  assert.equal(courtOf['u0'], courtOf['u5'], 'fixed pair reunited');
});
```

### Step 2: 跑测试确认失败 — `cd server && npm test 2>&1 | grep generateRotation` → FAIL（not a function）。

### Step 3: 实现 — 在 `server/src/logic.js`（`generateGroups` 附近）加：

```js
// Pick n from arr preferring those with the fewest games played (stable on tie).
function pickFewestGames(arr, n, games) {
  return arr
    .slice()
    .sort((a, b) => (games[a.openid] || 0) - (games[b.openid] || 0))
    .slice(0, n);
}

// After level-based slicing, move split fixed-pair members back together (best-effort).
function reunitePairs(groups, fixedPairs) {
  const partner = {};
  (fixedPairs || []).forEach(([a, b]) => {
    partner[a] = b;
    partner[b] = a;
  });
  for (const [A, B] of fixedPairs || []) {
    const ci = groups.findIndex((g) => g.some((p) => p.openid === A));
    const cj = groups.findIndex((g) => g.some((p) => p.openid === B));
    if (ci === -1 || cj === -1 || ci === cj) continue;
    const court = groups[cj];
    let vi = court.findIndex((p) => p.openid !== B && !partner[p.openid]);
    if (vi === -1) vi = court.findIndex((p) => p.openid !== B);
    if (vi === -1) continue;
    const ai = groups[ci].findIndex((p) => p.openid === A);
    const tmp = groups[ci][ai];
    groups[ci][ai] = court[vi];
    court[vi] = tmp;
  }
}

// Split the SLOTS playing players into C courts of 4 by level mode, reuniting pairs.
function assignRotationCourts(players, courts, levelMode, fixedPairs) {
  const sorted = players.slice().sort((a, b) => levelWeight(b.level) - levelWeight(a.level)); // desc
  const groups = Array.from({ length: courts }, () => []);
  if (levelMode === 'balanced') {
    sorted.forEach((p, i) => {
      const round = Math.floor(i / courts);
      const idx = round % 2 === 0 ? i % courts : courts - 1 - (i % courts);
      groups[idx].push(p);
    });
  } else {
    sorted.forEach((p, i) => groups[Math.floor(i / 4)].push(p)); // homogeneous: contiguous
  }
  reunitePairs(groups, fixedPairs);
  return groups;
}

// Greedy multi-round rotation. Doubles (4/court). Hard "no 2 consecutive rests"
// when players <= 8*courts; relaxed (best-effort) otherwise. Fairness / level /
// fixed-pairs are soft. Throws 400 if players can't fill the courts.
function generateRotation(players, { courts, rounds, levelMode, fixedPairs }) {
  const C = Math.max(1, Number(courts) || 1);
  const R = Math.max(1, Number(rounds) || 1);
  const slots = 4 * C;
  if (!Array.isArray(players) || players.length < slots) {
    throw httpError(400, '到场人数不足以填满场地（至少需 ' + slots + ' 人）');
  }
  const pool = players.map((p) => ({ ...p, weight: levelWeight(p.level) }));
  const games = {};
  const lastRest = {};
  pool.forEach((p) => {
    games[p.openid] = 0;
    lastRest[p.openid] = false;
  });
  const schedule = [];
  const resting = [];
  for (let r = 0; r < R; r++) {
    const prevResters = pool.filter((p) => lastRest[p.openid]);
    const forced = prevResters.length <= slots ? prevResters.slice() : pickFewestGames(prevResters, slots, games);
    const forcedSet = new Set(forced.map((p) => p.openid));
    const others = pool.filter((p) => !forcedSet.has(p.openid));
    const playing = forced.concat(pickFewestGames(others, slots - forced.length, games));
    const playingSet = new Set(playing.map((p) => p.openid));
    const resters = pool.filter((p) => !playingSet.has(p.openid));
    schedule.push(assignRotationCourts(playing, C, levelMode, fixedPairs));
    resting.push(resters.map((p) => p.openid));
    playing.forEach((p) => {
      games[p.openid]++;
      lastRest[p.openid] = false;
    });
    resters.forEach((p) => {
      lastRest[p.openid] = true;
    });
  }
  return { schedule, resting };
}
```

在 `module.exports` 加 `generateRotation,`。

### Step 4: 跑测试确认通过 — `cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"` → PASS（+5 用例）。

### Step 5: 提交
```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: generateRotation (greedy multi-round court rotation)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 后端 — rotation 入库 + POST/GET/DELETE 路由

**Files:** `server/src/logic.js`（`publicActivity` 透出 `rotation`；新增 `setRotation`/`clearRotation`），`server/src/index.js`（三路由），`server/tests/logic.test.js`。

### Step 1: 写失败测试（插在 token 测试前）

```js
test('setRotation stores + clearRotation removes; creator only; pool = attended', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  // 8 attended, 2 absent
  for (let i = 0; i < 10; i++) await logic.register(store, act.id, 'u' + i, 1000 + i);
  for (let i = 0; i < 10; i++) await logic.markAttend(store, act.id, 'org', 'u' + i, i < 8);
  // non-creator rejected
  await withError(403, logic.setRotation(store, act.id, 'stranger', { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] }));
  // creator sets rotation (pool = the 8 attended)
  const r = await logic.setRotation(store, act.id, 'org', { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(r.rotation.schedule.length, 1);
  assert.equal(r.rotation.schedule[0][0].length, 4); // 4 per court
  // persisted + readable via getActivity
  const d = await logic.getActivity(store, act.id);
  assert.ok(d.rotation && d.rotation.schedule.length === 1);
  // only attended in the schedule (u8,u9 absent ⇒ excluded)
  const ids = new Set();
  d.rotation.schedule.forEach((rd) => rd.forEach((c) => c.forEach((p) => ids.add(p.openid))));
  assert.ok(!ids.has('u8') && !ids.has('u9'));
  // clear
  await logic.clearRotation(store, act.id, 'org');
  assert.equal((await logic.getActivity(store, act.id)).rotation, null);
  await withError(403, logic.clearRotation(store, act.id, 'stranger'));
});
```

### Step 2: 跑测试确认失败 — `cd server && npm test 2>&1 | grep setRotation` → FAIL。

### Step 3: 实现

(a) `publicActivity(a)` 返回对象加：`rotation: a.rotation || null,`

(b) 在 `setFee` 附近加：

```js
// Generate + persist a multi-round rotation for the activity. Pool = confirmed
// attendees (attended === true). Creator only.
async function setRotation(store, id, actorOpenid, params) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    const regs = state.registrations
      .filter((r) => r.activityId === id && r.status !== 'cancelled')
      .sort((x, y) => x.createdAt - y.createdAt);
    const confirmed = [];
    for (const r of regs) {
      if (confirmed.length >= a.capacity) break;
      const u = state.users[r.openid] || { openid: r.openid, nickname: '未知球友', level: '' };
      confirmed.push({ openid: r.openid, nickname: u.nickname, level: u.level || '' });
    }
    // pool = attended (post-start default到场 handled by treating null/true as attended)
    const pool = confirmed.filter((e, i) => {
      const r = regs[i]; // same order/sort as confirmed (filter preserves order; regs[i] aligns)
      return r.attended !== false;
    });
    const { schedule, resting } = generateRotation(pool, params); // throws 400 if too few
    a.rotation = {
      courts: Number(params.courts) || 1,
      rounds: Number(params.rounds) || 1,
      levelMode: params.levelMode === 'balanced' ? 'balanced' : 'homogeneous',
      fixedPairs: Array.isArray(params.fixedPairs) ? params.fixedPairs : [],
      schedule,
      resting,
      generatedAt: Date.now(),
    };
    return publicActivity(a);
  });
}

async function clearRotation(store, id, actorOpenid) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    a.rotation = null;
    return { cleared: true };
  });
}
```

> 注意 `pool` 的对齐：`confirmed` 与 `regs` 同序过滤（`regs[i]` 对应 `confirmed` 里第 i 个 capacity 内的 reg）。因 `filter` 保序且 `confirmed` 是 regs 的前 capacity 个，索引一致。

导出加 `setRotation, clearRotation,`。

(c) 在 `server/src/index.js`（grouping 路由附近）加：

```js
app.post(
  '/api/activities/:id/rotation',
  requireAuth,
  wrap(async (req) => logic.setRotation(store, req.params.id, req.user.openid, req.body || {}))
);
app.get(
  '/api/activities/:id/rotation',
  optionalAuth,
  wrap(async (req) => {
    const d = await logic.getActivity(store, req.params.id, req.user && req.user.openid);
    return d.rotation || null;
  })
);
app.delete(
  '/api/activities/:id/rotation',
  requireAuth,
  wrap(async (req) => logic.clearRotation(store, req.params.id, req.user.openid))
);
```

### Step 4: 跑测试确认通过 — `cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"` → PASS。

### Step 5: 提交
```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: rotation persistence + POST/GET/DELETE /api/activities/:id/rotation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: 前端 — 详情页「轮转表」模式（生成 / 查看 / 固定搭档 / 清除）

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（无单测；`node --check`。）

### Step 1: detail.js

`data` 增加：
```js
    rotMode: false, // 是否选了「轮转表」
    rotCourts: 3,
    rotRounds: 6,
    rotLevelMode: 'homogeneous', // | 'balanced'
    rotFixed: [], // [[openid,openid],…] 勾选的固定搭档
    rotPairPick: null, // 配对中已选的第 1 人 openid，null=未在配对
```

新增方法（放 `genGroups` 附近）：
```js
  async genRotation() {
    const d = this.data;
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/rotation', {
        courts: d.rotCourts,
        rounds: d.rotRounds,
        levelMode: d.rotLevelMode,
        fixedPairs: d.rotFixed,
      });
      this.setData({ detail: { ...d.detail, rotation: r.rotation } });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
  async clearRotation() {
    try {
      await request('DELETE', '/api/activities/' + this.data.id + '/rotation');
      this.setData({ detail: { ...this.data.detail, rotation: null } });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
  onRotCourts(e) { this.setData({ rotCourts: e.detail.value }); },
  onRotCourtsBlur(e) { let v = parseInt(e.detail.value, 10); this.setData({ rotCourts: isNaN(v) || v < 1 ? 1 : v }); },
  onRotRounds(e) { this.setData({ rotRounds: e.detail.value }); },
  onRotRoundsBlur(e) { let v = parseInt(e.detail.value, 10); this.setData({ rotRounds: isNaN(v) || v < 1 ? 1 : v }); },
  onRotLevelMode(e) { this.setData({ rotLevelMode: Number(e.detail.value) === 1 ? 'balanced' : 'homogeneous' }); },
  // 固定搭档：点第1人→点第2人成对；点已配对人则解除
  toggleRotPair(e) {
    const oid = e.currentTarget.dataset.openid;
    const fixed = this.data.rotFixed.slice();
    // already in a pair? remove that pair
    const existing = fixed.findIndex((pr) => pr[0] === oid || pr[1] === oid);
    if (existing >= 0) { fixed.splice(existing, 1); this.setData({ rotFixed: fixed, rotPairPick: null }); return; }
    const pick = this.data.rotPairPick;
    if (!pick) { this.setData({ rotPairPick: oid }); return; }
    if (pick === oid) { this.setData({ rotPairPick: null }); return; }
    fixed.push([pick, oid]);
    this.setData({ rotFixed: fixed, rotPairPick: null });
  },
```

> 现有分组卡的模式 picker 已有「分N组/双打搭档」两选项——本任务把它扩成三项（加「轮转表」），并据 `groupMode` 切换显示对应输入区。`groupMode === 'rotation'` 时显示轮转输入。

### Step 2: detail.wxml

(a) 把现有分组卡的「模式」picker 的 `range` 从 `['分N组(场地)','双打搭档']` 扩成 `['分N组(场地)','双打搭档','轮转表']`，并把 `onGroupModeChange` 处理扩成三态（见下）。

detail.js 的 `onGroupModeChange` 改为：
```js
  onGroupModeChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ groupMode: ['groups', 'pairs', 'rotation'][idx] || 'groups' });
  },
```

(b) 在分组卡里，`groupMode === 'rotation'` 时显示轮转输入 + 固定搭档勾选 + 生成/清除按钮 + 已存轮转表：

```xml
    <block wx:if="{{groupMode === 'rotation'}}">
      <view class="row" style="margin-top:12rpx;align-items:center;">
        <text class="muted" style="width:140rpx;">场地数</text>
        <input class="input" style="flex:1;" type="number" value="{{rotCourts}}" bindinput="onRotCourts" bindblur="onRotCourtsBlur"/>
      </view>
      <view class="row" style="margin-top:12rpx;align-items:center;">
        <text class="muted" style="width:140rpx;">轮数</text>
        <input class="input" style="flex:1;" type="number" value="{{rotRounds}}" bindinput="onRotRounds" bindblur="onRotRoundsBlur"/>
      </view>
      <view class="row" style="margin-top:12rpx;align-items:center;">
        <text class="muted" style="width:140rpx;">水平</text>
        <picker bindchange="onRotLevelMode" value="{{rotLevelMode==='balanced'?1:0}}" range="{{['同质(相近同场)','均衡(强弱搭)']}}">
          <view class="input" style="flex:1;">{{rotLevelMode==='balanced'?'均衡(强弱搭)':'同质(相近同场)'}}</view>
        </picker>
      </view>

      <view class="muted" style="margin-top:16rpx;font-size:24rpx;">固定搭档（可选）：点一人、再点另一人配对；再点已配对人解除</view>
      <view class="row" style="margin-top:8rpx;flex-wrap:wrap;">
        <view wx:for="{{detail.confirmed}}" wx:key="openid" data-openid="{{item.openid}}" bindtap="toggleRotPair"
              class="tag {{rotFixed.indexOf(item.openid) >= 0 ? 'tag-open' : (rotPairPick === item.openid ? 'tag-wait' : 'tag-level')}}" style="margin:6rpx 8rpx 0 0;">{{item.nickname}}</view>
      </view>
      <view class="muted" wx:if="{{rotPairPick}}" style="margin-top:6rpx;font-size:22rpx;">已选 1 人，再点一人配对…</view>
      <button class="btn btn-primary" style="margin-top:16rpx;" bindtap="genRotation">生成轮转</button>
      <button wx:if="{{detail.rotation}}" class="btn btn-ghost" style="margin-top:12rpx;" bindtap="clearRotation">清除轮转</button>

      <block wx:if="{{detail.rotation}}">
        <view wx:for="{{detail.rotation.schedule}}" wx:for-item="round" wx:key="*this" style="margin-top:16rpx;">
          <view class="muted" style="font-weight:600;">第 {{index+1}} 轮</view>
          <view wx:for="{{round}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="padding:4rpx 0;">
            <text class="muted">场{{ci+1}}：</text>{{court[0].nickname}}{{court[1]?'/'+court[1].nickname:''}}{{court[2]?'/'+court[2].nickname:''}}{{court[3]?'/'+court[3].nickname:''}}
          </view>
        </view>
      </block>
    </block>
```

> `rotFixed.indexOf(item.openid)` —— `rotFixed` 是二维数组，`indexOf` 一个 openid 会是 -1（因为元素是数组）。改用更稳的判断：在 `toggleRotPair` 里维护一个 `rotFixedFlat`（openid 平铺数组）供 wxml 判断。简化：把 `data` 加 `rotFixedFlat: []`，`toggleRotPair` 同步更新；wxml 用 `rotFixedFlat.indexOf(item.openid) >= 0`。实现时按此处理。

### Step 3: 语法自检 + 提交
```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): rotation mode on detail (generate/pair/view/clear)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 收尾 — 验证 + 文档

### Step 1: 后端全测 — `cd server && npm test` → 全过。
### Step 2: 前端语法扫描 — `for f in miniprogram/pages/*/*.js miniprogram/utils/*.js; do node --check "$f" || echo "FAIL $f"; done`
### Step 3: HTTP 实证（curl）：以创建者身份 POST 一个轮转（如 courts=3, rounds=5），确认返回 schedule 结构正确；GET 读取；非创建者 POST→403。
### Step 4: 更新 README/CLAUDE.md
- README 功能清单加：**轮转调度**（多轮场地轮换：双打、不连休、公平、水平同质/均衡、固定搭档、入库可查）。
- CLAUDE.md 架构要点补一段：`activity.rotation`（generateRotation 贪心、池=attended、不连休硬/人数>8×场数放宽、连打不限、公平/同质/搭档软）、POST/GET/DELETE `/rotation`。
### Step 5: 提交
```bash
git add CLAUDE.md README.md
git commit -m "docs: rotation scheduler in README/CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 风险与备注

- 贪心非最优——极端人数/场数下公平或同质可能略不均，自用规模可接受（要更优后续上模拟退火，YAGNI）。
- 固定搭档为软约束：`reunitePairs` 单遍交换，多数情况能归拢；两人本轮只到一人时约束自然失效。
- 池 = `attended !== false`（开赛后未签到者默认到场、已含；显式"缺"排除）——`setRotation` 里按 regs 顺序与 confirmed 对齐过滤。
- `schedule` 是生成时快照；名单/水平后续变化不刷新已存表（重新生成才更新）。
- 可行性：到场 < 4×场数 → 400；人数 > 8×场数 → 不报错（尽力，允许连休）。
- 前端 `rotFixed` 在 wxml 判断要用平铺的 `rotFixedFlat`（二维数组不能直接 indexOf openid）。
