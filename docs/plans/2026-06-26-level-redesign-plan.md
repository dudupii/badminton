# 级别体系重设计（4→6 档）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把水平从 4 档（新手/初级/中级/高级）改成 6 档（+入门/中高级）并配每档说明，参考日本站；现有级别数据全重置。

**Architecture:** 后端 `logic.js` 只更新 `LEVELS` 枚举与 `LEVEL_WEIGHT`（逻辑不动，自动支持 6 档）；前端新增 `utils/levels.js`（`LEVELS`+`LEVEL_DESC`）统一 5 处硬编码；一次性脚本全重置 `user.level` 与活动级别规则。

**Tech Stack:** Node/Express 后端（`node --test` 单测，针对 `logic.js`）；微信小程序原生 JS 前端（`node --check`）。

**Design doc:** `docs/plans/2026-06-26-level-redesign-design.md`

**⚠️ Branch:** 实施在 `feat/level-redesign`（从 `main` 切）。注意本仓库工作树当前可能在 `feat/activity-feed-relevance`（feed 功能在测），切到 `main` 再切 `feat/level-redesign` 会让工作树源码暂时变回无 feed 的状态——运行中的服务器（若在 3001 跑）不受 git 切换影响，但微信开发者工具重编译会看不到 feed 改动。实施前确认可切。

---

## Task 1: 后端 LEVELS/LEVEL_WEIGHT 改 6 档（TDD：红 → 绿）

**Files:**
- Modify: `server/src/logic.js:15`（LEVELS）、`server/src/logic.js:64-67`（LEVEL_WEIGHT + levelWeight）
- Test: `server/tests/logic.test.js`（改 3 处权重断言 + 加 2 个新测试）

**为什么有测试要先改：** 现有测试 `logic.test.js:437-438` 断言分组权重和 `=== 9`、`:457` 断言 `高级` 权重 `=== 4`。新权重下 高级=6、初级=3、中级=4，这些数字会变，必须同步更新（不是测试错，是规格变了）。

### Step 1: 改测试（让它对新规格失败）

在 `server/tests/logic.test.js`：

**(a)** 第 437、438 行——分组权重和 9 → 13：
```js
// 改前
  assert.equal(groups[0].reduce((s, x) => s + x.weight, 0), 9);
  assert.equal(groups[1].reduce((s, x) => s + x.weight, 0), 9);
// 改后
  assert.equal(groups[0].reduce((s, x) => s + x.weight, 0), 13);
  assert.equal(groups[1].reduce((s, x) => s + x.weight, 0), 13);
```
（校验：groups[0]=[a高级6,d中级4,e初级3]=13 ✓）

**(b)** 第 457 行——高级权重 4 → 6：
```js
// 改前
  assert.equal(pairs[0][0].weight, 4);
// 改后
  assert.equal(pairs[0][0].weight, 6);
```
（第 458 行 `pairs[0][1].weight, 2` 不动——空水平默认仍是 2。）

**(c)** 在「empty level defaults to weight 2」测试之后（约第 459 行后）追加两个新测试：
```js
test('levelWeight: 6 levels map to weights 1-6', () => {
  const levels = ['新手', '入门', '初级', '中级', '中高级', '高级'];
  const confirmed = levels.map((lv, i) => ({ openid: 'u' + i, level: lv }));
  const out = logic.generateGroups(confirmed, { mode: 'pairs' });
  const w = {};
  out.flat().forEach((p) => { w[p.level] = p.weight; });
  assert.equal(w['新手'], 1);
  assert.equal(w['入门'], 2);
  assert.equal(w['初级'], 3);
  assert.equal(w['中级'], 4);
  assert.equal(w['中高级'], 5);
  assert.equal(w['高级'], 6);
});

test('validateRules accepts the 2 new levels (入门 / 中高级)', async () => {
  const store = tmpStore();
  const base = { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 };
  const a = await logic.createActivity(store, { ...base, rules: { minLevel: '中高级' } }, 'org');
  assert.equal(a.rules.minLevel, '中高级');
  const b = await logic.createActivity(store, { ...base, rules: { allowedLevels: ['入门', '初级'] } }, 'org');
  assert.deepEqual(b.rules.allowedLevels, ['入门', '初级']);
});
```

### Step 2: 跑测试，确认失败

Run: `cd server && npm test`
Expected: FAIL——新权重断言（13/6）对旧 LEVEL_WEIGHT 不成立；新测试里 `中高级`/`入门` 旧枚举没有（validateRules 抛 400 / weight 落到默认）。

### Step 3: 改 `logic.js`

第 15 行：
```js
// 改前
const LEVELS = ['新手', '初级', '中级', '高级'];
// 改后
const LEVELS = ['新手', '入门', '初级', '中级', '中高级', '高级'];
```

第 64-67 行：
```js
// 改前
const LEVEL_WEIGHT = { 新手: 1, 初级: 2, 中级: 3, 高级: 4 };
function levelWeight(level) {
  return LEVEL_WEIGHT[level] || 2; // 未知水平按初级(2) 算
}
// 改后
const LEVEL_WEIGHT = { 新手: 1, 入门: 2, 初级: 3, 中级: 4, 中高级: 5, 高级: 6 };
function levelWeight(level) {
  return LEVEL_WEIGHT[level] || 2; // 未知水平按入门(2) 算
}
```

（`validateRules` / `register` / `generateGroups` / `assignOneRound` / `generateRotation` 都基于 `LEVELS.includes` 与 `levelWeight`，**不动**，自动支持 6 档。）

### Step 4: 跑全量，确认通过

Run: `cd server && npm test`
Expected: 全部 PASS（含改的 3 处 + 2 个新测试）。

### Step 5: 提交

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: 水平改 6 档（+入门/中高级）+ 权重 1-6，未知默认入门"
```
（末尾加空行 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`）

---

## Task 2: 前端 `utils/levels.js` + profile + detail（消费 util）

**Files:**
- Create: `miniprogram/utils/levels.js`
- Modify: `miniprogram/pages/profile/profile.js`（import + data.levels + levelDesc + onLevelChange + loadMe）
- Modify: `miniprogram/pages/profile/profile.wxml:23-28`（picker 下加说明）
- Modify: `miniprogram/pages/detail/detail.js`（import + data.levelOptions + onProxyLevel:375）
- Modify: `miniprogram/pages/detail/detail.wxml:48`（picker range 用 levelOptions）

### Step 1: 建 `miniprogram/utils/levels.js`

```js
// 级别体系（6 档，参考日本站）。后端 server/src/logic.js 的 LEVELS 必须与此
// 保持一致（小程序无构建，前后端各维护一份）。LEVEL_DESC 用于 picker 自评提示。
const LEVELS = ['新手', '入门', '初级', '中级', '中高级', '高级'];
const LEVEL_DESC = {
  '新手': '几乎没打过/很久没打',
  '入门': '能回轻球，短拉锯',
  '初级': '高远/吊球稳定，中长拉锯',
  '中级': '会杀球/假动作，攻守多变',
  '中高级': '有战术，能和高手抗衡',
  '高级': '接近专业',
};
module.exports = { LEVELS, LEVEL_DESC };
```

### Step 2: 改 `profile.js`

顶部 require 区（第 1-4 行附近）加：
```js
const { LEVELS, LEVEL_DESC } = require('../../utils/levels');
```
`data.levels`（第 9 行）改：
```js
// 改前
    levels: ['新手', '初级', '中级', '高级'],
// 改后
    levels: LEVELS,
```
`data` 里加一行 `levelDesc: '',`（紧挨 levels 下方）。

`loadMe`（第 30 行）把 user 和 levelDesc 一起 set：
```js
// 改前
      this.setData({ user: u });
// 改后
      this.setData({ user: u, levelDesc: LEVEL_DESC[u.level] || '' });
```

`onLevelChange`（第 85-88 行）：
```js
// 改前
  onLevelChange(e) {
    this.setData({ 'user.level': this.data.levels[e.detail.value] });
    this.saveProfile();
  },
// 改后
  onLevelChange(e) {
    const level = this.data.levels[e.detail.value];
    this.setData({ 'user.level': level, levelDesc: LEVEL_DESC[level] || '' });
    this.saveProfile();
  },
```

### Step 3: 改 `profile.wxml`（水平 picker 下方显示说明）

第 23-28 行的水平 field-row 之后、性别 field-row（第 29 行）之前，插入说明行：
```xml
    <view class="field-row">
      <view class="field-label">水平</view>
      <picker bindchange="onLevelChange" value="{{levels.indexOf(user.level)}}" range="{{levels}}">
        <view class="picker-val">{{user.level || '请选择'}}</view>
      </picker>
    </view>
    <view wx:if="{{levelDesc}}" class="muted" style="font-size:22rpx;padding:4rpx 0 8rpx 16rpx;">{{levelDesc}}</view>
```
（即在原水平 field-row 的 `</view>` 后追加那一行 `<view wx:if="{{levelDesc}}" ...>`。）

### Step 4: 改 `detail.js`

顶部 require 区加：
```js
const { LEVELS } = require('../../utils/levels');
```
`data` 里（`proxyLevel: ''` 附近，第 16 行）加：
```js
    levelOptions: LEVELS,
```
`onProxyLevel`（第 375 行）：
```js
// 改前
  onProxyLevel(e) { this.setData({ proxyLevel: ['新手','初级','中级','高级'][Number(e.detail.value)] || '' }); },
// 改后
  onProxyLevel(e) { this.setData({ proxyLevel: LEVELS[Number(e.detail.value)] || '' }); },
```

### Step 5: 改 `detail.wxml`（代理报名 picker 用 levelOptions）

第 48 行的两个内联数组改用 `levelOptions`：
```xml
<!-- 改前 -->
<picker bindchange="onProxyLevel" value="{{['新手','初级','中级','高级'].indexOf(proxyLevel)}}" range="{{['新手','初级','中级','高级']}}" style="flex:1;margin:0 6rpx;"><view class="input" style="font-size:24rpx;text-align:center;">{{proxyLevel || '水平'}}</view></picker>
<!-- 改后 -->
<picker bindchange="onProxyLevel" value="{{levelOptions.indexOf(proxyLevel)}}" range="{{levelOptions}}" style="flex:1;margin:0 6rpx;"><view class="input" style="font-size:24rpx;text-align:center;">{{proxyLevel || '水平'}}</view></picker>
```

### Step 6: 语法校验

```bash
node --check miniprogram/pages/profile/profile.js
node --check miniprogram/pages/detail/detail.js
node --check miniprogram/utils/levels.js
```
Expected: 三个都无输出（OK）。

### Step 7: 提交

```bash
git add miniprogram/utils/levels.js miniprogram/pages/profile/profile.js miniprogram/pages/profile/profile.wxml miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat: 前端 utils/levels.js 统一 6 档 + profile 显示水平说明 + detail 代理 picker"
```
（加 Co-Authored-By trailer）

---

## Task 3: 前端 create 页（levelOptions + 最低水平说明）

**Files:**
- Modify: `miniprogram/pages/create/create.js`（import + data.levelOptions:32 + ruleMinLevelDesc + onRuleMinLevelChange:202 + loadForEdit:81）
- Modify: `miniprogram/pages/create/create.wxml:113-122`（白名单 tag + 最低水平 picker 下加说明）

### Step 1: 改 `create.js`

顶部加：
```js
const { LEVELS, LEVEL_DESC } = require('../../utils/levels');
```
`data.levelOptions`（第 32 行）：
```js
// 改前
    levelOptions: ['新手', '初级', '中级', '高级'],
// 改后
    levelOptions: LEVELS,
```
`data` 里加 `ruleMinLevelDesc: '',`（ruleMinLevel 附近，第 36 行下方）。

`loadForEdit`（第 81 行）回填 minLevel 时同步说明：
```js
// 改前
        ruleMinLevel: a.rules.minLevel || '中级',
// 改后
        ruleMinLevel: a.rules.minLevel || '中级',
        ruleMinLevelDesc: LEVEL_DESC[a.rules.minLevel || '中级'] || '',
```

`onRuleMinLevelChange`（第 202-204 行）：
```js
// 改前
  onRuleMinLevelChange(e) {
    this.setData({ ruleMinLevel: this.data.levelOptions[e.detail.value] });
  },
// 改后
  onRuleMinLevelChange(e) {
    const lv = this.data.levelOptions[e.detail.value];
    this.setData({ ruleMinLevel: lv, ruleMinLevelDesc: LEVEL_DESC[lv] || '' });
  },
```

### Step 2: 改 `create.wxml`（最低水平 picker 下显示说明）

第 117-122 行的 `ruleLevelMode==='min'` 块，在 picker 行后加说明：
```xml
      <view wx:if="{{ruleLevelMode==='min'}}" class="row" style="margin-top:12rpx;align-items:center;">
        <text class="muted" style="width:160rpx;">最低水平</text>
        <picker bindchange="onRuleMinLevelChange" value="{{levelOptions.indexOf(ruleMinLevel)}}" range="{{levelOptions}}">
          <view class="input" style="flex:1;">{{ruleMinLevel}}</view>
        </picker>
      </view>
      <view wx:if="{{ruleLevelMode==='min' && ruleMinLevelDesc}}" class="muted" style="margin-top:6rpx;font-size:22rpx;">{{ruleMinLevelDesc}} 及以上可报名</view>
```
（白名单 tag 块第 113-116 行不动——tag 只显示名称，保持紧凑。）

### Step 3: 语法校验

```bash
node --check miniprogram/pages/create/create.js
```
Expected: 无输出（OK）。

### Step 4: 提交

```bash
git add miniprogram/pages/create/create.js miniprogram/pages/create/create.wxml
git commit -m "feat: create 页用 utils/levels + 最低水平显示说明"
```
（加 Co-Authored-By trailer）

---

## Task 4: 迁移脚本（全重置现有级别数据）

**Files:**
- Create: `server/scripts/migrate-levels.js`

**⚠️ 关键：必须先停服务器。** `Store` 把整个 db 放内存、每次 txn 写回 `data/db.json`；若服务器在跑，迁移改了磁盘文件后，服务器下一次写会把旧内存状态覆盖回去，迁移白做。

### Step 1: 建脚本 `server/scripts/migrate-levels.js`

```js
'use strict';
// 一次性迁移：把现有级别数据全重置为「未设」（user.level=''，删除活动的
// minLevel/allowedLevels）。级别从 4 档改 6 档，旧自评在新细档下不准，决定
// 全重置让球友凭新说明重选。幂等：没有旧级别值就跳过。运行前自动备份。
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', 'data', 'db.json');
const BAK = DB + '.bak-levels';

const OLD_LEVELS = new Set(['新手', '初级', '中级', '高级']);

if (!fs.existsSync(DB)) {
  console.log('找不到 db.json，跳过');
  process.exit(0);
}

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

// 幂等检测：是否还有任何旧级别值
let dirty = false;
const users = Object.values(db.users || {});
for (const u of users) if (u.level) { dirty = true; break; }
if (!dirty) {
  for (const a of Object.values(db.activities || {})) {
    if (a.rules && (a.rules.minLevel || (a.rules.allowedLevels && a.rules.allowedLevels.length))) { dirty = true; break; }
  }
}
if (!dirty) {
  console.log('没有已设级别数据，无需迁移，跳过');
  process.exit(0);
}

// 备份
fs.writeFileSync(BAK, JSON.stringify(db, null, 2));
console.log('已备份 →', BAK);

let userCleared = 0;
for (const u of users) {
  if (u.level) { u.level = ''; userCleared++; }
}

let actCleared = 0;
for (const a of Object.values(db.activities || {})) {
  if (!a.rules) continue;
  let changed = false;
  if (a.rules.minLevel) { delete a.rules.minLevel; changed = true; }
  if (Array.isArray(a.rules.allowedLevels) && a.rules.allowedLevels.length) { delete a.rules.allowedLevels; changed = true; }
  if (changed) actCleared++;
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2));
console.log(`完成：清空 ${userCleared} 个用户水平、${actCleared} 个活动的级别规则`);
console.log('（其它规则 noShowBanDays/cancelDeadlineHours/allowedGenders 保留）');
```

### Step 2: 停服务器（如在跑）

先查：`pgrep -af "node src/index.js"`。如在跑，记下 pid 用 `kill <pid>` 停（**不要** `pkill -f 'node src/index.js'`——见 CLAUDE.md 陷阱，会连带杀 shell）。

### Step 3: 跑迁移

```bash
cd server && node scripts/migrate-levels.js
```
Expected: 打印「已备份 → ...」「完成：清空 N 个用户水平、M 个活动的级别规则」（N 约 190、M 约 4，按当前 db）。

### Step 4: 验证迁移结果

```bash
node -e "const db=JSON.parse(require('fs').readFileSync('server/data/db.json','utf8'));const us=Object.values(db.users||{}).filter(u=>u.level).length;const as=Object.values(db.activities||{}).filter(a=>a.rules&&(a.rules.minLevel||(a.rules.allowedLevels&&a.rules.allowedLevels.length))).length;console.log('仍带水平的用户:',us,'| 仍带级别规则的活动:',as)"
```
Expected: `仍带水平的用户: 0 | 仍带级别规则的活动: 0`。
确认 `data/db.json.bak-levels` 存在（备份）。

### Step 5: 重启服务器（可选，联调用）

```bash
PORT=3001 npm start   # 后台跑，供前端联调
```

### Step 6: 提交（只提交脚本，**不提交** db.json/db.bak——它们是运行时数据）

先确认 `.gitignore` 忽略 `data/`（应已忽略）；只 `git add` 脚本：
```bash
git add server/scripts/migrate-levels.js
git commit -m "feat: 一次性迁移脚本——级别全重置（user.level 清空 + 活动级别规则删除）"
```
（加 Co-Authored-By trailer；用 `git status` 确认 db.json / bak 没被纳入提交）

---

## 收尾验证

- `cd server && npm test` —— 全绿（含新 6 档测试）。
- `node --check` 三个前端 js + utils/levels.js —— OK。
- 迁移后 db：用户水平 0、活动级别规则 0；备份 `db.json.bak-levels` 在。
- 前后端 LEVELS 一致：`server/src/logic.js` 的 `LEVELS` 与 `miniprogram/utils/levels.js` 的 `LEVELS` 完全相同（6 项同名同序）。
- 真机/模拟器联调：profile 选水平浮出说明；create 最低水平显示说明；detail 代理 picker 6 项。

## 不做（YAGNI）
- 后端 `GET /api/meta/levels` 下发说明。
- 旧→新级别映射（已决定全重置）。
- 服务器启动自动迁移（一次性脚本更显式）。
- 名单徽章/白名单 tag 显示说明（只显示名称）。
