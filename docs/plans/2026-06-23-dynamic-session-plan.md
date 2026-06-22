# 逐轮动态排场（会话模式）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给轮转加「逐轮动态」子模式——每轮组织者勾在场者→系统排当轮场地→公平/不连休跨轮累计，自然处理晚到/早退。

**Architecture:** 从 `generateRotation` 循环体抽出 `assignOneRound` 纯函数（消除重复）；新增 `activity.session` 状态 + `startSession`/`assignSession`/`clearSession` logic + 4 路由；前端详情页分组卡加「逐轮」模式。

**Tech Stack:** Node 18+ / Express / node:test（后端）；微信小程序原生 JS（前端）。

**Branch:** 在当前 `feat/phase1-organizer-features` 上继续。

**参考：** 设计 `docs/plans/2026-06-23-dynamic-session-design.md`。

---

## Task 1: 后端 — 抽出 assignOneRound + 重构 generateRotation

**Files:** `server/src/logic.js`（新增 `assignOneRound`；`generateRotation` 内部循环改调它），`server/tests/logic.test.js`。

### Step 1: 写测试（assignOneRound 直接调用——验证单轮逻辑）

插在 token 测试前：
```js
test('assignOneRound: selects + assigns one round, updates games/lastRest', () => {
  const mk = (id, lv) => ({ openid: id, nickname: id, level: lv });
  const ps = []; for (let i = 0; i < 16; i++) ps.push(mk('u' + i, ['新手','初级','中级','高级'][i % 4]));
  const games = {}; ps.forEach((p) => (games[p.openid] = 0));
  const lastRest = {}; ps.forEach((p) => (lastRest[p.openid] = false));
  const r = logic.assignOneRound(ps, { courts: 2, levelMode: 'homogeneous', matchFormat: 'any', games, lastRest });
  assert.equal(r.courts.length, 2);
  r.courts.forEach((c) => assert.equal(c.length, 4));
  assert.equal(r.resting.length, 8); // 16 - 8 = 8 resting
  // playing players' games incremented
  r.courts.flat().forEach((p) => assert.equal(r.games[p.openid], 1));
  // resters' lastRest = true
  r.resting.forEach((id) => assert.equal(r.lastRest[id], true));
  // too few present → 400
  assert.throws(() => logic.assignOneRound(ps.slice(0, 5), { courts: 2, levelMode: 'homogeneous', matchFormat: 'any', games, lastRest }), (e) => e.statusCode === 400);
});

test('assignOneRound: no-consecutive-rest (forced from lastRest)', () => {
  const mk = (id) => ({ openid: id, nickname: id, level: '中级' });
  const ps = []; for (let i = 0; i < 16; i++) ps.push(mk('u' + i));
  const games = {}; ps.forEach((p) => (games[p.openid] = 0));
  // pretend u0..u7 rested last round
  const lastRest = {}; ps.forEach((p) => (lastRest[p.openid] = false));
  for (let i = 0; i < 8; i++) lastRest['u' + i] = true;
  const r = logic.assignOneRound(ps, { courts: 2, levelMode: 'homogeneous', matchFormat: 'any', games, lastRest });
  // u0..u7 (previous resters) must all be playing this round
  r.resting.forEach((id) => assert.ok(id >= 'u8', 'previous rester not resting again: ' + id));
});
```

### Step 2: 确认失败 — `cd server && npm test 2>&1 | grep assignOneRound` → FAIL。

### Step 3: 实现

在 `generateRotation` 函数之前加纯函数（逻辑=从 generateRotation 循环体抽出）：
```js
// Assign ONE round of courts from the present players. Pure: takes games/lastRest
// state, returns updated state. Throws 400 if present < 4*courts.
function assignOneRound(presentPlayers, { courts, levelMode, matchFormat, games, lastRest }) {
  const C = Math.max(1, Number(courts) || 1);
  const slots = 4 * C;
  if (!Array.isArray(presentPlayers) || presentPlayers.length < slots) {
    throw httpError(400, '在场人数不足以填满场地（至少需 ' + slots + ' 人）');
  }
  const pool = presentPlayers.map((p) => ({ ...p, weight: levelWeight(p.level) }));
  // ensure games/lastRest cover all present
  pool.forEach((p) => {
    if (games[p.openid] == null) games[p.openid] = 0;
    if (lastRest[p.openid] == null) lastRest[p.openid] = false;
  });
  const prevResters = pool.filter((p) => lastRest[p.openid]);
  const forced = prevResters.length <= slots ? prevResters.slice() : pickFewestGames(prevResters, slots, games);
  const forcedSet = new Set(forced.map((p) => p.openid));
  const others = pool.filter((p) => !forcedSet.has(p.openid));
  const playing = forced.concat(pickFewestGames(others, slots - forced.length, games));
  const playingSet = new Set(playing.map((p) => p.openid));
  const resters = pool.filter((p) => !playingSet.has(p.openid));
  const courtsArr = assignRotationCourts(playing, C, levelMode, null, matchFormat);
  playing.forEach((p) => { games[p.openid]++; lastRest[p.openid] = false; });
  resters.forEach((p) => { lastRest[p.openid] = true; });
  return { courts: courtsArr, resting: resters.map((p) => p.openid), games, lastRest };
}
```

重构 `generateRotation`：把循环体内的逻辑替换为调 `assignOneRound`：
```js
function generateRotation(players, { courts, rounds, levelMode, fixedPairs, matchFormat }) {
  const C = Math.max(1, Number(courts) || 1);
  const R = Math.max(1, Number(rounds) || 1);
  const slots = 4 * C;
  if (!Array.isArray(players) || players.length < slots) {
    throw httpError(400, '到场人数不足以填满场地（至少需 ' + slots + ' 人）');
  }
  const pool = players.map((p) => ({ ...p, weight: levelWeight(p.level) }));
  const games = {};
  const lastRest = {};
  pool.forEach((p) => { games[p.openid] = 0; lastRest[p.openid] = false; });
  const schedule = [];
  const resting = [];
  for (let r = 0; r < R; r++) {
    const res = assignOneRound(pool, { courts: C, levelMode, matchFormat, games, lastRest });
    schedule.push(res.courts);
    resting.push(res.resting);
  }
  return { schedule, resting };
}
```

> 注意：`assignOneRound` 不传 `fixedPairs`（动态会话不支持固定搭档，YAGNI）。`generateRotation` 既有测试不传 matchFormat → `assignRotationCourts` 的 `matchFormat` 为 undefined → 走默认分支 → 行为不变。

导出加 `assignOneRound,`。

### Step 4: 确认通过 — `cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"` → PASS（+2 用例；既有 generateRotation 测试不受影响）。

### Step 5: 提交
```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "refactor: extract assignOneRound from generateRotation (reusable per-round)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 后端 — session 数据模型 + startSession/assignSession/clearSession

**Files:** `server/src/logic.js`（`publicActivity` 透出 `session`；新增三个函数），`server/src/index.js`（4 路由），`server/tests/logic.test.js`。

### Step 1: 写测试（插在 token 测试前）

```js
test('session: start + assign + clear; creator only; pool = confirmed', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  for (let i = 0; i < 16; i++) {
    await logic.register(store, act.id, 'u' + i, 1000 + i);
    await logic.updateProfile(store, 'u' + i, { level: ['新手','初级','中级','高级'][i % 4], gender: i % 2 === 0 ? '男' : '女' });
  }
  // non-creator start → 403
  await withError(403, logic.startSession(store, act.id, 'stranger', { courts: 2, levelMode: 'homogeneous', matchFormat: 'any' }));
  // start
  const s = await logic.startSession(store, act.id, 'org', { courts: 2, levelMode: 'homogeneous', matchFormat: 'any' });
  assert.equal(s.session.currentRound, 0);
  assert.equal(s.session.rounds.length, 0);
  // assign round 0 (all 16 present)
  const present = Array.from({ length: 16 }, (_, i) => 'u' + i);
  const r0 = await logic.assignSession(store, act.id, 'org', { present });
  assert.equal(r0.round.courts.length, 2);
  assert.equal(r0.session.currentRound, 1);
  // late arrival: round 1 only 12 present (u0..u3 "late")
  const present1 = Array.from({ length: 12 }, (_, i) => 'u' + (i + 4));
  const r1 = await logic.assignSession(store, act.id, 'org', { present: present1 });
  assert.equal(r1.round.courts.length, 2); // 12 ≥ 8, still 2 courts
  assert.equal(r1.session.currentRound, 2);
  // u0..u3 didn't play round 1 → their games still 1 (from round 0)
  assert.equal(r1.session.games['u0'], 1);
  // too few present → 400
  await withError(400, logic.assignSession(store, act.id, 'org', { present: ['u0', 'u1'] }));
  // clear
  await logic.clearSession(store, act.id, 'org');
  assert.equal((await logic.getActivity(store, act.id)).session, null);
  await withError(403, logic.clearSession(store, act.id, 'stranger'));
});
```

### Step 2: 确认失败 — `cd server && npm test 2>&1 | grep "session: start"` → FAIL。

### Step 3: 实现

(a) `publicActivity(a)` 加：`session: a.session || null,`

(b) 新增三个函数（放 `setRotation`/`clearRotation` 附近）：
```js
async function startSession(store, id, actorOpenid, params) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    a.session = {
      courts: Number(params.courts) || 1,
      levelMode: params.levelMode === 'balanced' ? 'balanced' : 'homogeneous',
      matchFormat: ['mens', 'womens', 'mixed'].includes(params.matchFormat) ? params.matchFormat : 'any',
      currentRound: 0,
      rounds: [],
      games: {},
      lastRest: {},
      startedAt: Date.now(),
    };
    return publicActivity(a);
  });
}

async function assignSession(store, id, actorOpenid, { present }) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    if (!a.session) throw httpError(400, '请先开始会话');
    // build player objects from confirmed roster by present openids
    const regs = state.registrations
      .filter((r) => r.activityId === id && r.status !== 'cancelled')
      .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
    const confirmed = [];
    for (const r of regs) {
      if (confirmed.length >= a.capacity) break;
      const u = state.users[r.openid] || { openid: r.openid, nickname: '未知球友', level: '', gender: '' };
      confirmed.push({ openid: r.openid, nickname: u.nickname, level: u.level || '', gender: u.gender || '' });
    }
    const presentSet = new Set(present || []);
    const presentPlayers = confirmed.filter((p) => presentSet.has(p.openid));
    const { courts, resting, games, lastRest } = assignOneRound(presentPlayers, {
      courts: a.session.courts,
      levelMode: a.session.levelMode,
      matchFormat: a.session.matchFormat,
      games: a.session.games,
      lastRest: a.session.lastRest,
    });
    const round = { courts, resting, present: present || [] };
    a.session.rounds.push(round);
    a.session.currentRound += 1;
    a.session.games = games;
    a.session.lastRest = lastRest;
    return { round, session: publicActivity(a).session };
  });
}

async function clearSession(store, id, actorOpenid) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    a.session = null;
    return { cleared: true };
  });
}
```

导出加 `startSession, assignSession, clearSession,`。

(c) `server/src/index.js` 加 4 路由（rotation 路由附近）：
```js
app.post('/api/activities/:id/session/start', requireAuth,
  wrap(async (req) => logic.startSession(store, req.params.id, req.user.openid, req.body || {})));
app.post('/api/activities/:id/session/assign', requireAuth,
  wrap(async (req) => logic.assignSession(store, req.params.id, req.user.openid, req.body || {})));
app.get('/api/activities/:id/session', optionalAuth,
  wrap(async (req) => {
    const d = await logic.getActivity(store, req.params.id, req.user && req.user.openid);
    return d.session || null;
  }));
app.delete('/api/activities/:id/session', requireAuth,
  wrap(async (req) => logic.clearSession(store, req.params.id, req.user.openid)));
```

### Step 4: 确认通过 — `cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"` → PASS。

### Step 5: 提交
```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: dynamic session (per-round court assignment) — start/assign/clear

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: 前端 — 详情页「逐轮」模式

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（`node --check`。）

### Step 1: detail.js

`data` 加：
```js
    sessCourts: 3,
    sessLevelMode: 'homogeneous',
    sessMatchFormat: 'any',
    sessPresent: {},    // {openid: true/false} — 在场标记
    sessStarted: false, // 会话是否已开始
```

`load()` 的 setData 里加（从 `d.session` 恢复）：
```js
        sessStarted: !!(d.session && d.session.currentRound > 0),
```

方法（放 `exportRotation` 附近）：
```js
  async startSession() {
    const d = this.data;
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/session/start', {
        courts: d.sessCourts, levelMode: d.sessLevelMode, matchFormat: d.sessMatchFormat,
      });
      // default: all confirmed present
      const present = {};
      (d.detail.confirmed || []).forEach((p) => { present[p.openid] = true; });
      this.setData({ detail: { ...d.detail, session: r.session }, sessPresent: present, sessStarted: true });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  toggleSessPresent(e) {
    const oid = e.currentTarget.dataset.openid;
    const p = Object.assign({}, this.data.sessPresent);
    p[oid] = !p[oid];
    this.setData({ sessPresent: p });
  },
  async assignSession() {
    const d = this.data;
    const present = Object.keys(d.sessPresent).filter((k) => d.sessPresent[k]);
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/session/assign', { present });
      this.setData({ detail: { ...d.detail, session: r.session } });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async clearSession() {
    try {
      await request('DELETE', '/api/activities/' + this.data.id + '/session');
      this.setData({ detail: { ...this.data.detail, session: null }, sessStarted: false });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  onSessCourts(e) { this.setData({ sessCourts: e.detail.value }); },
  onSessCourtsBlur(e) { let v = parseInt(e.detail.value, 10); this.setData({ sessCourts: isNaN(v) || v < 1 ? 1 : v }); },
  onSessLevelMode(e) { this.setData({ sessLevelMode: Number(e.detail.value) === 1 ? 'balanced' : 'homogeneous' }); },
  onSessMatchFormat(e) { this.setData({ sessMatchFormat: ['any','mens','womens','mixed'][Number(e.detail.value)] || 'any' }); },
  copySession() {
    const d = this.data.detail;
    const sess = d && d.session;
    if (!sess || !sess.rounds.length) return wx.showToast({ title: '暂无轮次', icon: 'none' });
    const noMap = {}; (d.confirmed || []).forEach((x, i) => { noMap[x.openid] = i + 1; });
    const nm = (oid) => (noMap[oid] || '?') + '-' + ((d.confirmed || []).find((x) => x.openid === oid) || {}).nickname || oid;
    const lines = [(d.title || '活动') + ' · 逐轮排场'];
    sess.rounds.forEach((rd, ri) => {
      lines.push('第' + (ri + 1) + '轮');
      rd.courts.forEach((c, ci) => lines.push('  场' + (ci + 1) + ': ' + c.map((p) => (noMap[p.openid] || '?') + '-' + (p.nickname || '')).join(' / ')));
      lines.push('  休息: ' + rd.resting.map(nm).join('、'));
    });
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'none' }) });
  },
```

### Step 2: detail.wxml — 模式 picker 加第四项「逐轮」，并在 `groupMode === 'session'` 时显示会话 UI

模式 picker 的 range 改为 `{{['分N组(场地)','双打搭档','轮转表','逐轮(动态)']}}`；`onGroupModeChange` 映射加 `'session'`。

会话 UI block（放在 rotation block 之后，同在分组卡内）：
```xml
    <block wx:if="{{groupMode === 'session'}}">
      <block wx:if="{{!sessStarted}}">
        <view class="row" style="margin-top:12rpx;align-items:center;">
          <text class="muted" style="width:140rpx;">场地数</text>
          <input class="input" style="flex:1;" type="number" value="{{sessCourts}}" bindinput="onSessCourts" bindblur="onSessCourtsBlur"/>
        </view>
        <view class="row" style="margin-top:12rpx;align-items:center;">
          <text class="muted" style="width:140rpx;">水平</text>
          <picker bindchange="onSessLevelMode" value="{{sessLevelMode==='balanced'?1:0}}" range="{{['同质','均衡']}}"><view class="input" style="flex:1;">{{sessLevelMode==='balanced'?'均衡':'同质'}}</view></picker>
        </view>
        <view class="row" style="margin-top:12rpx;align-items:center;">
          <text class="muted" style="width:140rpx;">赛制</text>
          <picker bindchange="onSessMatchFormat" value="{{sessMatchFormat==='mens'?1:sessMatchFormat==='womens'?2:sessMatchFormat==='mixed'?3:0}}" range="{{['不限','男双','女双','混双']}}"><view class="input" style="flex:1;">{{sessMatchFormat==='mens'?'男双':sessMatchFormat==='womens'?'女双':sessMatchFormat==='mixed'?'混双':'不限'}}</view></picker>
        </view>
        <button class="btn btn-primary" style="margin-top:16rpx;" bindtap="startSession">开始会话</button>
      </block>
      <block wx:else>
        <view class="muted" style="margin-top:12rpx;font-size:24rpx;">第 {{detail.session.currentRound + 1}} 轮 · 勾选在场者后「排本轮」</view>
        <view class="row" style="margin-top:8rpx;flex-wrap:wrap;">
          <view wx:for="{{detail.confirmed}}" wx:key="openid" data-openid="{{item.openid}}" bindtap="toggleSessPresent"
                class="tag {{sessPresent[item.openid] ? 'tag-open' : 'tag-wait'}}" style="margin:6rpx 8rpx 0 0;">{{item.nickname}}</view>
        </view>
        <button class="btn btn-primary" style="margin-top:16rpx;" bindtap="assignSession">排本轮</button>
        <button wx:if="{{detail.session}}" class="btn btn-ghost" style="margin-top:12rpx;" bindtap="copySession">复制会话(文本)</button>
        <button wx:if="{{detail.session}}" class="btn btn-danger" style="margin-top:8rpx;" bindtap="clearSession">结束会话</button>
        <block wx:if="{{detail.session && detail.session.rounds.length}}">
          <view wx:for="{{detail.session.rounds}}" wx:for-item="rd" wx:key="*this" style="margin-top:16rpx;">
            <view class="muted" style="font-weight:600;">第 {{index + 1}} 轮</view>
            <view wx:for="{{rd.courts}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="padding:4rpx 0;">
              <text class="muted">场{{ci+1}}：</text>{{court[0].nickname}}{{court[1]?'/'+court[1].nickname:''}}{{court[2]?'/'+court[2].nickname:''}}{{court[3]?'/'+court[3].nickname:''}}
            </view>
          </view>
        </block>
      </block>
    </block>
```

### Step 3: 语法自检 + 提交
```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): dynamic session mode (per-round assign with presence toggles)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 收尾 — 验证 + 文档

### Step 1: 后端全测 — `cd server && npm test`。
### Step 2: 前端语法扫描。
### Step 3: HTTP 实证（curl）：start → assign(16人) → assign(12人,晚到) → GET session → DELETE。
### Step 4: 更新 README/CLAUDE.md。
### Step 5: 提交。
```bash
git add CLAUDE.md README.md
git commit -m "docs: dynamic session mode in README/CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 风险与备注

- `assignOneRound` 是纯函数、可单测；`generateRotation` 重构后行为不变（既有测试保护）。
- 动态会话**不支持固定搭档**（YAGNI；与预排轮转表并存，要固定搭档用预排）。
- 在场默认全选（组织者取消少数晚到/早退）；`sessPresent` 是前端状态（每轮可调）。
- `present < 4×courts` → 400（提示加人或减场）。
- 会话入库 `activity.session`（刷新不丢、球员可看）；与 `rotation` 并列互不影响。
