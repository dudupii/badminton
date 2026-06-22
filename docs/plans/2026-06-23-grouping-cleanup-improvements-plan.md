# 分组清理 + 轮转改进 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 删分N组/双打搭档 UI；给轮转表和逐轮动态加 9 项改进（当前轮高亮、刷新提示、单轮复制、撤销、公平仪表盘、休息提示、中途加减场、大字显示、球员只读视图）。

**Architecture:** 3 个新后端端点（rotation/current、session/undo、session/courts）+ 前端清理 + UI 改进。后端 TDD，前端 node --check。

**Tech Stack:** Node 18+ / Express / node:test（后端）；微信小程序原生 JS（前端）。

**Branch:** 在当前 `feat/phase1-organizer-features` 上继续。

**参考：** 设计 `docs/plans/2026-06-23-grouping-cleanup-improvements-design.md`。

---

## Task 1: 后端 — 3 个新端点（currentRound / undo / courts）

**Files:** `server/src/logic.js`，`server/src/index.js`，`server/tests/logic.test.js`。

### Step 1: 写失败测试（插在 token 测试前）

```js
test('setCurrentRound + undoSession + setSessionCourts', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  for (let i = 0; i < 16; i++) await logic.register(store, act.id, 'u' + i, 1000 + i);
  // rotation currentRound
  await logic.setRotation(store, act.id, 'org', { courts: 2, rounds: 3, levelMode: 'homogeneous', fixedPairs: [] });
  const cr = await logic.setCurrentRound(store, act.id, 'org', 1);
  assert.equal(cr.rotation.currentRound, 1);
  await withError(403, logic.setCurrentRound(store, act.id, 'stranger', 0));
  // session undo
  await logic.startSession(store, act.id, 'org', { courts: 2, levelMode: 'homogeneous', matchFormat: 'any' });
  const present = Array.from({ length: 16 }, (_, i) => 'u' + i);
  await logic.assignSession(store, act.id, 'org', { present });
  assert.equal((await logic.getActivity(store, act.id)).session.currentRound, 1);
  const undone = await logic.undoSession(store, act.id, 'org');
  assert.equal(undone.session.currentRound, 0);
  assert.equal(undone.session.rounds.length, 0);
  assert.equal(undone.session.games['u0'], 0); // restored from before-snapshot
  // undo on empty → 400
  await withError(400, logic.undoSession(store, act.id, 'org'));
  await withError(403, logic.undoSession(store, act.id, 'stranger'));
  // session courts change
  const sc = await logic.setSessionCourts(store, act.id, 'org', 3);
  assert.equal(sc.session.courts, 3);
  await withError(403, logic.setSessionCourts(store, act.id, 'stranger', 2));
});
```

### Step 2: 确认失败 — `cd server && npm test 2>&1 | grep setCurrentRound` → FAIL。

### Step 3: 实现

**logic.js** — 3 个新函数（放 `clearRotation`/`clearSession` 附近）：

```js
// Set the current round highlight on a stored rotation.
async function setCurrentRound(store, id, actorOpenid, round) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    if (!a.rotation) throw httpError(400, '请先生成轮转表');
    const r = Math.max(0, Math.min(Number(round) || 0, a.rotation.schedule.length - 1));
    a.rotation.currentRound = r;
    return publicActivity(a);
  });
}

// Undo the last session round: pop it + restore games/lastRest from snapshot.
async function undoSession(store, id, actorOpenid) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    if (!a.session || a.session.rounds.length === 0) throw httpError(400, '没有可撤销的轮次');
    const popped = a.session.rounds.pop();
    a.session.currentRound = Math.max(0, a.session.currentRound - 1);
    if (popped.before) {
      a.session.games = popped.before.games;
      a.session.lastRest = popped.before.lastRest;
    }
    return { session: publicActivity(a).session };
  });
}

// Change courts count mid-session.
async function setSessionCourts(store, id, actorOpenid, courts) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    if (!a.session) throw httpError(400, '请先开始会话');
    const c = Number(courts);
    if (!Number.isInteger(c) || c < 1) throw httpError(400, '场地数需为正整数');
    a.session.courts = c;
    return publicActivity(a);
  });
}
```

**assignSession** 改：在 push round 前存快照：
```js
    const round = { courts, resting, present: present || [], before: { games: Object.assign({}, a.session.games), lastRest: Object.assign({}, a.session.lastRest) } };
```
（找到 `const round = { courts, resting, present: present || [] };` 改成上面这行。）

**setRotation** 改：存 `headcount`：
```js
      generatedAt: Date.now(),
      headcount: pool.length,
```

导出加 `setCurrentRound, undoSession, setSessionCourts,`。

**index.js** — 3 路由（放 rotation/session 路由附近）：
```js
app.post('/api/activities/:id/rotation/current', requireAuth,
  wrap(async (req) => logic.setCurrentRound(store, req.params.id, req.user.openid, req.body && req.body.round)));
app.post('/api/activities/:id/session/undo', requireAuth,
  wrap(async (req) => logic.undoSession(store, req.params.id, req.user.openid)));
app.post('/api/activities/:id/session/courts', requireAuth,
  wrap(async (req) => logic.setSessionCourts(store, req.params.id, req.user.openid, req.body && req.body.courts)));
```

### Step 4: 确认通过 — `cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"` → PASS（+1 用例）。

### Step 5: 提交
```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: rotation currentRound + session undo/courts + rotation headcount

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 前端 — 清理 + 轮转表改进（A + B + D#9 部分）

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（`node --check`。）

### Step 1: detail.js

(a) `onGroupModeChange` 改 2 项：
```js
  onGroupModeChange(e) {
    this.setData({ groupMode: Number(e.detail.value) === 1 ? 'session' : 'rotation' });
  },
```

(b) `data` 加：
```js
    rotCurrentRound: 0,
```

(c) `load()` 里，注入 `no` 后也回填 `rotCurrentRound`：
```js
      if (d.rotation) {
        d.rotation = this._injectRotationNo(d.rotation, d.confirmed);
        this.rotCurrentRound = d.rotation.currentRound || 0; // temp store
      }
```
然后在 setData 里加 `rotCurrentRound: d.rotation ? (d.rotation.currentRound || 0) : 0,`

(d) 新方法（放 `exportRotation` 附近）：
```js
  async setRotCurrentRound(r) {
    const d = this.data;
    try {
      const res = await request('POST', '/api/activities/' + d.id + '/rotation/current', { round: r });
      this.setData({ detail: { ...d.detail, rotation: this._injectRotationNo(res.rotation, d.detail.confirmed) }, rotCurrentRound: r });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  rotPrev() { const r = Math.max(0, this.data.rotCurrentRound - 1); this.setRotCurrentRound(r); },
  rotNext() { const max = (this.data.detail.rotation?.schedule?.length || 1) - 1; const r = Math.min(max, this.data.rotCurrentRound + 1); this.setRotCurrentRound(r); },
  copyOneRound(e) {
    const ri = e.currentTarget.dataset.ri;
    const rot = this.data.detail.rotation;
    if (!rot || !rot.schedule[ri]) return;
    const noMap = {}; (this.data.detail.confirmed || []).forEach((x, i) => { noMap[x.openid] = i + 1; });
    const label = (p) => (p.no || noMap[p.openid] || '?') + '-' + (p.nickname || '');
    const rd = rot.schedule[ri];
    const lines = ['第' + (ri + 1) + '轮' + (ri === this.data.rotCurrentRound ? ' ▶当前' : '')];
    rd.forEach((c, ci) => lines.push('场' + (ci + 1) + ': ' + c.map(label).join(' / ')));
    lines.push('休息: ' + (rot.resting[ri] || []).map((oid) => (noMap[oid] || '?') + '-' + ((this.data.detail.confirmed || []).find((x) => x.openid === oid) || {}).nickname || oid).join('、'));
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '第' + (ri + 1) + '轮已复制', icon: 'none' }) });
  },
```

### Step 2: detail.wxml

(a) 模式 picker 改 2 项 + 删 groups/pairs blocks：
- range: `{{['轮转表','逐轮(动态)']}}`
- value: `{{groupMode==='session'?1:0}}`
- display: `{{groupMode==='session'?'逐轮(动态)':'轮转表'}}`
- 删 `wx:if="{{groupMode==='groups'}}"` 的组数输入 + genGroups 按钮 + grouping 结果 block
- 删 `wx:if="{{groupMode==='pairs'}}"` 相关（如果有的话，在 groups block 内）

(b) 轮转结果区改进（在 `detail.rotation.schedule` 的 `wx:for` 外面包一层当前轮导航 + 每轮加大字 + 复制按钮）：

把现有的 `<block wx:if="{{detail.rotation}}">` 内容替换为：
```xml
      <block wx:if="{{detail.rotation}}">
        <!-- 刷新提示 -->
        <view wx:if="{{detail.confirmed.length !== detail.rotation.headcount}}" class="muted" style="margin-top:8rpx;color:#b45309;font-size:22rpx;">⚠ 名单有变动，建议重新生成</view>
        <!-- 当前轮导航 -->
        <view class="row between" style="margin-top:12rpx;">
          <button class="btn btn-ghost" style="padding:8rpx 24rpx;" bindtap="rotPrev">◀</button>
          <text style="font-size:32rpx;font-weight:bold;">第 {{rotCurrentRound + 1}} 轮</text>
          <button class="btn btn-ghost" style="padding:8rpx 24rpx;" bindtap="rotNext">▶</button>
        </view>
        <!-- 当前轮大字卡片 -->
        <view wx:for="{{detail.rotation.schedule[rotCurrentRound]}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="background:#16a34a;border-radius:12rpx;padding:20rpx;margin-top:12rpx;">
          <text style="color:#fff;font-size:28rpx;font-weight:bold;">场{{ci+1}}</text>
          <text style="color:#fff;font-size:30rpx;margin-left:16rpx;">{{court[0].no}}-{{court[0].nickname}}{{court[1]?' / '+court[1].no+'-'+court[1].nickname:''}}{{court[2]?' / '+court[2].no+'-'+court[2].nickname:''}}{{court[3]?' / '+court[3].no+'-'+court[3].nickname:''}}</text>
        </view>
        <!-- 当前轮休息 -->
        <view class="muted" style="margin-top:8rpx;font-size:24rpx;">休息: {{detail.rotation.resting[rotCurrentRound].length}} 人</view>
        <button class="btn btn-ghost" style="margin-top:8rpx;font-size:24rpx;" data-ri="{{rotCurrentRound}}" bindtap="copyOneRound">复制本轮</button>
        <!-- 全部轮次（折叠） -->
        <view wx:for="{{detail.rotation.schedule}}" wx:for-item="round" wx:key="*this" style="margin-top:12rpx;{{index === rotCurrentRound ? 'opacity:1;' : 'opacity:0.4;'}}">
          <view class="row between">
            <text class="muted" style="font-weight:600;">第 {{index + 1}} 轮{{index === rotCurrentRound ? ' ▶' : ''}}</text>
            <text class="muted" style="font-size:22rpx;" data-ri="{{index}}" bindtap="copyOneRound">复制</text>
          </view>
          <view wx:for="{{round}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="padding:2rpx 0;">
            <text class="muted" style="font-size:24rpx;">场{{ci+1}}：</text><text style="font-size:24rpx;">{{court[0].no}}-{{court[0].nickname}}{{court[1]?' / '+court[1].no+'-'+court[1].nickname:''}}{{court[2]?' / '+court[2].no+'-'+court[2].nickname:''}}{{court[3]?' / '+court[3].no+'-'+court[3].nickname:''}}</text>
          </view>
        </view>
      </block>
```

### Step 3: 语法自检 + 提交
```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): remove groups/pairs + rotation current-round/refresh/per-round-copy/big-display

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: 前端 — 逐轮动态改进（C + D#9 部分）

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（`node --check`。）

### Step 1: detail.js — 新方法

```js
  async undoSession() {
    try {
      const r = await request('POST', '/api/activities/' + this.data.id + '/session/undo');
      this.setData({ detail: { ...this.data.detail, session: r.session } });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async changeSessionCourts() {
    const d = this.data;
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/session/courts', { courts: d.sessCourts });
      this.setData({ detail: { ...d.detail, session: r.session } });
      wx.showToast({ title: '场地数已更新', icon: 'none' });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  // Build a sorted fairness string from session.games
  fairnessText() {
    const games = (this.data.detail.session || {}).games || {};
    const roster = this.data.detail.confirmed || [];
    return roster
      .map((p) => ({ no: p.no, nickname: p.nickname, g: games[p.openid] || 0 }))
      .sort((a, b) => b.g - a.g)
      .map((p) => p.no + '-' + p.nickname + ':' + p.g)
      .join(' · ');
  },
```

在 `assignSession` 成功后补 `fairnessText`：
```js
  async assignSession() {
    ...existing...
      this.setData({ detail: { ...d.detail, session: r.session } });
      // 更新公平度
      this.setData({ sessFairness: this.fairnessText() });
    ...
  },
```
（`data` 里加 `sessFairness: '',`）

### Step 2: detail.wxml — 在逐轮 block 的 `sessStarted` 分支里：

(a) 在「排本轮」按钮后面加：
```xml
        <!-- 公平仪表盘 -->
        <view wx:if="{{sessFairness}}" class="muted" style="margin-top:8rpx;font-size:22rpx;">公平: {{sessFairness}}</view>
        <!-- 休息提示 -->
        <view wx:if="{{detail.session.rounds.length}}" class="muted" style="margin-top:4rpx;font-size:22rpx;color:#16a34a;">休息: {{detail.session.rounds[detail.session.currentRound - 1].resting.length}} 人 → 下轮必上场</view>
        <!-- 撤销 + 改场数 -->
        <view class="row" style="margin-top:8rpx;">
          <button class="btn btn-ghost" style="flex:1;margin:0 4rpx;" bindtap="undoSession">撤销上一轮</button>
          <button class="btn btn-ghost" style="flex:1;margin:0 4rpx;" bindtap="changeSessionCourts">应用场数({{sessCourts}})</button>
        </view>
```

(b) 场地数输入在会话进行中也可见（把 `sessStarted` 判断里也显示场地数输入；或加一个在运行态的小输入）：
在 `sessStarted` block 的开头加：
```xml
        <view class="row" style="margin-top:8rpx;align-items:center;">
          <text class="muted" style="width:140rpx;">场地数</text>
          <input class="input" style="flex:1;" type="number" value="{{sessCourts}}" bindinput="onSessCourts" bindblur="onSessCourtsBlur"/>
          <text class="muted" style="margin-left:8rpx;font-size:22rpx;">改后点"应用"</text>
        </view>
```

### Step 3: 语法自检 + 提交
```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): session undo/fairness/rest-hint/mid-courts-change

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 前端 — 球员只读视图（D#10）

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（`node --check`。）

### Step 1: detail.wxml

把分组卡的 `wx:if="{{isCreator && detail.confirmed.length}}"` 拆成两个：
- 创建者：现有完整面板（`wx:if="{{isCreator && detail.confirmed.length}}"`）
- 球员只读：在创建者面板之后、action-bar 之前加一个新卡：

```xml
  <!-- 球员只读：轮转/逐轮进度 -->
  <view class="card" wx:if="{{!isCreator && detail.confirmed.length && (detail.rotation || (detail.session && detail.session.currentRound > 0))}}">
    <view class="section-title">排场进度</view>
    <!-- 轮转表（只读） -->
    <block wx:if="{{detail.rotation}}">
      <view class="muted" style="margin-top:8rpx;font-weight:600;">第 {{(detail.rotation.currentRound || 0) + 1}} 轮 ▶</view>
      <view wx:for="{{detail.rotation.schedule[detail.rotation.currentRound || 0]}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="background:#16a34a;border-radius:12rpx;padding:16rpx;margin-top:8rpx;">
        <text style="color:#fff;font-size:28rpx;">场{{ci+1}}: {{court[0].no}}-{{court[0].nickname}}{{court[1]?' / '+court[1].no+'-'+court[1].nickname:''}}{{court[2]?' / '+court[2].no+'-'+court[2].nickname:''}}{{court[3]?' / '+court[3].no+'-'+court[3].nickname:''}}</text>
      </view>
    </block>
    <!-- 逐轮（只读） -->
    <block wx:if="{{detail.session && detail.session.currentRound > 0}}">
      <view class="muted" style="margin-top:8rpx;font-weight:600;">第 {{detail.session.currentRound}} 轮 ▶</view>
      <view wx:for="{{detail.session.rounds[detail.session.currentRound - 1].courts}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="background:#16a34a;border-radius:12rpx;padding:16rpx;margin-top:8rpx;">
        <text style="color:#fff;font-size:28rpx;">场{{ci+1}}: {{court[0].no}}-{{court[0].nickname}}{{court[1]?' / '+court[1].no+'-'+court[1].nickname:''}}{{court[2]?' / '+court[2].no+'-'+court[2].nickname:''}}{{court[3]?' / '+court[3].no+'-'+court[3].nickname:''}}</text>
      </view>
    </block>
  </view>
```

### Step 2: 语法自检 + 提交
```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): player read-only view of rotation/session progress

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: 收尾 — 验证 + 文档

### Step 1: 后端全测 — `cd server && npm test`。
### Step 2: 前端语法扫描。
### Step 3: HTTP 实证：currentRound 设/读、undo、session courts。
### Step 4: 更新 README/CLAUDE.md。
### Step 5: 提交。
```bash
git add CLAUDE.md README.md
git commit -m "docs: grouping cleanup + rotation/session improvements

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 风险与备注

- 删 groups/pairs UI 不影响后端（generateGroups 端点保留、仍可用）。
- undo 深拷贝快照存在 `round.before`——每轮多一份 games/lastRest 副本，自用规模可忽略。
- `currentRound` 是 0-based，前端显示 +1。
- 球员只读视图：`!isCreator` 且有 rotation/session 才显示。
- 大字显示用内联 style（绿色背景 + 白字），不新增 wxss。
