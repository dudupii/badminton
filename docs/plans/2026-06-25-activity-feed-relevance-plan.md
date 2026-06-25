# 活动一览「相关性 feed」Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 首页一览默认只显示「与我相关的 + 今天及以后」的活动降噪，并保留「全部」入口；相关为空时自动回退全部，避免新用户空白。

**Architecture:** 后端在 `src/logic.js` 新增纯函数 `listFeed(store, openid, {mode, now})`，用现成的 `registrations`+`clubs` 算相关集 + 时间窗，复用 `enrichActivity`，不新增表/字段；`src/index.js` 加一个 `requireAuth` 路由 `GET /api/activities/feed`。现有 `GET /api/activities`（clubs 页在用）零改动。前端 `pages/index` 加分段切换 + 空态回退。

**Tech Stack:** Node/Express 后端（`node --test` 单测，针对 `logic.js`）；微信小程序原生 JS 前端（`node --check` 语法校验 + HTTP 实证）。

**Design doc:** `docs/plans/2026-06-25-activity-feed-relevance-design.md`

---

## Task 1: 后端 `listFeed` 函数（TDD：红 → 绿）

**Files:**
- Modify: `server/src/logic.js`（在 `listActivities` 之后、`getActivity` 之前，约 line 449 后插入新函数；在 `module.exports` 里加导出）
- Test: `server/tests/logic.test.js`（文件末尾追加 3 个 `test(...)`）

**关键约定（写测试前先看）：**
- `createActivity(store, input, creatorOpenid, now)`——`input.startTime` 可以传**毫秒数**（`toMs` 接受 number）；`input.clubId` 可选。
- `register(store, activityId, openid, now)`、`cancel(store, activityId, openid, now)`——第 4 参 `now` 可注入。
- `createClub(store, creatorOpenid, {name})` 返回 `{id,name,code,...}`；`joinClub(store, openid, code)` 加成员。
- 时间用固定的 `Date.parse('2026-06-25T13:00:00')` 等，全程不依赖真实时钟。

### Step 1: 写失败的测试

在 `server/tests/logic.test.js` 末尾追加：

```js
test('feed: relevant = mine ∪ my clubs ∪ organizers I registered with', async () => {
  const store = tmpStore();
  const now = Date.parse('2026-06-25T13:00:00');
  const today = Date.parse('2026-06-25T18:00:00'); // 今天未来

  const mine = await logic.createActivity(store, { title: '我建的', startTime: today, capacity: 8 }, 'me', now);

  // 我的群
  const club = await logic.createClub(store, 'someone', { name: '球友群' });
  await logic.joinClub(store, 'me', club.code);
  const inClub = await logic.createActivity(store, { title: '群里的', startTime: today, capacity: 8, clubId: club.id }, 'someone', now);

  // 报名 orgX 的一场 → orgX 进相关集；orgX 的另一场（没报名）也应出现
  const orgXold = await logic.createActivity(store, { title: 'orgX 老', startTime: today, capacity: 8 }, 'orgX', now);
  await logic.register(store, orgXold.id, 'me', now);
  const orgXnew = await logic.createActivity(store, { title: 'orgX 新', startTime: today, capacity: 8 }, 'orgX', now);

  // 陌生组织者 orgY，非我的群
  const stranger = await logic.createActivity(store, { title: '陌生', startTime: today, capacity: 8 }, 'orgY', now);

  const rel = await logic.listFeed(store, 'me', { mode: 'relevant', now });
  const relIds = rel.map((a) => a.id);
  assert.ok(relIds.includes(mine.id), 'includes mine');
  assert.ok(relIds.includes(inClub.id), 'includes my club');
  assert.ok(relIds.includes(orgXnew.id), 'includes organizer I registered with');
  assert.ok(!relIds.includes(stranger.id), 'excludes stranger');

  const allIds = (await logic.listFeed(store, 'me', { mode: 'all', now })).map((a) => a.id);
  assert.ok(allIds.includes(stranger.id), 'mode=all includes stranger');
});

test('feed: time window is start-of-today and future (both modes)', async () => {
  const store = tmpStore();
  const now = Date.parse('2026-06-25T13:00:00');
  const aMid = await logic.createActivity(store, { title: '今天0点', startTime: Date.parse('2026-06-25T00:00:00'), capacity: 8 }, 'me', now);
  const aStarted = await logic.createActivity(store, { title: '今天已开始', startTime: Date.parse('2026-06-25T08:00:00'), capacity: 8 }, 'me', now);
  const aFuture = await logic.createActivity(store, { title: '今天未来', startTime: Date.parse('2026-06-25T18:00:00'), capacity: 8 }, 'me', now);
  const aYest = await logic.createActivity(store, { title: '昨天', startTime: Date.parse('2026-06-24T18:00:00'), capacity: 8 }, 'me', now);

  const relIds = (await logic.listFeed(store, 'me', { mode: 'relevant', now })).map((a) => a.id);
  assert.ok(relIds.includes(aMid.id), 'includes start-of-today boundary (inclusive)');
  assert.ok(relIds.includes(aStarted.id));
  assert.ok(relIds.includes(aFuture.id));
  assert.ok(!relIds.includes(aYest.id), 'excludes yesterday');

  const allIds = (await logic.listFeed(store, 'me', { mode: 'all', now })).map((a) => a.id);
  assert.ok(!allIds.includes(aYest.id), 'mode=all also excludes yesterday');
  assert.equal(allIds.length, 3);
});

test('feed: cancelled registration does not make organizer relevant', async () => {
  const store = tmpStore();
  const now = Date.parse('2026-06-25T13:00:00');
  const today = Date.parse('2026-06-25T18:00:00');

  const orgZold = await logic.createActivity(store, { title: 'orgZ 老', startTime: today, capacity: 8 }, 'orgZ', now);
  await logic.register(store, orgZold.id, 'me', now);
  await logic.cancel(store, orgZold.id, 'me', now + 1000);
  const orgZnew = await logic.createActivity(store, { title: 'orgZ 新', startTime: today, capacity: 8 }, 'orgZ', now);

  const relIds = (await logic.listFeed(store, 'me', { mode: 'relevant', now })).map((a) => a.id);
  assert.ok(!relIds.includes(orgZnew.id), 'cancelled organizer not relevant');
  assert.ok(!relIds.includes(orgZold.id));

  const allIds = (await logic.listFeed(store, 'me', { mode: 'all', now })).map((a) => a.id);
  assert.ok(allIds.includes(orgZnew.id), 'mode=all still shows it');
});
```

### Step 2: 跑测试，确认失败

Run: `cd server && node --test --test-name-pattern="feed:" tests/logic.test.js`
Expected: FAIL——`logic.listFeed is not a function`（还没实现/没导出）。

### Step 3: 实现 `listFeed`

在 `server/src/logic.js` 的 `listActivities` 函数（line 442–449）之后、`getActivity`（line 451）之前插入：

```js
// Relevance feed for the home screen: "today or future" activities that are
// mine, in my clubs, or by an organizer I've registered with. mode='all' drops
// the relevance filter but keeps the time window. `now` is injectable for tests.
async function listFeed(store, openid, { mode = 'relevant', now = Date.now() } = {}) {
  const state = store.snapshot();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = startOfToday.getTime();

  const myClubIds = new Set(
    Object.values(state.clubs).filter((c) => c.members.includes(openid)).map((c) => c.id)
  );
  const myRegOrgs = new Set(
    state.registrations
      .filter((r) => r.openid === openid && r.status !== 'cancelled') // 报过名就算（取消不算）
      .map((r) => state.activities[r.activityId] && state.activities[r.activityId].createdBy)
      .filter(Boolean)
  );

  const isRelevant = (a) =>
    a.createdBy === openid || myClubIds.has(a.clubId) || myRegOrgs.has(a.createdBy);
  const isTodayOrFuture = (a) => a.startTime >= cutoff;

  return Object.values(state.activities)
    .filter(isTodayOrFuture)
    .filter((a) => (mode === 'all' ? true : isRelevant(a)))
    .map((a) => enrichActivity(state, a))
    .sort((a, b) => a.startTime - b.startTime);
}
```

在 `module.exports = { ... }`（line 1152 起）里，`listActivities,` 这一行下面加一行 `listFeed,`。

### Step 4: 跑测试，确认通过

Run: `cd server && node --test --test-name-pattern="feed:" tests/logic.test.js`
Expected: PASS（3 个 feed 用例全过）。

再跑全量确认没破坏别的：
Run: `cd server && npm test`
Expected: 全部 PASS。

### Step 5: 提交

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: listFeed 相关性 feed（我创建的/我的群/报过名组织者的 + 今天及以后）"
```

---

## Task 2: HTTP 路由 `GET /api/activities/feed`

**Files:**
- Modify: `server/src/index.js`（在 `GET /api/activities/created-by/me` 路由之后、`GET /api/activities/:id` **之前**插入——具体路由必须排在 `:id` 之前，否则 `feed` 会被当成 `:id`）

**注意：** 本项目 HTTP 层没有单测（CLAUDE.md：「测试是针对 logic.js 的单元级」）。路由靠 curl 实证。

### Step 1: 加路由

在 `server/src/index.js` 找到 `GET /api/activities/created-by/me` 那段（约 line 157–161），在它之后、`GET /api/activities/:id`（约 line 163）之前插入：

```js
app.get(
  '/api/activities/feed',
  requireAuth,
  wrap(async (req) => {
    const mode = req.query && req.query.mode === 'all' ? 'all' : 'relevant';
    return logic.listFeed(store, req.user.openid, { mode });
  })
);
```

### Step 2: 启动服务 + curl 实证

确保 devMode（`.env` 里没有 `WX_APPID`/`WX_SECRET`，或直接没 `.env`）。后台起服务：
```bash
cd server && npm start
```
（停服务用它的任务句柄或 `kill <pid>`；**别用 `pkill -f 'node src/index.js'`**——见 CLAUDE.md 陷阱。）

无 token 应被拦：
```bash
curl -s -o /dev/null -w "%{http_code}\n" "localhost:3000/api/activities/feed"
```
Expected: `401`

拿 dev token 再拉（应 200 + 数组）：
```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"devUserId":"me"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).data.token))")
curl -s "localhost:3000/api/activities/feed?mode=relevant" -H "Authorization: Bearer $TOKEN"
curl -s "localhost:3000/api/activities/feed?mode=all" -H "Authorization: Bearer $TOKEN"
```
Expected: 两条都返回 `{"ok":true,"data":[...]}`（空库时 `data: []`，不报错）。

顺手回归：现有列表端点没动——
```bash
curl -s "localhost:3000/api/activities" | head -c 200
```
Expected: 仍正常返回（证明没误伤 clubs 页用的端点）。

### Step 3: 提交

```bash
git add server/src/index.js
git commit -m "feat: GET /api/activities/feed 路由（requireAuth，mode=relevant|all）"
```

---

## Task 3: 前端首页加分段切换 + 空态回退

**Files:**
- Modify: `miniprogram/pages/index/index.js`
- Modify: `miniprogram/pages/index/index.wxml`
- Modify: `miniprogram/pages/index/index.wxss`

前端无自动测试，靠 `node --check` + 真机/HTTP 联调。

### Step 1: 改 `index.js`

把整个文件替换为（在现有基础上：`data` 加 `feedMode`/`fellBack`，新增 `switchFeed`，`load` 改走 feed + 回退）：

```js
const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    activities: [],
    loading: true,
    feedMode: 'relevant', // 'relevant' | 'all'
    fellBack: false,      // relevant 为空 → 正在显示 all
  },

  async onShow() {
    try {
      await ensureLogin();
    } catch (e) {
      wx.showToast({ title: '登录失败：' + e.message, icon: 'none' });
    }
    await this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async switchFeed(e) {
    const feedMode = e.currentTarget.dataset.mode;
    if (feedMode === this.data.feedMode) return;
    this.setData({ feedMode, fellBack: false });
    await this.load();
  },

  async load() {
    try {
      this.setData({ loading: true });
      let list = await request('GET', '/api/activities/feed?mode=' + this.data.feedMode);
      let fellBack = false;
      // 相关为空 → 自动回退全部，避免新用户/冷启动空白。
      if (this.data.feedMode === 'relevant' && list.length === 0) {
        list = await request('GET', '/api/activities/feed?mode=all');
        fellBack = list.length > 0;
      }
      const now = Date.now();
      const activities = list
        .map((a) => ({
          ...a,
          timeText: fmt.friendlyTime(a.startTime),
          fillText: a.confirmedCount + '/' + a.capacity,
          isFull: a.confirmedCount >= a.capacity,
          isPast: a.startTime && a.startTime < now,
        }))
        .sort((x, y) => {
          // 即将开始优先（最早最前），已结束沉底。
          if (x.isPast !== y.isPast) return x.isPast ? 1 : -1;
          return x.isPast ? y.startTime - x.startTime : x.startTime - y.startTime;
        });
      this.setData({ activities, loading: false, fellBack });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  },
});
```

### Step 2: 改 `index.wxml`

在 `<view class="container">` 内、`<block wx:if="{{activities.length}}">` **之前**加分段切换 + 回退提示：

```xml
<view class="container">
  <view class="feed-tabs">
    <view class="feed-tab {{feedMode === 'relevant' ? 'on' : ''}}" data-mode="relevant" bindtap="switchFeed">我相关的</view>
    <view class="feed-tab {{feedMode === 'all' ? 'on' : ''}}" data-mode="all" bindtap="switchFeed">全部</view>
  </view>
  <view wx:if="{{fellBack}}" class="feed-note">暂时没有与你相关的活动，以下是全部即将开始的</view>

  <block wx:if="{{activities.length}}">
    <!-- …既有的 card 列表原样不动… -->
```

（`</view>` 收尾、`<view class="fab">` 不变。）

### Step 3: 改 `index.wxss`

在文件末尾追加：

```css
.feed-tabs {
  display: flex;
  gap: 16rpx;
  margin-bottom: 24rpx;
}
.feed-tab {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  border-radius: 12rpx;
  background: #f1f5f9;
  color: #64748b;
  font-size: 28rpx;
}
.feed-tab.on {
  background: #16a34a;
  color: #fff;
  font-weight: 600;
}
.feed-note {
  font-size: 24rpx;
  color: #94a3b8;
  margin-bottom: 20rpx;
}
```

### Step 4: 语法校验

```bash
node --check miniprogram/pages/index/index.js
```
Expected: 无输出（语法 OK）。

### Step 5: 联调（真机或开发者工具）

- 后端在跑的情况下，用微信开发者工具打开仓库根目录，进首页。
- 默认「我相关的」：用 devMode 单设备（= 一个 openid）看自己的活动；多人场景用 `curl` 以不同 `devUserId` 报名造数据。
- 切「全部」、下拉刷新、相关为空时看回退提示与新用户看到全部即将开始的活动。
- ⚠️ Linux 开发者工具的 `<picker>` 滚轮在 Wayland 下不滚动（CLAUDE.md 陷阱）——本改动没用 picker，但若联调时碰到别的 picker 异常属此已知问题。

### Step 6: 提交

```bash
git add miniprogram/pages/index/index.js miniprogram/pages/index/index.wxml miniprogram/pages/index/index.wxss
git commit -m "feat: 首页加分段切换（我相关的/全部）+ 相关为空回退全部"
```

---

## 收尾验证

- `cd server && npm test` —— 全绿（含新增 3 个 feed 用例）。
- `node --check miniprogram/pages/index/index.js` —— OK。
- curl：`/api/activities/feed` 401 无 token / 200 带 token；`/api/activities` 仍正常（未误伤 clubs 页）。
- 真机联调：相关筛选、时间窗（今天及以后）、空态回退、切换、下拉刷新。

## 不做（YAGNI，超出本计划）
- 按 `endTime` 判「进行中」、feed 含历史、前端传时区、分页、改 `/api/activities` 或 clubs 页。
