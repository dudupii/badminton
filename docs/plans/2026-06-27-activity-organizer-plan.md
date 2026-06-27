# 活动组织者字段 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给活动加一个「组织者」展示字段，缺省创建者昵称、可改（如俱乐部名），创建后记住为该创建者的默认偏好。

**Architecture:** `activity.organizer`（字符串，空兜底昵称）+ `user.defaultOrganizer`（显式偏好字段）。`createActivity` 写入 organizer 并更新创建者的 defaultOrganizer；`updateActivity` 可改 organizer 但不动默认；`publicActivity` 透出；`GET /api/user/me` 下发 defaultOrganizer 供 create 页预填。前端详情页头部 + 列表卡片展示。

**Tech Stack:** Node/Express 后端（`node --test` 针对 `logic.js`）；微信小程序原生 JS（`node --check`）。

**Design doc:** `docs/plans/2026-06-27-activity-organizer-design.md`

**无需迁移**：老活动无 `organizer` 字段 → `publicActivity` 用 `a.organizer || null` 透出 → 前端 `wx:if` 不显示；老用户无 `defaultOrganizer` → `/api/user/me` 用 `|| ''` → create 页预填回退到昵称。新活动/新用户自然带上。

---

## Task 1: 后端 organizer 字段 + defaultOrganizer（TDD：红 → 绿）

**Files:**
- Modify: `server/src/logic.js`（`publicActivity` ~293、`ensureUser` ~316、`createActivity` ~397、`updateActivity` ~634）
- Modify: `server/src/index.js`（`GET /api/user/me` ~87）
- Test: `server/tests/logic.test.js`（追加 4 个 test）

### Step 1: 写失败的测试

在 `server/tests/logic.test.js` 末尾追加：

```js
test('createActivity: organizer defaults to creator nickname and is remembered', async () => {
  const store = tmpStore();
  await logic.updateProfile(store, 'org', { nickname: '队长' });
  const a = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org', 1000);
  assert.equal(a.organizer, '队长');
  assert.equal(store.snapshot().users['org'].defaultOrganizer, '队长');
});

test('createActivity: custom organizer is stored and becomes the default', async () => {
  const store = tmpStore();
  await logic.updateProfile(store, 'org', { nickname: '队长' });
  const a = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4, organizer: '飞羽俱乐部' }, 'org', 1000);
  assert.equal(a.organizer, '飞羽俱乐部');
  assert.equal(store.snapshot().users['org'].defaultOrganizer, '飞羽俱乐部');
});

test('publicActivity exposes organizer', async () => {
  const store = tmpStore();
  const a = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4, organizer: 'X' }, 'org', 1000);
  assert.equal(a.organizer, 'X');
});

test('updateActivity edits organizer without changing defaultOrganizer', async () => {
  const store = tmpStore();
  const a = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4, organizer: '飞羽' }, 'org', 1000);
  assert.equal(store.snapshot().users['org'].defaultOrganizer, '飞羽');
  const updated = await logic.updateActivity(store, a.id, 'org', { organizer: '别的名' });
  assert.equal(updated.organizer, '别的名');
  assert.equal(store.snapshot().users['org'].defaultOrganizer, '飞羽'); // 编辑不改默认
});
```

### Step 2: 跑测试，确认失败

Run: `cd server && npm test`
Expected: FAIL（前两个：`a.organizer` undefined；第三个同理；第四个 `updated.organizer` undefined）。

### Step 3: 实现

**(a)** `publicActivity`（~293-312）—— 在返回对象里加一行（放在 `clubId` 后面）：
```js
    clubId: a.clubId || null,
    organizer: a.organizer || null,
    fee: a.fee || null,
```

**(b)** `ensureUser`（~316-329）—— 用户对象加字段：
```js
      gender: '',
      defaultOrganizer: '',
      subs: {},
```

**(c)** `createActivity`（~397-435）—— 在 txn 内、建 activity 前，取 creator 算 organizer；建完后更新 creator.defaultOrganizer。把 txn 体内改成：
```js
  return store.txn((state) => {
    if (!opts.skipRateLimit) {
      const recentActivities = Object.values(state.activities).filter(
        (x) => x.createdBy === creatorOpenid && x.createdAt > now - LIMITS.activityWindowMs
      ).length;
      if (recentActivities >= LIMITS.activityWindowMax) {
        throw httpError(429, '近期创建活动过多，请稍后再试');
      }
    }
    const creator = state.users[creatorOpenid] || ensureUser(state, creatorOpenid);
    const organizer = (input.organizer || '').trim() || creator.nickname;
    const activity = {
      id: newId('act_'),
      code: genCode(state),
      title,
      description: (input.description || '').trim().slice(0, LIMITS.descriptionMax),
      location: (input.location || '').trim().slice(0, LIMITS.locationMax),
      startTime,
      endTime,
      capacity,
      createdBy: creatorOpenid,
      createdAt: now,
      status: 'open',
      clubId: input.clubId || null,
      organizer,
      rules,
    };
    state.activities[activity.id] = activity;
    creator.defaultOrganizer = organizer; // 记住这次用的（仅创建时更新）
    return publicActivity(activity);
  });
```

**(d)** `updateActivity` 字段更新段（~634-640）—— 加一行（编辑不改 defaultOrganizer）：
```js
    if (input.rules !== undefined) a.rules = validateRules(input.rules);
    if (input.organizer !== undefined) a.organizer = (input.organizer || '').trim() || a.organizer;
    return publicActivity(a);
```

**(e)** `GET /api/user/me`（`server/src/index.js` ~87-95）—— 下发 defaultOrganizer：
```js
    return { openid: u.openid, nickname: u.nickname, avatarUrl: u.avatarUrl, level: u.level || '', gender: u.gender || '', defaultOrganizer: u.defaultOrganizer || '' };
```

### Step 4: 跑全量，确认通过

Run: `cd server && npm test`
Expected: 全部 PASS（含 4 个新测试）。

### Step 5: 提交

```bash
git add server/src/logic.js server/src/index.js server/tests/logic.test.js
git commit -m "feat: 活动 organizer 字段 + user.defaultOrganizer 记忆偏好"
```
（加 Co-Authored-By trailer）

---

## Task 2: 前端 create 页（输入框 + 预填 + 编辑/复制回填 + 提交）

**Files:** `miniprogram/pages/create/create.js`、`create.wxml`。无自动测试，靠 `node --check`。

### Step 1: `create.js` —— `data` 加字段

在 `data` 块里 `title: '',` 下面加：
```js
    organizer: '',
```

### Step 2: `create.js` —— 新建时预填默认组织者

在 `onLoad`（~45-56）末尾，把 `if (q && q.id) this.loadForEdit(q.id);` 改成：
```js
    if (q && q.id) {
      this.loadForEdit(q.id);
    } else {
      this.prefillOrganizer();
    }
```
并新增方法（放在 `onLoad` 后）：
```js
  // 新建活动：用记住的默认组织者（没有就回退昵称）预填。
  async prefillOrganizer() {
    try {
      const me = await request('GET', '/api/user/me');
      this.setData({ organizer: me.defaultOrganizer || me.nickname || '' });
    } catch (e) {
      /* 忽略——留空，提交时后端兜底昵称 */
    }
  },
```

### Step 3: `create.js` —— 编辑/复制回填

`loadForEdit`（~59-93）的 `patch` 对象里，`title: a.title || '',` 下面加：
```js
        organizer: a.organizer || '',
```

`copyLast`（~95-118）的 `this.setData({...})` 里，`title: last.title || '',` 下面加：
```js
        organizer: last.organizer || '',
```

### Step 4: `create.js` —— `submit` 带上 organizer

`submit` 的 `payload`（~262-269）加一行：
```js
    const payload = {
      title: d.title.trim(),
      organizer: d.organizer.trim(),
      location: d.location.trim(),
      description: d.description.trim(),
      startTime: start.toISOString(),
      endTime,
      capacity: Number(d.capacity),
    };
```

### Step 5: `create.wxml` —— 加「组织者」输入框

在「活动标题」`<view class="field">...</view>`（~4-14）之后、「地点」field（~16）之前，插入：
```xml
    <view class="field">
      <view class="field-label">组织者</view>
      <input
        class="input"
        placeholder="如：俱乐部名（默认你的昵称）"
        maxlength="32"
        value="{{organizer}}"
        data-field="organizer"
        bindinput="onInput"
      />
    </view>
```

### Step 6: 语法校验

```bash
node --check miniprogram/pages/create/create.js
```
Expected: 无输出（OK）。

### Step 7: 提交

```bash
git add miniprogram/pages/create/create.js miniprogram/pages/create/create.wxml
git commit -m "feat: create 页加组织者输入框（默认昵称/记住偏好/编辑复制回填）"
```
（加 Co-Authored-By trailer）

---

## Task 3: 前端展示（详情页头部 + 首页卡片）

**Files:** `miniprogram/pages/detail/detail.wxml`、`miniprogram/pages/index/index.wxml`。无需改对应 .js（接口字段直接透传）。

### Step 1: `detail.wxml` —— 头部加组织者行

在地点那行（`<view class="info-line" wx:if="{{detail.location}}" ...>📍 ...</view>`，~13）之后插入：
```xml
    <view class="info-line" wx:if="{{detail.organizer}}">👤 {{detail.organizer}}</view>
```

### Step 2: `index.wxml` —— 卡片加组织者行

在卡片地点块（`<view wx:if="{{item.location}}" ...>📍 ...</view>`，~26-28）之后插入：
```xml
      <view wx:if="{{item.organizer}}" style="margin-top:8rpx;">
        <text class="muted">👤 {{item.organizer}}</text>
      </view>
```

### Step 3: 提交

```bash
git add miniprogram/pages/detail/detail.wxml miniprogram/pages/index/index.wxml
git commit -m "feat: 详情页头部 + 首页卡片显示组织者"
```
（加 Co-Authored-By trailer）

---

## 收尾验证

- `cd server && npm test` —— 全绿（含 4 个新 organizer 用例）。
- `node --check miniprogram/pages/create/create.js` —— OK。
- 前后端字段对齐：`publicActivity` 透出 `organizer`、`/api/user/me` 下发 `defaultOrganizer`。
- 联调（真机/模拟器）：新建活动→组织者预填昵称；改成"X俱乐部"提交→详情/列表显示"X俱乐部"；再建一场→预填已是"X俱乐部"；编辑老活动改组织者→显示变，但再建新活动默认仍是上次创建用的。
- 老活动（无 organizer）→ 详情/列表不显示该行（`wx:if` 兜底）。

## 不做（YAGNI）
- 选群联动 clubId 自动填组织者。
- 组织者维度的搜索/筛选/统计。
- 编辑活动时更新默认偏好。
- 数据迁移（老活动/用户靠空值兜底，无需迁移）。
