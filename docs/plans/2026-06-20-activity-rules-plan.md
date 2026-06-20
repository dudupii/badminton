# 活动报名规则（缺席惩罚 + 级别限制）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给活动加两条可选报名规则（缺省都不启用）：缺席惩罚（no-show 后 N 天内禁报该组织者活动）、级别限制（仅指定水平子集可报，空水平拦截）。报名时即时校验。

**Architecture:** 后端 `logic.js` 加纯函数 `validateRules` + `publicActivity` 透出 `rules`；`createActivity`/`updateActivity` 接受可选 `rules`；`register()` 在创建报名记录前现场查两条规则（不持久化惩罚态）。无新端点、无新核心实体。TDD。

**Tech Stack:** Node 18+ / Express / node:test（后端）；微信小程序原生 JS（前端）。

**Branch:** 在当前 `feat/phase1-organizer-features` 上继续。

**参考：** 设计 `docs/plans/2026-06-20-activity-rules-design.md`；约定见 `CLAUDE.md`。

**实现顺序：** Task 1–3 后端 TDD，4 前端，5 收尾。每 Task 提交。

---

## Task 1: 后端 — rules 字段（validateRules + create/update + publicActivity）

**Files:** `server/src/logic.js`（加 `validateRules`；`createActivity`/`updateActivity` 接受 `rules`；`publicActivity` 透出），`server/tests/logic.test.js`。

### Step 1: 写失败测试（插在 `test('token sign/verify...` 前）

```js
test('createActivity/updateActivity accept optional rules; validateRules', async () => {
  const store = tmpStore();
  const a = await logic.createActivity(
    store,
    { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { noShowBanDays: 7, allowedLevels: ['新手', '初级'] } },
    'org'
  );
  assert.equal(a.rules.noShowBanDays, 7);
  assert.deepEqual(a.rules.allowedLevels, ['新手', '初级']);
  // no rules → null
  const b = await logic.createActivity(store, { title: 'T2', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  assert.equal(b.rules, null);
  // invalid noShowBanDays (must be positive int)
  await withError(400, logic.createActivity(store, { title: 'X', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { noShowBanDays: 0 } }, 'org'));
  // invalid level
  await withError(400, logic.createActivity(store, { title: 'X', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { allowedLevels: ['大神'] } }, 'org'));
  // empty allowedLevels = off
  const c = await logic.createActivity(store, { title: 'Y', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { allowedLevels: [] } }, 'org');
  assert.equal(c.rules, null);
  // update changes rules
  const u = await logic.updateActivity(store, a.id, 'org', { rules: { noShowBanDays: 3 } });
  assert.equal(u.rules.noShowBanDays, 3);
  assert.equal(u.rules.allowedLevels, undefined);
  // update clears rules with null
  const u2 = await logic.updateActivity(store, a.id, 'org', { rules: null });
  assert.equal(u2.rules, null);
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep "accept optional rules"
```
Expected: FAIL（`a.rules` undefined）。

### Step 3: 实现

在 `server/src/logic.js` 顶部 `GENDERS` 常量附近加纯函数：

```js
// Normalize + validate an optional activity-rules input. Returns
// { noShowBanDays?, allowedLevels? } or null when no rule is active.
// noShowBanDays: positive integer (days). allowedLevels: non-empty LEVELS subset.
function validateRules(input) {
  if (input == null) return null;
  const out = {};
  if (input.noShowBanDays != null && input.noShowBanDays !== '') {
    const n = Number(input.noShowBanDays);
    if (!Number.isInteger(n) || n < 1) throw httpError(400, '缺席禁报天数需为正整数');
    out.noShowBanDays = n;
  }
  if (Array.isArray(input.allowedLevels) && input.allowedLevels.length) {
    if (!input.allowedLevels.every((l) => LEVELS.includes(l))) {
      throw httpError(400, '级别限制含非法水平');
    }
    out.allowedLevels = input.allowedLevels;
  }
  if (!out.noShowBanDays && !out.allowedLevels) return null; // nothing active
  return out;
}
```

在 `publicActivity(a)` 返回对象里加一行（与现有字段并列）：

```js
    rules: a.rules || null,
```

在 `createActivity` 里：在顶部其它校验之后、`return store.txn` 之前，加 `const rules = validateRules(input.rules);`；在 txn 内 activity 对象里加字段 `rules,`（与 `status: 'open'` 等并列）。

在 `updateActivity` 里：在顶部校验区加（与其它字段校验并列，无需提前算值）；在 txn 内、capacity 检查之后、各字段赋值处加：

```js
    if (input.rules !== undefined) a.rules = validateRules(input.rules);
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS（比上一任务多 1）。

### Step 5: 提交

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: activity.rules field (noShowBanDays/allowedLevels) via create+edit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 后端 — register() 级别限制

**Files:** `server/src/logic.js`（`register` 内加检查），`server/tests/logic.test.js`。

### Step 1: 写失败测试（插在 `test('token sign/verify...` 前）

```js
test('register enforces level restriction (allowedLevels)', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(
    store,
    { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { allowedLevels: ['新手', '初级'] } },
    'org'
  );
  await logic.updateProfile(store, 'u1', { level: '中级' });
  await withError(400, logic.register(store, act.id, 'u1', 1000)); // 中级 not allowed
  await logic.updateProfile(store, 'u2', { level: '初级' });
  assert.equal((await logic.register(store, act.id, 'u2', 2000)).status, 'confirmed'); // 初级 ok
  await withError(400, logic.register(store, act.id, 'u3', 3000)); // empty level blocked
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep "level restriction"
```
Expected: FAIL（中级 没被拦）。

### Step 3: 实现

在 `server/src/logic.js` 的 `register` 函数 txn 内，紧接在重复报名守卫 `if (mine) throw httpError(409, '您已报名该活动');` 之后、`const confirmedCount = ...` 之前，插入：

```js
    // --- activity rules (Phase: 报名规则) ----------------------------------
    const rules = a.rules || {};
    if (Array.isArray(rules.allowedLevels) && rules.allowedLevels.length) {
      const userLevel = (state.users[openid] || {}).level || '';
      if (!userLevel) throw httpError(400, '请先在个人资料填写水平后再报名');
      if (!rules.allowedLevels.includes(userLevel)) {
        throw httpError(400, '本活动限 ' + rules.allowedLevels.join('/') + ' 水平报名');
      }
    }
```

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS。

### Step 5: 提交

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: register enforces allowedLevels rule

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: 后端 — register() 缺席惩罚（no-show ban）

**Files:** `server/src/logic.js`（`register` 内加检查，紧接 Task 2 的级别检查之后），`server/tests/logic.test.js`。

### Step 1: 写失败测试（插在 `test('token sign/verify...` 前）

```js
test('register enforces no-show ban within window, same organizer only', async () => {
  const store = tmpStore();
  const DAY = 86400000;
  const T0 = 1_000_000_000; // past activity start
  // organizer 'org' ran a past activity; u1 no-showed
  const past = await logic.createActivity(store, { title: 'past', startTime: T0, capacity: 4 }, 'org', 100);
  await logic.register(store, past.id, 'u1', T0 - DAY); // registered before start
  await logic.markAttend(store, past.id, 'org', 'u1', false); // marked absent

  // a NEW org activity with noShowBanDays=7, start far future
  const next = await logic.createActivity(store, { title: 'next', startTime: T0 + 365 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 200);

  // register u1 at now = T0+1day → within 7-day window → BANNED
  await withError(400, logic.register(store, next.id, 'u1', T0 + 1 * DAY));
  // register u1 at now = T0+8days → outside window → OK
  assert.equal((await logic.register(store, next.id, 'u1', T0 + 8 * DAY)).status, 'confirmed');

  // cross-organizer: u2 no-showed a DIFFERENT organizer's activity → not banned from org's
  const pastOther = await logic.createActivity(store, { title: 'pastOther', startTime: T0, capacity: 4 }, 'other', 300);
  await logic.register(store, pastOther.id, 'u2', T0 - DAY);
  await logic.markAttend(store, pastOther.id, 'other', 'u2', false);
  const next2 = await logic.createActivity(store, { title: 'next2', startTime: T0 + 365 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 400);
  assert.equal((await logic.register(store, next2.id, 'u2', T0 + 1 * DAY)).status, 'confirmed'); // not banned

  // attended===null (unsigned) does NOT count as no-show
  const past2 = await logic.createActivity(store, { title: 'past2', startTime: T0, capacity: 4 }, 'org', 500);
  await logic.register(store, past2.id, 'u3', T0 - DAY); // not marked attended
  const next3 = await logic.createActivity(store, { title: 'next3', startTime: T0 + 365 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 600);
  assert.equal((await logic.register(store, next3.id, 'u3', T0 + 1 * DAY)).status, 'confirmed');
});
```

### Step 2: 跑测试确认失败

```bash
cd server && npm test 2>&1 | grep "no-show ban"
```
Expected: FAIL（u1 没被拦）。

### Step 3: 实现

在 `register` txn 内，紧接 Task 2 的级别限制检查之后（仍是 `confirmedCount` 之前），插入：

```js
    if (rules.noShowBanDays && rules.noShowBanDays > 0) {
      const cutoff = now - rules.noShowBanDays * 86400000;
      const prior = state.registrations.find((r) => {
        if (r.openid !== openid || r.attended !== false) return false;
        const pa = state.activities[r.activityId];
        return !!pa && pa.createdBy === a.createdBy && pa.startTime <= now && pa.startTime > cutoff;
      });
      if (prior) {
        const d = new Date(state.activities[prior.activityId].startTime);
        throw httpError(
          400,
          '你于 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 缺席过该组织者的活动，' + rules.noShowBanDays + ' 天内无法报名'
        );
      }
    }
```

> 注意 `now` 是 `register(store, activityId, openid, now = Date.now())` 的注入参数，直接复用做窗口计算（测试可控）。

### Step 4: 跑测试确认通过

```bash
cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: PASS（后端全部完成；既有报名/候补/上位用例不受影响——它们的活动无 `rules`）。

### Step 5: 提交

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: register enforces no-show ban rule (N days, same organizer)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 前端 — create 页「报名规则」可选区（create + edit）

**Files:** `miniprogram/pages/create/create.js`、`create.wxml`。（无单测；`node --check`。）

### Step 1: create.js

`data` 增加（与现有字段并列）：
```js
    levelOptions: ['新手', '初级', '中级', '高级'],
    ruleNoShow: false,
    ruleNoShowDays: 7,
    ruleLevel: false,
    ruleLevels: [], // 选中的水平子集
```

新增方法（放在 repeat 相关方法附近）：
```js
  toggleRuleNoShow() {
    this.setData({ ruleNoShow: !this.data.ruleNoShow });
  },
  onRuleNoShowDays(e) {
    this.setData({ ruleNoShowDays: e.detail.value }); // 自由输入
  },
  onRuleNoShowDaysBlur(e) {
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    this.setData({ ruleNoShowDays: v });
  },
  toggleRuleLevel() {
    this.setData({ ruleLevel: !this.data.ruleLevel });
  },
  toggleRuleLevelItem(e) {
    const lv = e.currentTarget.dataset.level;
    const set = this.data.ruleLevels.slice();
    const i = set.indexOf(lv);
    if (i === -1) set.push(lv);
    else set.splice(i, 1);
    this.setData({ ruleLevels: set });
  },
  // Build the rules payload (or omit) from the toggles.
  buildRules() {
    const d = this.data;
    const rules = {};
    if (d.ruleNoShow) rules.noShowBanDays = parseInt(d.ruleNoShowDays, 10) || 7;
    if (d.ruleLevel && d.ruleLevels.length) rules.allowedLevels = d.ruleLevels.slice();
    return Object.keys(rules).length ? rules : undefined;
  },
```

在 `loadForEdit(id)` 里（编辑模式回填），获取活动 `a` 后，把 `a.rules` 反向回填到这些开关：
```js
    if (a.rules) {
      this.setData({
        ruleNoShow: !!a.rules.noShowBanDays,
        ruleNoShowDays: a.rules.noShowBanDays || 7,
        ruleLevel: Array.isArray(a.rules.allowedLevels) && a.rules.allowedLevels.length > 0,
        ruleLevels: (a.rules.allowedLevels || []).slice(),
      });
    }
```

在 `submit()` 构建 `payload` 时，把规则带上（与 repeat 同级）：
```js
    const rules = this.buildRules();
    if (rules) payload.rules = rules;
```
（`payload` 在 create 和 edit 两个分支都用，所以 create 与 edit 都会带 rules。）

### Step 2: create.wxml

在「重复」picker 那块 `<view class="field" wx:if="{{!editId}}">…重复…</view>` **之后**、`</view>`（card 结束）之前，加：

```xml
    <view class="field">
      <view class="field-label">报名规则（可选）</view>
      <view class="row" style="margin-top:12rpx;align-items:center;">
        <switch checked="{{ruleNoShow}}" bindchange="toggleRuleNoShow" color="#16a34a"/>
        <text style="margin-left:16rpx;">缺席惩罚</text>
      </view>
      <view wx:if="{{ruleNoShow}}" class="row" style="margin-top:12rpx;align-items:center;">
        <text class="muted" style="width:160rpx;">缺席后禁报天数</text>
        <input class="input" style="flex:1;" type="number" value="{{ruleNoShowDays}}" bindinput="onRuleNoShowDays" bindblur="onRuleNoShowDaysBlur"/>
      </view>
      <view wx:if="{{ruleNoShow}}" class="muted" style="margin-top:8rpx;font-size:24rpx;">曾缺席你活动的人，这段时间内无法报名（需先在详情页签到标"缺"）</view>

      <view class="row" style="margin-top:16rpx;align-items:center;">
        <switch checked="{{ruleLevel}}" bindchange="toggleRuleLevel" color="#16a34a"/>
        <text style="margin-left:16rpx;">级别限制</text>
      </view>
      <view wx:if="{{ruleLevel}}" class="row" style="margin-top:12rpx;flex-wrap:wrap;">
        <view wx:for="{{levelOptions}}" wx:key="*this" data-level="{{item}}" bindtap="toggleRuleLevelItem"
              class="tag {{ruleLevels.indexOf(item) >= 0 ? 'tag-open' : 'tag-wait'}}" style="margin:6rpx 8rpx 0 0;">{{item}}</view>
      </view>
      <view wx:if="{{ruleLevel}}" class="muted" style="margin-top:8rpx;font-size:24rpx;">仅选中水平的球友可报名；没填水平的会被提示先去资料页填</view>
    </view>
```

> 规则区**不**加 `wx:if="{{!editId}}"`——编辑活动时也要能改规则。`.tag`/`.tag-open`/`.tag-wait`/`.row`/`.muted`/`.field`/`.field-label`/`.input` 均为全局类，复用。

### Step 3: 语法自检 + 提交

```bash
node --check miniprogram/pages/create/create.js
git add miniprogram/pages/create/create.js miniprogram/pages/create/create.wxml
git commit -m "feat(ui): optional activity rules on create/edit (no-show ban + level)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: 收尾 — 验证 + 文档

### Step 1: 后端全测

```bash
cd server && npm test
```
Expected: 全过（比 Phase 3 多 3 个用例）。

### Step 2: 前端语法扫描

```bash
for f in miniprogram/pages/*/*.js miniprogram/utils/*.js; do node --check "$f" || echo "FAIL $f"; done
```

### Step 3: 更新 README/CLAUDE.md

- README 功能清单加：**报名规则（可选）**——缺席惩罚（no-show 后 N 天禁报）、级别限制（仅指定水平，空水平拦截）。
- CLAUDE.md「这是什么」+ 架构要点补一段 Phase 4（`activity.rules = {noShowBanDays, allowedLevels}`，register 即时校验，缺席判定依赖 Phase 3 签到，空水平拦截，跨组织者不互扰）。

### Step 4: 提交

```bash
git add CLAUDE.md README.md
git commit -m "docs: activity rules (no-show ban + level restriction) in README/CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 风险与备注

- **缺席惩罚依赖签到**：组织者必须在详情页把缺席者标成 `attended=false`，规则才会触发；从不签到则无人被禁报。前端文案已提示。
- **范围 = 同一组织者**（`createdBy` 相同）。不同组织者的活动互不影响。
- **规则向前生效**：组织者现在开启，会据用户过往缺席历史拦截（不区分"开启前后"的缺席，YAGNI）。
- **即时计算**每次报名扫一次 registrations——自用规模可接受。
- **报名被拦**时，detail 页报名按钮的 toast 会显示后端返回的中文原因（既有 `catch (e) { wx.showToast({title:e.message})}` 已覆盖，无需改）。
