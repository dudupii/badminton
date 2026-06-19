# Phase 1 组织者功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给羽毛球报名小程序加四个组织者向功能：复制上一场、候补上位订阅通知、可分享运动主题海报、水平+性别标签。

**Architecture:** 后端（`server/`）继续走「`logic.js` 纯领域逻辑 + `index.js` 薄路由 + `store.txn` 串行写锁」；所有新逻辑加在 `logic.js` 并用 `node:test` 做 TDD，路由在 `index.js` 用 `wrap()` 包装。微信平台调用（订阅消息）集中在 `wxapi.js`。前端（`miniprogram/`，原生 JS）无单测，靠 `node --check` 语法校验 + 真机/模拟器手测。

**Tech Stack:** Node 18+ / Express / node:test（后端）；微信小程序原生 JS / WXML / WXSS / canvas 2d（前端）。

**Branch:** `feat/phase1-organizer-features`（已从 `main` 拉出，设计文档已提交 `915b5dd`）。

**参考：** 设计文档 `docs/plans/2026-06-19-phase1-organizer-features-design.md`；架构与约定见 `CLAUDE.md`。

**实现顺序：** Task 1（复制上一场·后端）→ Task 6（复制上一场·前端）可合并理解；建议按 Task 编号顺序做，后端（1-4）先于前端（5-8）。每个 Task 结束都提交。

---

## Task 1: 后端 — 复制上一场（myCreatedActivities）

**Files:**
- Modify: `server/src/logic.js`（新增 `myCreatedActivities`，加入 `module.exports`）
- Modify: `server/src/index.js`（新增路由 `GET /api/activities/created-by/me`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

在 `server/tests/logic.test.js` 末尾追加：

```js
test('myCreatedActivities returns only my activities, newest first', async () => {
  const store = tmpStore();
  await logic.createActivity(store, { title: 'A', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.createActivity(store, { title: 'B', startTime: '2099-02-01T10:00:00', capacity: 4 }, 'org');
  await logic.createActivity(store, { title: 'C', startTime: '2099-03-01T10:00:00', capacity: 4 }, 'other');
  const mine = await logic.myCreatedActivities(store, 'org');
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((a) => a.title), ['B', 'A']); // newest first
  assert.ok(mine[0].code, 'returns publicActivity shape with code');
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test
```
Expected: FAIL — `logic.myCreatedActivities is not a function`。

### Step 3: 实现

在 `server/src/logic.js` 的 `myRegistrations` 函数后面加：

```js
// A creator's own activities, newest first — used by "copy last activity".
async function myCreatedActivities(store, openid) {
  const state = store.snapshot();
  return Object.values(state.activities)
    .filter((a) => a.createdBy === openid)
    .map(publicActivity)
    .sort((a, b) => b.createdAt - a.createdAt);
}
```

在 `module.exports` 里加 `myCreatedActivities,`（放在 `myRegistrations,` 后面）。

在 `server/src/index.js`，**在 `app.get('/api/activities/:id', ...)` 之前**加路由（两段路径不与 `:id` 冲突，放前面更清晰）：

```js
app.get(
  '/api/activities/created-by/me',
  requireAuth,
  wrap(async (req) => logic.myCreatedActivities(store, req.user.openid))
);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test
```
Expected: PASS（14 tests）。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: GET /api/activities/created-by/me for copy-last"
```

---

## Task 2: 后端 — 水平 / 性别标签（user schema + 名单下发）

**Files:**
- Modify: `server/src/logic.js`（`updateProfile` 校验枚举；`ensureUser` 默认值；`enrichActivity` 名单 entry 加 level/gender）
- Modify: `server/src/index.js`（`GET /api/user/me` 与 login 返回 level/gender）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

追加到 `server/tests/logic.test.js`：

```js
test('updateProfile sets level/gender and rejects invalid enums', async () => {
  const store = tmpStore();
  const u = await logic.updateProfile(store, 'u1', { level: '中级', gender: '男' });
  assert.equal(u.level, '中级');
  assert.equal(u.gender, '男');
  await withError(400, logic.updateProfile(store, 'u1', { level: '大神' }));
  await withError(400, logic.updateProfile(store, 'u1', { gender: '其它' }));
});

test('roster entries include level and gender', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.updateProfile(store, 'u1', { level: '高级', gender: '女' });
  await logic.register(store, act.id, 'u1');
  const d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed[0].level, '高级');
  assert.equal(d.confirmed[0].gender, '女');
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test
```
Expected: FAIL — level/gender 未定义。

### Step 3: 实现

在 `server/src/logic.js` 顶部（`CODE_CHARS` 附近）加枚举：

```js
const LEVELS = ['新手', '初级', '中级', '高级'];
const GENDERS = ['男', '女', '不公开'];
```

改 `ensureUser`，给新用户默认值：

```js
function ensureUser(state, openid) {
  if (!state.users[openid]) {
    state.users[openid] = {
      openid,
      nickname: '球友' + openid.slice(-4),
      avatarUrl: '',
      level: '',
      gender: '',
      subs: {},
      createdAt: Date.now(),
    };
  }
  return state.users[openid];
}
```

改 `updateProfile` 签名与校验：

```js
async function updateProfile(store, openid, { nickname, avatarUrl, level, gender }) {
  if (level !== undefined && level !== '' && !LEVELS.includes(level)) {
    throw httpError(400, '水平取值非法');
  }
  if (gender !== undefined && gender !== '' && !GENDERS.includes(gender)) {
    throw httpError(400, '性别取值非法');
  }
  return store.txn((state) => {
    const u = ensureUser(state, openid);
    if (typeof nickname === 'string' && nickname.trim()) u.nickname = nickname.trim().slice(0, 32);
    if (typeof avatarUrl === 'string') u.avatarUrl = avatarUrl;
    if (level !== undefined) u.level = level;
    if (gender !== undefined) u.gender = gender;
    return {
      openid: u.openid,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      level: u.level || '',
      gender: u.gender || '',
    };
  });
}
```

改 `enrichActivity` 的 entry（加 level/gender）：

```js
    const entry = {
      openid: r.openid,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      level: u.level || '',
      gender: u.gender || '',
      createdAt: r.createdAt,
    };
```

在 `server/src/index.js`，`GET /api/user/me` 返回 level/gender：

```js
app.get(
  '/api/user/me',
  requireAuth,
  wrap(async (req) => {
    const state = store.snapshot();
    const u = state.users[req.user.openid] || { openid: req.user.openid, nickname: '球友', avatarUrl: '', level: '', gender: '' };
    return { openid: u.openid, nickname: u.nickname, avatarUrl: u.avatarUrl, level: u.level || '', gender: u.gender || '' };
  })
);
```

（login 返回的 user 对象可选加 level/gender；为省改动可不动，profile 页会再拉 `/api/user/me`。）

### Step 4: 跑测试确认通过

```bash
cd server && npm test
```
Expected: PASS（16 tests）。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: level/gender tags on user + roster entries"
```

---

## Task 3: 后端 — 订阅配额（addSubscription / consumeSubscription）

**Files:**
- Modify: `server/src/logic.js`（`user.subs`；`addSubscription`、`consumeSubscription`）
- Modify: `server/src/index.js`（`POST /api/subscriptions`）
- Test: `server/tests/logic.test.js`

### Step 1: 写失败测试

追加到 `server/tests/logic.test.js`：

```js
test('subscription credits: add then consume', async () => {
  const store = tmpStore();
  await logic.ensureUserViaStore(store, 'u1'); // ensure user exists
  await logic.addSubscription(store, 'u1', 'TPL_A');
  await logic.addSubscription(store, 'u1', 'TPL_A');
  assert.equal(await logic.consumeSubscription(store, 'u1', 'TPL_A'), true);
  assert.equal(await logic.consumeSubscription(store, 'u1', 'TPL_A'), true);
  assert.equal(await logic.consumeSubscription(store, 'u1', 'TPL_A'), false); // no credit left
});
```

> 注：测试里需要一个能建用户的入口。`ensureUser` 目前不导出且只接受 state。**实现 Step 3 时导出一个 `ensureUserExists(store, openid)` 薄包装供测试用**（也供将来用）。

### Step 2: 跑测试确认失败

```bash
cd server && npm test
```
Expected: FAIL — `addSubscription` / `ensureUserViaStore` 未定义。

### Step 3: 实现

在 `server/src/logic.js` 加（放在 `updateProfile` 后面）：

```js
async function ensureUserExists(store, openid) {
  return store.txn((state) => {
    const u = ensureUser(state, openid);
    return { openid: u.openid };
  });
}

// One-time subscribe = one sendable credit per (openid, templateId).
async function addSubscription(store, openid, templateId) {
  if (!templateId) throw httpError(400, '缺少 templateId');
  return store.txn((state) => {
    const u = ensureUser(state, openid);
    u.subs = u.subs || {};
    u.subs[templateId] = (u.subs[templateId] || 0) + 1;
    return { templateId, credits: u.subs[templateId] };
  });
}

// Returns true if a credit was consumed; false if none left.
async function consumeSubscription(store, openid, templateId) {
  return store.txn((state) => {
    const u = state.users[openid];
    if (!u || !u.subs || !u.subs[templateId]) return false;
    u.subs[templateId] -= 1;
    if (u.subs[templateId] <= 0) delete u.subs[templateId];
    return true;
  });
}
```

`module.exports` 加 `ensureUserExists, addSubscription, consumeSubscription,`。

在 `server/src/index.js` 加路由（放在 registrations 段附近）：

```js
// --- subscriptions (one-time subscribe-message credits) --------------------
app.post(
  '/api/subscriptions',
  requireAuth,
  wrap(async (req) => {
    const templateId = req.body && req.body.templateId;
    return logic.addSubscription(store, req.user.openid, templateId);
  })
);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test
```
Expected: PASS（17 tests）。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: subscription credits (add/consume) + POST /api/subscriptions"
```

---

## Task 4: 后端 — 候补上位通知（wxapi.sendSubscribeMessage + cancel 路由触发）

**Files:**
- Modify: `server/src/wxapi.js`（`sendSubscribeMessage`）
- Modify: `server/src/config.js`（订阅模板 id）
- Modify: `server/src/index.js`（`POST /api/activities/:id/cancel` 触发通知）
- Test: 见 Step 1（消费配额逻辑已在上一个 Task 覆盖；本 Task 的「路由触发」无 HTTP 单测，靠手测 + 已测的 consumeSubscription）

### Step 1: 写测试（cancel 仍正确返回 promoted，回归保护）

`cancel` 行为不变（已有测试覆盖 promoted）。本 Task 只是在路由层叠加「发送」副作用，不进 logic 单测。跳过新测试，直接实现。

### Step 2: 实现 wxapi.sendSubscribeMessage

在 `server/src/wxapi.js` 的 `getMiniProgramCode` 后面加：

```js
// Send a one-time subscribe message. `data` keys must match the template's
// field names (e.g. { thing1: { value: '...' }, time2: { value: '...' } }).
async function sendSubscribeMessage(openid, templateId, data, page) {
  const token = await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`;
  const state = config.wx.envVersion === 'release' ? 'formal' : config.wx.envVersion === 'trial' ? 'trial' : 'developer';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: openid,
      template_id: templateId,
      page,
      data,
      miniprogram_state: state,
      lang: 'zh_CN',
    }),
  });
  const j = await res.json();
  if (j.errcode) {
    const err = new Error(`subscribe send failed: ${JSON.stringify(j)}`);
    err.detail = j;
    throw err;
  }
  return j;
}
```

`module.exports` 改为 `module.exports = { getAccessToken, getMiniProgramCode, sendSubscribeMessage };`

### Step 3: config 加模板 id

在 `server/src/config.js` 的 `wx` 块里加：

```js
    // Subscribe-message template ids (create in MP console → 订阅消息).
    // promoteTpl: sent when a waitlisted user is auto-promoted.
    subscribeTemplates: {
      promote: process.env.WX_PROMOTE_TPL || '',
    },
```

### Step 4: cancel 路由触发通知

在 `server/src/index.js`，把现有 `POST /api/activities/:id/cancel` 替换为：

```js
app.post(
  '/api/activities/:id/cancel',
  requireAuth,
  wrap(async (req) => {
    const result = await logic.cancel(store, req.params.id, req.user.openid);
    // If someone was auto-promoted, notify them (event-driven, no scheduler).
    if (result.promoted) {
      const tpl = config.wx.subscribeTemplates.promote;
      const acted = tpl && !config.wx.devMode && await logic.consumeSubscription(store, result.promoted.openid, tpl);
      if (acted) {
        const a = store.snapshot().activities[req.params.id];
        try {
          await wxapi.sendSubscribeMessage(
            result.promoted.openid,
            tpl,
            {
              thing1: { value: a ? a.title : '活动' },
              time2: { value: a ? new Date(a.startTime).toLocaleString('zh-CN') : '' },
              thing3: { value: a ? (a.location || '见详情') : '' },
            },
            'pages/detail/detail?id=' + req.params.id
          );
        } catch (e) {
          console.error('promote notify failed:', e.message); // non-fatal
        }
      }
    }
    return result;
  })
);
```

> 字段名 `thing1/time2/thing3` 需与你在小程序后台创建的模板字段对齐；上线前按真实模板调整。

### Step 5: 跑全测 + 语法自检

```bash
cd server && npm test
```
Expected: PASS（17 tests，cancel 回归不受影响）。

### Step 6: 提交

```bash
git add server/src/wxapi.js server/src/config.js server/src/index.js
git commit -m "feat: waitlist-promotion subscribe message (event-driven on cancel)"
```

---

## Task 5: 前端 — profile 水平 / 性别选择

**Files:**
- Modify: `miniprogram/pages/profile/profile.js`
- Modify: `miniprogram/pages/profile/profile.wxml`
- (无单测；`node --check` + 真机手测)

### Step 1: 改 profile.js

`data` 增加 `levels`、`genders`，`user` 增加 `level/gender`；`loadMe` 带回 level/gender；新增 `onLevelChange`/`onGenderChange`；`saveProfile` 带上 level/gender。

把 `data` 改为：

```js
  data: {
    user: { nickname: '', avatarUrl: '', level: '', gender: '' },
    levels: ['新手', '初级', '中级', '高级'],
    genders: ['男', '女', '不公开'],
    regs: [],
    loading: true,
  },
```

`loadMe` 改为（保留原逻辑，附带 level/gender）：

```js
  async loadMe() {
    try {
      const u = await request('GET', '/api/user/me');
      this.setData({ user: u });
      getApp().globalData.userInfo = u;
    } catch (e) { /* ignore */ }
  },
```

新增方法（放 `onNicknameBlur` 附近）：

```js
  onLevelChange(e) {
    this.setData({ 'user.level': this.data.levels[e.detail.value] });
    this.saveProfile();
  },
  onGenderChange(e) {
    this.setData({ 'user.gender': this.data.genders[e.detail.value] });
    this.saveProfile();
  },
```

`saveProfile` 改为带 level/gender：

```js
  async saveProfile() {
    try {
      const u = this.data.user;
      await request('PATCH', '/api/user/me', {
        nickname: u.nickname,
        avatarUrl: u.avatarUrl,
        level: u.level,
        gender: u.gender,
      });
    } catch (e) { /* ignore */ }
  },
```

### Step 2: 改 profile.wxml

在昵称输入那一块下面、报名列表上面，加两个 `<picker>`：

```xml
    <view class="field-row">
      <view class="field-label">水平</view>
      <picker bindchange="onLevelChange" value="{{levels.indexOf(user.level)}}" range="{{levels}}">
        <view class="picker-val">{{user.level || '请选择'}}</view>
      </picker>
    </view>
    <view class="field-row">
      <view class="field-label">性别</view>
      <picker bindchange="onGenderChange" value="{{genders.indexOf(user.gender)}}" range="{{genders}}">
        <view class="picker-val">{{user.gender || '请选择'}}</view>
      </picker>
    </view>
```

在 `profile.wxss` 加（如未有）：

```css
.field-row { display: flex; align-items: center; margin-top: 20rpx; }
.field-row .field-label { width: 120rpx; color: #6b7280; }
.picker-val { color: #374151; }
```

### Step 3: 语法自检

```bash
node --check miniprogram/pages/profile/profile.js
```
Expected: 无输出（语法 OK）。

### Step 4: 提交

```bash
git add miniprogram/pages/profile/
git commit -m "feat(ui): level/gender pickers on profile"
```

---

## Task 6: 前端 — 名单显示水平/性别徽章 + 性别汇总

**Files:**
- Modify: `miniprogram/pages/detail/detail.js`（算性别汇总）
- Modify: `miniprogram/pages/detail/detail.wxml`（徽章 + 汇总）
- Modify: `miniprogram/pages/detail/detail.wxss`（徽章样式）

### Step 1: detail.js load() 算汇总

在 `load()` 的 `this.setData({...})` 里加：

```js
        genderCount: {
          male: d.confirmed.filter((x) => x.gender === '男').length,
          female: d.confirmed.filter((x) => x.gender === '女').length,
        },
```

并在 `data` 初始加 `genderCount: { male: 0, female: 0 }`。

### Step 2: detail.wxml 名单加徽章

正式名单的 `roster-item` 里，`roster-name` 后面加：

```xml
        <text wx:if="{{item.level}}" class="tag tag-level">{{item.level}}</text>
        <text wx:if="{{item.gender}}" class="tag tag-gender tag-gender-{{item.gender}}">{{item.gender}}</text>
```

在容量行（`已报名` 那行）后面加汇总：

```xml
      <view wx:if="{{genderCount.male || genderCount.female}}" class="muted" style="margin-top:6rpx;font-size:24rpx;">男 {{genderCount.male}} · 女 {{genderCount.female}}</view>
```

### Step 3: detail.wxss 加徽章样式

```css
.tag-level { background:#dbeafe; color:#1d4ed8; }
.tag-gender { background:#f3f4f6; color:#6b7280; }
.tag-gender-男 { background:#dbeafe; color:#1d4ed8; }
.tag-gender-女 { background:#fce7f3; color:#be185d; }
```

### Step 4: 语法自检 + 提交

```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/
git commit -m "feat(ui): level/gender badges + gender tally on roster"
```

---

## Task 7: 前端 — 复制上一场

**Files:**
- Modify: `miniprogram/pages/create/create.js`
- Modify: `miniprogram/pages/create/create.wxml`

### Step 1: create.js 加 copyLast

文件顶部已 `require('../../utils/request')`。在 `onLoad` 后面加方法：

```js
  async copyLast() {
    try {
      const list = await request('GET', '/api/activities/created-by/me');
      if (!list.length) {
        return wx.showToast({ title: '还没有历史活动可复制', icon: 'none' });
      }
      const last = list[0]; // newest
      const lastStart = new Date(last.startTime);
      // shift +7 days, keep same weekday & time
      const next = new Date(lastStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      this.setData({
        title: last.title || '',
        location: last.location || '',
        description: last.description || '',
        capacity: last.capacity || 8,
        startDate: this.dateStr(next),
        startTime: this.timeStr(lastStart),
        endDate: this.dateStr(next),
        // endTime 沿用当前默认即可
      });
      wx.showToast({ title: '已复制，请核对时间', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
```

> `create.js` 现在用的是「picker 版」（见仓库当前状态）。它有模块级 `pad(n)` 和 `dateStr(d)`，但**没有** `timeStr`。在模块顶部补一个，并把 `dateStr`/`pad` 挂到 Page 上以便 `copyLast` 复用。最简做法：在 `copyLast` 里直接用模块级函数（它们在闭包里可见），并新增模块级 `timeStr`：

在 `create.js` 顶部 `dateStr` 后面加：

```js
function timeStr(d) {
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
```

`copyLast` 里 `this.dateStr(next)` 改为 `dateStr(next)`、`this.timeStr(lastStart)` 改为 `timeStr(lastStart)`（用模块级函数）。

### Step 2: create.wxml 加按钮

在第一个 `.field`（活动标题）**之前**，加：

```xml
    <button class="btn btn-ghost copy-btn" bindtap="copyLast">复制上一场</button>
```

`create.wxss` 加 `.copy-btn { margin-bottom: 20rpx; }`（复用全局 `.btn-ghost`）。

### Step 3: 语法自检 + 提交

```bash
node --check miniprogram/pages/create/create.js
git add miniprogram/pages/create/
git commit -m "feat(ui): copy-last-activity button on create page"
```

---

## Task 8: 前端 — 候补上位订阅（报名时 requestSubscribeMessage）

**Files:**
- Modify: `miniprogram/utils/config.js`（模板 id）
- Modify: `miniprogram/pages/detail/detail.js`（`doRegister` 改造）

### Step 1: config.js 加模板 id

`miniprogram/utils/config.js` 末尾 `module.exports` 前加：

```js
// 订阅消息模板 id（小程序后台「订阅消息」创建后填入）
const SUBSCRIBE_TEMPLATES = {
  promote: 'PROMOTE_TPL_ID', // ← 上线前替换为真实 templateId
};
```

`module.exports` 改为：

```js
module.exports = { BASE_URL, ENV, DEV_URL, PROD_URL, SUBSCRIBE_TEMPLATES };
```

### Step 2: detail.js doRegister 改造

文件顶部 require 加 `SUBSCRIBE_TEMPLATES`：

```js
const { BASE_URL, SUBSCRIBE_TEMPLATES } = require('../../utils/config');
```

把 `doRegister` 替换为：

```js
  async doRegister() {
    const tpl = SUBSCRIBE_TEMPLATES.promote;
    // 先请求「上位通知」一次性订阅授权（用户可拒绝，不影响报名）
    let accepted = null;
    if (tpl && tpl !== 'PROMOTE_TPL_ID') {
      try {
        accepted = await new Promise((res) =>
          wx.requestSubscribeMessage({ tmplIds: [tpl], success: res, fail: () => res(null) })
        );
      } catch (e) { accepted = null; }
    }
    try {
      const r = await request('POST', '/api/activities/' + this.data.id + '/register');
      if (accepted && accepted[tpl] === 'accept') {
        try { await request('POST', '/api/subscriptions', { templateId: tpl }); } catch (e) {}
      }
      wx.showToast({ title: r.message, icon: 'none', duration: 2000 });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
```

> 占位 `PROMOTE_TPL_ID` 未替换时跳过订阅请求，保证开发期不报错。

### Step 3: 语法自检 + 提交

```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/utils/config.js miniprogram/pages/detail/detail.js
git commit -m "feat(ui): request waitlist-promotion subscribe on register"
```

---

## Task 9: 前端 — 可分享活动海报（canvas 2d，运动主题背景）

**Files:**
- Modify: `miniprogram/pages/detail/detail.wxml`（canvas + 按钮）
- Modify: `miniprogram/pages/detail/detail.js`（`generatePoster`）
- Modify: `miniprogram/pages/detail/detail.wxss`（canvas 尺寸）

### Step 1: detail.wxml 加 canvas 与按钮

在「邀请报名」那张 QR 卡片里，`qr-actions` 那行后面加一个按钮 + 一个离屏 canvas：

```xml
    <view class="row qr-actions">
      <button class="btn btn-ghost qr-btn" bindtap="saveQrToAlbum">保存二维码</button>
      <button class="btn btn-primary qr-btn" open-type="share">转发给好友</button>
    </view>
    <button class="btn btn-ghost" style="margin-top:18rpx;" bindtap="generatePoster">生成活动海报</button>
  </view>
</view>

<!-- 离屏海报画布（不可见，仅用于导出图片） -->
<canvas type="2d" id="poster" class="poster-canvas"></canvas>
```

> 注意：`<canvas>` 要放在最外层、且不在 `wx:if` 里（否则 `createSelectorQuery` 取不到 node）。用 CSS 藏到屏外。

### Step 2: detail.wxss 加 canvas 样式

```css
.poster-canvas {
  position: fixed;
  left: -9999rpx;
  top: 0;
  width: 600rpx;
  height: 900rpx;
}
```

### Step 3: detail.js 加 generatePoster

在 `saveQrToAlbum` 后面加（含一个本地 `wrapText` 辅助）：

```js
  async generatePoster() {
    const d = this.data.detail;
    if (!d) return;
    wx.showLoading({ title: '生成中' });
    try {
      // 1. 拉二维码图
      const dl = await new Promise((res, rej) =>
        wx.downloadFile({ url: this.data.qrcodeUrl, success: res, fail: rej })
      );
      // 2. 取 canvas 节点
      const { canvas, ctx, W, H, dpr } = await new Promise((res, rej) => {
        wx.createSelectorQuery()
          .select('#poster')
          .fields({ node: true, size: true })
          .exec((r) => (r && r[0] && r[0].node ? res(r[0]) : rej(new Error('canvas 不存在'))));
      }).then((info) => {
        const c = info.node;
        const ctx = c.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio;
        c.width = info.width * dpr;
        c.height = info.height * dpr;
        ctx.scale(dpr, dpr);
        return { canvas: c, ctx, W: info.width, H: info.height, dpr };
      });

      // 3. 运动主题背景：绿渐变 + 🏸 水印
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#16a34a');
      g.addColorStop(1, '#065f46');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.font = '120px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillText('🏸', W - 150, 170);

      // 4. 文案
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      this._wrapText(ctx, d.title || '羽毛球活动', 36, 90, W - 72, 38);
      ctx.font = '22px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      let y = 220;
      ctx.fillText('⏰ ' + d.timeText, 36, y); y += 36;
      if (d.location) { ctx.fillText('📍 ' + d.location, 36, y); y += 36; }
      ctx.fillText('名额 ' + d.confirmedCount + '/' + d.capacity, 36, y);

      // 5. 二维码（加载图片后绘制并导出）
      const img = canvas.createImage();
      img.onload = () => {
        ctx.drawImage(img, W - 200, H - 230, 164, 164);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '18px sans-serif';
        ctx.fillText('扫码报名', W - 180, H - 44);
        wx.canvasToTempFilePath({
          canvas,
          success: (out) => {
            wx.hideLoading();
            wx.previewImage({ urls: [out.tempFilePath] }); // 长按可保存/分享
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }); },
        });
      };
      img.onerror = () => { wx.hideLoading(); wx.showToast({ title: '二维码加载失败', icon: 'none' }); };
      img.src = dl.tempFilePath;
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '生成失败', icon: 'none' });
    }
  },

  _wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    // 简易中文换行（按字符）
    let line = '';
    for (const ch of String(text)) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        line = ch;
        y += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, y);
  },
```

### Step 4: 语法自检 + 提交

```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/
git commit -m "feat(ui): shareable sport-themed activity poster (canvas 2d)"
```

---

## 收尾验证

1. **后端全测**：`cd server && npm test` → 期望 17 全过。
2. **前端语法**：
   ```bash
   for f in miniprogram/pages/*/*.js miniprogram/utils/*.js; do node --check "$f" || echo "FAIL $f"; done
   ```
3. **端到端（真机/模拟器）**：
   - profile 选水平/性别 → 名单出现徽章 + 男/女汇总。
   - create 点「复制上一场」→ 表单被预填、时间 +7 天。
   - detail 点「生成活动海报」→ 预览出绿底 + 🏸 + 信息 + 二维码的海报图，长按可存。
   - 上位通知：需在小程序后台建模板、填 `WX_PROMOTE_TPL`（server `.env`）与 `SUBSCRIBE_TEMPLATES.promote`（前端 config）、配真实 `WX_APPID/SECRET`，再让 A 报名（同意订阅）→ 候补 → B 取消 → A 收到上位通知。
4. **更新 CLAUDE.md / README**：把「订阅消息 / 海报 / 标签 / 复制上一场」补进功能清单与新端点表（最后单独一个 commit）。

```bash
git add CLAUDE.md README.md
git commit -m "docs: Phase 1 features in README/CLAUDE.md"
```

---

## 风险与备注

- **订阅消息字段名**（`thing1/time2/thing3`）必须与后台真实模板一致，上线前核对；占位 id `PROMOTE_TPL_ID` 未替换时前端自动跳过订阅、后端 `devMode` 不发送。
- **海报 canvas** 必须真机测（模拟器 canvas 2d 偶有渲染差异）；`<canvas>` 不能放 `wx:if` 内。
- **水平/性别枚举**改动是兼容的（旧用户 level/gender 为空，前端显示「请选择」）。
- **复制上一场**用 `+7 天` 保持同星期；若用户想改其它周期，后续可在 create 加「周期」选项（Phase 2）。
