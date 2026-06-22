# 轮转赛制选项（男双/女双/混双）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给轮转加「赛制」选项（不限/男双/女双/混双，缺省不限）。选了某赛制后每轮尽量组 1 场该赛制的场地（按当轮上场者性别够不够），公平/不连休完全不动。

**Architecture:** 后端纯函数 `generateRotation`/`assignRotationCourts` 加 `matchFormat` 参数；新增 `extractFormatCourt` 抽赛制场；`setRotation` 给池加 `gender` + 存 `rotation.matchFormat`。前端轮转卡加赛制 picker。

**Tech Stack:** Node 18+ / Express / node:test（后端）；微信小程序原生 JS（前端）。

**Branch:** 在当前 `feat/phase1-organizer-features` 上继续。

**参考：** 设计 `docs/plans/2026-06-21-match-format-design.md`。

**实现顺序：** Task 1 后端算法（TDD）→ Task 2 持久化+池gender → Task 3 前端 → Task 4 收尾。

---

## Task 1: 后端 — assignRotationCourts 加 matchFormat（赛制场）

**Files:** `server/src/logic.js`（新增 `extractFormatCourt`；`assignRotationCourts` 加 `matchFormat` 参数 + 递归抽赛制场；`generateRotation` 传 `matchFormat`），`server/tests/logic.test.js`。

### Step 1: 写失败测试（插在 token 测试前）

```js
test('generateRotation: matchFormat forms one format-court when enough of the gender', () => {
  const mk = (id, g, lv) => ({ openid: id, nickname: id, gender: g, level: lv });
  // 8 men + 8 women, 4 courts (16 play = everyone), 1 round
  const ps = [];
  for (let i = 0; i < 8; i++) ps.push(mk('m' + i, '男', ['高级', '中级', '初级', '新手'][i % 4]));
  for (let i = 0; i < 8; i++) ps.push(mk('f' + i, '女', ['高级', '中级', '初级', '新手'][i % 4]));

  const womens = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'womens' });
  assert.equal(womens.schedule[0][0].filter((p) => p.gender === '女').length, 4, 'womens court[0] all women');

  const mens = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'mens' });
  assert.equal(mens.schedule[0][0].filter((p) => p.gender === '男').length, 4, 'mens court[0] all men');

  const mixed = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'mixed' });
  const c0 = mixed.schedule[0][0];
  assert.equal(c0.filter((p) => p.gender === '男').length, 2, 'mixed court[0] 2 men');
  assert.equal(c0.filter((p) => p.gender === '女').length, 2, 'mixed court[0] 2 women');

  // 'any' (default) → no format constraint (court[0] not forced to a gender)
  const anyR = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(anyR.schedule[0][0].length, 4); // still 4, just not gender-constrained
});

test('generateRotation: matchFormat falls back to level-based when gender insufficient', () => {
  const mk = (id, g) => ({ openid: id, nickname: id, gender: g, level: '中级' });
  // 6 men + 2 women, 2 courts (8 play = everyone). womens needs 4 women ⇒ can't form ⇒ fallback.
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(mk('m' + i, '男'));
  for (let i = 0; i < 2; i++) ps.push(mk('f' + i, '女'));
  const r = logic.generateRotation(ps, { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'womens' });
  assert.equal(r.schedule[0].length, 2); // 2 courts
  r.schedule[0].forEach((c) => assert.equal(c.length, 4)); // 4 each
  // no all-women court exists (only 2 women total) ⇒ proves format didn't force
  r.schedule[0].forEach((c) => assert.ok(c.some((p) => p.gender === '男'), 'each court has a man (no forced womens court)'));
});
```

### Step 2: 跑测试确认失败 — `cd server && npm test 2>&1 | grep matchFormat` → FAIL（court[0] 不是全女/全男）。

### Step 3: 实现 — 在 `server/src/logic.js` 的 `assignRotationCourts` 之前加 `extractFormatCourt`，并改 `assignRotationCourts` + `generateRotation`：

加纯函数（`assignRotationCourts` 之前）：
```js
// Try to pull one format-court (4 players) out of the playing set by gender.
// Returns [courtOf4, rest] or null when the playing set lacks enough of the gender.
function extractFormatCourt(players, matchFormat) {
  const men = players
    .filter((p) => p.gender === '男')
    .sort((a, b) => levelWeight(b.level) - levelWeight(a.level));
  const women = players
    .filter((p) => p.gender === '女')
    .sort((a, b) => levelWeight(b.level) - levelWeight(a.level));
  let take = null;
  if (matchFormat === 'mens' && men.length >= 4) take = men.slice(0, 4);
  else if (matchFormat === 'womens' && women.length >= 4) take = women.slice(0, 4);
  else if (matchFormat === 'mixed' && men.length >= 2 && women.length >= 2)
    take = men.slice(0, 2).concat(women.slice(0, 2));
  if (!take) return null;
  const takeSet = new Set(take.map((p) => p.openid));
  const rest = players.filter((p) => !takeSet.has(p.openid));
  return [take, rest];
}
```

把 `assignRotationCourts` 签名加 `matchFormat`，并在最前面加赛制场抽取（其余递归用 `'any'`，保证只组 1 场赛制场）：
```js
function assignRotationCourts(players, courts, levelMode, fixedPairs, matchFormat) {
  if (matchFormat && matchFormat !== 'any') {
    const fmt = extractFormatCourt(players, matchFormat);
    if (fmt) {
      const [fmtCourt, rest] = fmt;
      const others = assignRotationCourts(rest, courts - 1, levelMode, fixedPairs, 'any');
      return [fmtCourt, ...others];
    }
  }
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
```

在 `generateRotation` 里，把传给 `assignRotationCourts` 的调用加上 `params.matchFormat`：
```js
    schedule.push(assignRotationCourts(playing, C, levelMode, fixedPairs, params.matchFormat));
```

### Step 4: 跑测试确认通过 — `cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"` → PASS（+2 用例）。既有用例不受影响（它们的 generateRotation 调用没传 matchFormat → `params.matchFormat` undefined → falsy → 走原分支）。

### Step 5: 提交
```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: rotation matchFormat (mens/womens/mixed) — best-effort one format-court

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 后端 — rotation.matchFormat 持久化 + 池带 gender

**Files:** `server/src/logic.js`（`setRotation`：池 entry 加 `gender`；存 `rotation.matchFormat`），`server/tests/logic.test.js`。

### Step 1: 写失败测试（改既有 setRotation 测试或新增；插在 token 测试前）

```js
test('setRotation persists matchFormat + pool carries gender', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  for (let i = 0; i < 16; i++) {
    await logic.register(store, act.id, 'u' + i, 1000 + i);
    await logic.updateProfile(store, 'u' + i, { gender: i % 2 === 0 ? '男' : '女', level: '中级' });
  }
  const r = await logic.setRotation(store, act.id, 'org', { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'womens' });
  assert.equal(r.rotation.matchFormat, 'womens');
  // schedule entries carry gender so format logic worked
  const c0 = r.rotation.schedule[0][0];
  assert.equal(c0.filter((p) => p.gender === '女').length, 4, 'womens court formed from persisted pool');
  // default matchFormat when omitted
  const r2 = await logic.setRotation(store, act.id, 'org', { courts: 4, rounds: 1, levelMode: 'homogeneous' });
  assert.equal(r2.rotation.matchFormat, 'any');
});
```

### Step 2: 跑测试确认失败 — `cd server && npm test 2>&1 | grep "persists matchFormat"` → FAIL。

### Step 3: 实现 — 在 `setRotation`（`server/src/logic.js`）里：

(a) confirmed 的 entry 加 `gender`：
```js
      confirmed.push({ reg: r, entry: { openid: r.openid, nickname: u.nickname, level: u.level || '', gender: u.gender || '' } });
```

(b) `a.rotation` 对象加 `matchFormat`：
```js
    a.rotation = {
      courts: Number(params.courts) || 1,
      rounds: Number(params.rounds) || 1,
      levelMode: params.levelMode === 'balanced' ? 'balanced' : 'homogeneous',
      matchFormat: ['mens', 'womens', 'mixed'].includes(params.matchFormat) ? params.matchFormat : 'any',
      fixedPairs: Array.isArray(params.fixedPairs) ? params.fixedPairs : [],
      schedule,
      resting,
      generatedAt: Date.now(),
    };
```

### Step 4: 跑测试确认通过 — `cd server && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"` → PASS。

### Step 5: 提交
```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: persist rotation.matchFormat + carry gender in pool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: 前端 — 轮转卡加「赛制」picker

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（无单测；`node --check`。）

### Step 1: detail.js

`data` 加：
```js
    rotMatchFormat: 'any', // any|mens|womens|mixed
```

加方法（放 `onRotLevelMode` 附近）：
```js
  onRotMatchFormat(e) {
    this.setData({ rotMatchFormat: ['any', 'mens', 'womens', 'mixed'][Number(e.detail.value)] || 'any' });
  },
```

`genRotation` 的 POST body 加 `matchFormat: d.rotMatchFormat`：
```js
      const r = await request('POST', '/api/activities/' + d.id + '/rotation', {
        courts: d.rotCourts,
        rounds: d.rotRounds,
        levelMode: d.rotLevelMode,
        matchFormat: d.rotMatchFormat,
        fixedPairs: d.rotFixed,
      });
```

### Step 2: detail.wxml — 在轮转块的「水平」picker 后面加「赛制」picker：

```xml
      <view class="row" style="margin-top:12rpx;align-items:center;">
        <text class="muted" style="width:140rpx;">赛制</text>
        <picker bindchange="onRotMatchFormat" value="{{rotMatchFormat==='mens'?1:rotMatchFormat==='womens'?2:rotMatchFormat==='mixed'?3:0}}" range="{{['不限','男双','女双','混双']}}">
          <view class="input" style="flex:1;">{{rotMatchFormat==='mens'?'男双':rotMatchFormat==='womens'?'女双':rotMatchFormat==='mixed'?'混双':'不限'}}</view>
        </picker>
      </view>
```

### Step 3: 语法自检 + 提交
```bash
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): rotation match-format picker (mens/womens/mixed)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 收尾 — 验证 + 文档

### Step 1: 后端全测 — `cd server && npm test` → 全过。
### Step 2: 前端语法扫描 — `for f in miniprogram/pages/*/*.js miniprogram/utils/*.js; do node --check "$f" || echo "FAIL $f"; done`
### Step 3: HTTP 实证（curl）：以创建者 POST `matchFormat:'womens'`（用已有 14/20 人活动），确认 court[0] 全女（当轮够女时）；GET 读回 `rotation.matchFormat='womens'`。
### Step 4: 更新 README/CLAUDE.md
- README 轮转一行补：可选赛制（男双/女双/混双，尽量 1 场）。
- CLAUDE.md Phase 5 要点补：`matchFormat`（assignRotationCourts 抽赛制场、选人/公平不动、缺省 any）。
### Step 5: 提交
```bash
git add CLAUDE.md README.md
git commit -m "docs: rotation matchFormat option in README/CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 风险与备注

- 赛制场为"尽量 1 场"：当轮上场者该性别不够（男双<4男/女双<4女/混双<2男或2女）→ 该轮无赛制场，全部按水平分（退回现行为）。
- 赛制只作用于分场，**选人/公平/不连休完全不变**。
- 固定搭档仍只对其余场地生效（赛制场按性别抽，搭档若同性别且都被抽进则自然同场，不强行）。
- 池 entry 现带 `gender`（Task 2），供 extractFormatCourt 用。
- 向后兼容：既有 `rotation`（无 matchFormat）按 `'any'`；既有 generateRotation 调用不传 matchFormat → undefined → falsy → 原分支。
