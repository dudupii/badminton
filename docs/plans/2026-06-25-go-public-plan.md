# 公开小程序（B 路径）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use @superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把羽毛球报名小程序从 devMode 自用推进到「个人主体正式发布 · 邀请制自助 · 人数无限」——加上发布前必须的数据备份与防滥用加固，并给出运维发布 runbook。

**Architecture:** 代码部分全部在现有 `server/`（JSON 文件 DB + `store.txn` 串行锁 + `logic.js` 纯领域层）内增量完成，遵循仓库既有 TDD 模式（`node:test` + 内存 `Store` + `tmpStore()`）。备份是 `Store` 的新方法（轮转 `.bak.N` + 启动时从 `.bak.1` 自愈）；防滥用是 `logic.js` 顶部的 `LIMITS` 常量 + 在 `createActivity`/`createClub`/`joinClub` 内加守卫。运维部分（备案/主机/Nginx/微信后台/提审）是不可自动化的人工步骤，写成 checklist。

**Tech Stack:** Node ≥18、Express、`node:test`、微信小程序原生、Nginx + Let's Encrypt + systemd。

**设计依据：** `docs/plans/2026-06-25-go-public-design.md`（类目首选「生活服务-预约/报名」、个人主体可发布、正式版无人数上限等已核实事实）。

---

## 两条提醒（执行前必读）

1. **两个 `config.js` 别搞混**：`server/src/config.js`（后端 env）vs `miniprogram/utils/config.js`（前端 `PROD_URL`）。本计划会明确指代。
2. **不在 worktree，直接在 `main` 上做**（与本仓库既有习惯一致，所有 docs/feat 都直提 main）。如想隔离可自行 `git checkout -b go-public`。

---

## Part A — 代码加固（TDD，全部在 `server/`）

### Task 1: `Store.backup()` —— 轮转备份当前内存态

**Files:**
- Modify: `server/src/store.js`（`Store` 类内新增 `backup` 方法）
- Test: `server/tests/logic.test.js`（追加）

**Step 1: 写失败测试**（追加到 `tests/logic.test.js` 末尾，最后一个 `test(...)` 之后、`module.exports` 之前——本仓库测试文件末尾无 exports，直接追加）

```js
test('backup writes .bak.1 of the current in-memory state', async () => {
  const store = tmpStore();
  await logic.createActivity(store, { title: 'first', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', 1000);
  store.backup(10);
  const bak = JSON.parse(fs.readFileSync(store.filePath + '.bak.1', 'utf8'));
  assert.equal(Object.keys(bak.activities).length, 1);
  assert.equal(Object.values(bak.activities)[0].title, 'first');
});

test('backup rotates older backups (.bak.1 -> .bak.2)', async () => {
  const store = tmpStore();
  await logic.createActivity(store, { title: 'a', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', 1000);
  store.backup(10);
  await logic.createActivity(store, { title: 'b', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', 2000);
  store.backup(10);
  const bak1 = JSON.parse(fs.readFileSync(store.filePath + '.bak.1', 'utf8'));
  const bak2 = JSON.parse(fs.readFileSync(store.filePath + '.bak.2', 'utf8'));
  assert.equal(Object.keys(bak1.activities).length, 2); // newest
  assert.equal(Object.keys(bak2.activities).length, 1); // previous
  assert.equal(Object.values(bak2.activities)[0].title, 'a');
});
```

**Step 2: 跑测试确认失败**

Run: `cd server && node --test --test-name-pattern="backup" tests/logic.test.js`
Expected: FAIL — `store.backup is not a function`

**Step 3: 实现 `backup` 方法**（在 `server/src/store.js` 的 `snapshot()` 方法之后、`Store` 类的 `}` 之前插入）

```js
  // Rotate the in-memory state into `<file>.bak.1 .. .bak.<keep>`. Newest is
  // always .bak.1. Writes a tmp file + rename (atomic). Backs up the in-memory
  // state directly so a backup is always valid JSON regardless of disk state.
  backup(keep = 10) {
    const oldest = `${this.filePath}.bak.${keep}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${this.filePath}.bak.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.bak.${i + 1}`);
    }
    const tmp = `${this.filePath}.bak.1.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, `${this.filePath}.bak.1`);
    return true;
  }
```

**Step 4: 跑测试确认通过**

Run: `cd server && node --test --test-name-pattern="backup" tests/logic.test.js`
Expected: PASS（2 tests）

**Step 5: 提交**

```bash
git add server/src/store.js server/tests/logic.test.js
git commit -m "feat: rotating db.json backups (Store.backup)"
```

---

### Task 2: 启动自愈 —— 主库损坏时从 `.bak.1` 恢复

**Files:**
- Modify: `server/src/store.js:21-34`（`_read()` 方法）
- Test: `server/tests/logic.test.js`

**动机：** 现在 `_read()` 任何解析失败都静默回空状态 = 全量数据丢失。改为先尝试 `.bak.1`。

**Step 1: 写失败测试**（追加）

```js
test('Store recovers from .bak.1 when primary db is corrupt', async () => {
  const store = tmpStore();
  await logic.createActivity(store, { title: 'survivor', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', 1000);
  store.backup(10);
  fs.writeFileSync(store.filePath, '{ NOT JSON'); // corrupt primary
  const recovered = new Store(store.filePath);
  const titles = Object.values(recovered.snapshot().activities).map((a) => a.title);
  assert.deepEqual(titles, ['survivor']);
});

test('Store starts empty when primary and backup are both unusable', async () => {
  const store = tmpStore();
  fs.writeFileSync(store.filePath, '{ NOT JSON'); // no backup exists
  const s = new Store(store.filePath);
  assert.deepEqual(s.snapshot().activities, {});
});
```

**Step 2: 跑测试确认失败**

Run: `cd server && node --test --test-name-pattern="recovers from .bak.1|both unusable" tests/logic.test.js`
Expected: FAIL — recover 测试拿到空 activities（当前 `_read` 静默回空）

**Step 3: 改写 `_read()`**（替换 `server/src/store.js` 现有 `_read()` 整个方法体）

```js
  _read() {
    const parse = (raw) => {
      const parsed = JSON.parse(raw);
      return {
        users: parsed.users || {},
        activities: parsed.activities || {},
        registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
        clubs: parsed.clubs || {},
      };
    };
    try {
      return parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (e) {
      // Primary missing/corrupt — try the newest backup before silently resetting.
      try {
        const recovered = parse(fs.readFileSync(`${this.filePath}.bak.1`, 'utf8'));
        console.error(`⚠️  ${this.filePath} 读取失败（${e.message}），已从 .bak.1 恢复。请人工检查！`);
        return recovered;
      } catch (e2) {
        console.error(`⚠️  ${this.filePath} 与 .bak.1 均不可用，以空状态启动：${e2.message}`);
        return structuredClone(DEFAULT_STATE);
      }
    }
  }
```

**Step 4: 跑全量测试确认通过**（改了核心 `_read`，跑全部）

Run: `cd server && npm test`
Expected: PASS（全部，含新 2 条）

**Step 5: 提交**

```bash
git add server/src/store.js server/tests/logic.test.js
git commit -m "feat: auto-recover db from .bak.1 on corrupt primary"
```

---

### Task 3: 备份配置 + 定时备份调度

**Files:**
- Modify: `server/src/config.js`（`config` 对象内加 `backup` 块）
- Modify: `server/src/index.js:474-482`（`require.main` 启动块）
- Modify: `server/.env.example`（加两个可选变量）

**Step 1: `config.js` 加备份配置**（在 `module.exports = config;` 之前，`config` 对象内任意位置追加，例如 `tokenSecret` 之后）

```js
  // Rotating db.json backups. Always on (useful in dev too). Tune via env.
  backup: {
    intervalMs: (Number(process.env.BACKUP_INTERVAL_SECONDS) || 3600) * 1000,
    keep: Number(process.env.BACKUP_KEEP) || 10,
  },
```

**Step 2: `index.js` 启动块挂备份 sweep**（在 `if (require.main === module) {` 块内，紧跟现有 `setInterval(reminderSweep, ...)` / `setTimeout(reminderSweep, ...)` 两行之后追加）

```js
  // Periodic rotating backup of db.json (always on, unlike the reminder sweep).
  const backup = () => {
    try {
      store.backup(config.backup.keep);
    } catch (e) {
      console.error('backup failed:', e.message);
    }
  };
  setInterval(backup, config.backup.intervalMs).unref();
  setTimeout(backup, 30000).unref(); // capture initial state shortly after boot
```

**Step 3: `.env.example` 加注释**（在文件末尾追加）

```ini

# --- Backups --------------------------------------------------------------
# Rotating db.json backups run on this interval (seconds). Default 3600 (1h).
BACKUP_INTERVAL_SECONDS=3600
# How many rotating .bak.N copies to keep. Default 10.
BACKUP_KEEP=10
```

**Step 4: 验证（语法 + 运行时冒烟）**

Run: `cd server && node --check src/index.js && node --check src/config.js`
Expected: 无输出（语法 OK）

Run: `cd server && node -e "const {app} = require('./src/index'); const {store} = require('./src/index'); console.log(typeof store.backup, require('./src/config').backup.keep)"`
Expected: `function 10`

**Step 5: 提交**

```bash
git add server/src/config.js server/src/index.js server/.env.example
git commit -m "feat: scheduled rotating db backups (config + sweep)"
```

---

### Task 4: 活动标题/描述长度上限

**Files:**
- Modify: `server/src/logic.js`（顶部加 `LIMITS` 常量 + `createActivity` 内守卫 + description 切片 + 导出 `LIMITS`）
- Test: `server/tests/logic.test.js`

**Step 1: 写失败测试**（追加）

```js
const logicLimits = require('../src/logic');
// (若文件顶部已 require logic 为 `logic`，直接复用，无需重复 require)

test('createActivity rejects an over-long title', async () => {
  const store = tmpStore();
  await withError(400, logic.createActivity(store, {
    title: 'x'.repeat(logicLimits.LIMITS.titleMax + 1),
    startTime: '2099-01-01T10:00:00',
    capacity: 1,
  }, 'org', 1000));
});

test('createActivity truncates an over-long description', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: 'ok',
    description: 'y'.repeat(logicLimits.LIMITS.descriptionMax + 50),
    startTime: '2099-01-01T10:00:00',
    capacity: 1,
  }, 'org', 1000);
  const d = await logic.getActivity(store, act.id);
  assert.equal(d.description.length, logicLimits.LIMITS.descriptionMax);
});
```

> 注：若测试文件顶部 `const logic = require('../src/logic');`，则上面 `logicLimits` 改成 `logic`，去掉第一行重复 require。

**Step 2: 跑测试确认失败**

Run: `cd server && node --test --test-name-pattern="over-long" tests/logic.test.js`
Expected: FAIL — `LIMITS` 未定义 / title 未被拦

**Step 3a: 顶部加 `LIMITS`**（`server/src/logic.js`，在 `const GENDERS = [...]`（第 16 行）之后插入）

```js
// Abuse-prevention limits (public release). Module constants so logic stays
// pure/testable; promote to env later if tuning-without-redeploy is needed.
const LIMITS = {
  titleMax: 60,
  descriptionMax: 500,
  activityWindowMs: 3600000, // 1h
  activityWindowMax: 10, // per creator per window
  clubWindowMs: 86400000, // 24h
  clubWindowMax: 20, // per user per window
  clubMemberMax: 200,
};
```

**Step 3b: `createActivity` 加标题长度守卫 + description 切片 + 速率限制**（`server/src/logic.js:384-413`）

把：
```js
  const title = (input.title || '').trim();
  if (!title) throw httpError(400, '请填写活动标题');
```
改为：
```js
  const title = (input.title || '').trim();
  if (!title) throw httpError(400, '请填写活动标题');
  if (title.length > LIMITS.titleMax) throw httpError(400, `标题过长（最多 ${LIMITS.titleMax} 字）`);
```

把 `return store.txn((state) => {` 之后、`const activity = {` 之前插入速率限制：
```js
  return store.txn((state) => {
    const recentActivities = Object.values(state.activities).filter(
      (x) => x.createdBy === creatorOpenid && x.createdAt > now - LIMITS.activityWindowMs
    ).length;
    if (recentActivities >= LIMITS.activityWindowMax) {
      throw httpError(429, '近期创建活动过多，请稍后再试');
    }
    const activity = {
```

把 `description: (input.description || '').trim(),` 改为：
```js
      description: (input.description || '').trim().slice(0, LIMITS.descriptionMax),
```

**Step 3c: 导出 `LIMITS`**（`server/src/logic.js` 末尾 `module.exports = {` 内，加一行 `LIMITS,`，建议放在 `httpError,` 旁边）

**Step 4: 跑测试确认通过**

Run: `cd server && node --test --test-name-pattern="over-long" tests/logic.test.js`
Expected: PASS

**Step 5: 提交**

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: activity title/description length caps"
```

---

### Task 5: 每创建者活动建频限流

> Task 4 已在 `createActivity` txn 内加了速率限制代码；本任务补**测试**并确认 429 行为 + 窗口外可恢复。

**Files:**
- Test: `server/tests/logic.test.js`（实现已在 Task 4 落地）

**Step 1: 写测试**（追加）

```js
test('createActivity rate-limits too many per creator within the window', async () => {
  const store = tmpStore();
  const base = 1000;
  for (let i = 0; i < logic.LIMITS.activityWindowMax; i++) {
    await logic.createActivity(store, { title: 't' + i, startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', base + i);
  }
  // next one still inside the 1h window -> 429
  await withError(429, logic.createActivity(store, { title: 'over', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', base + 10));
  // push `now` past the window -> the earliest ones age out -> allowed again
  const ok = await logic.createActivity(store, { title: 'ok', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', base + logic.LIMITS.activityWindowMs + 11);
  assert.ok(ok.id);
});

test('createActivity rate limit is per-creator (other users unaffected)', async () => {
  const store = tmpStore();
  const base = 5000;
  for (let i = 0; i < logic.LIMITS.activityWindowMax; i++) {
    await logic.createActivity(store, { title: 't' + i, startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', base + i);
  }
  // different creator under the limit -> fine
  const other = await logic.createActivity(store, { title: 'other', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org2', base);
  assert.ok(other.id);
});
```

**Step 2: 跑测试确认通过**（实现已在 Task 4 写好）

Run: `cd server && node --test --test-name-pattern="rate-limit|per-creator" tests/logic.test.js`
Expected: PASS（2 tests）。若失败，回 Task 4 检查 txn 内限流代码位置。

**Step 3: 提交**

```bash
git add server/tests/logic.test.js
git commit -m "test: per-creator activity creation rate limit"
```

---

### Task 6: 建群限频 + 群人数上限

**Files:**
- Modify: `server/src/logic.js:1091-1115`（`createClub` 加 `now` 参数 + 限频；`joinClub` 加人数上限）
- Test: `server/tests/logic.test.js`

**Step 1: 写失败测试**（追加）

```js
test('createClub rate-limits too many per user within the window', async () => {
  const store = tmpStore();
  const base = 1000;
  for (let i = 0; i < logic.LIMITS.clubWindowMax; i++) {
    await logic.createClub(store, 'org', { name: 'g' + i }, base + i);
  }
  await withError(429, logic.createClub(store, 'org', { name: 'over' }, base + 10));
});

test('joinClub caps total members', async () => {
  const store = tmpStore();
  const club = await logic.createClub(store, 'org', { name: 'g' }, 1000);
  // creator already a member; fill to the cap with distinct openids
  for (let i = 0; i < logic.LIMITS.clubMemberMax - 1; i++) {
    await logic.joinClub(store, 'u' + i, club.code);
  }
  await withError(400, logic.joinClub(store, 'extra', club.code));
});
```

**Step 2: 跑测试确认失败**

Run: `cd server && node --test --test-name-pattern="createClub rate|joinClub caps" tests/logic.test.js`
Expected: FAIL — 限频未实现（第 21 个群建成功）、人数无上限

**Step 3a: `createClub` 加 `now` 参数 + 限频**（替换 `server/src/logic.js:1091-1106`）

```js
async function createClub(store, creatorOpenid, { name }, now = Date.now()) {
  const n = (name || '').trim();
  if (!n) throw httpError(400, '请填写群名称');
  return store.txn((state) => {
    const recentClubs = Object.values(state.clubs).filter(
      (c) => c.createdBy === creatorOpenid && c.createdAt > now - LIMITS.clubWindowMs
    ).length;
    if (recentClubs >= LIMITS.clubWindowMax) {
      throw httpError(429, '近期创建群过多，请稍后再试');
    }
    const club = {
      id: newId('club_'),
      name: n.slice(0, 32),
      code: genClubCode(state),
      createdBy: creatorOpenid,
      members: [creatorOpenid],
      createdAt: now,
    };
    state.clubs[club.id] = club;
    return { id: club.id, name: club.name, code: club.code, createdBy: club.createdBy, members: club.members.slice() };
  });
}
```

> 注意：`createdAt: Date.now()` 改成 `createdAt: now` 以保证可测、与 `createActivity` 一致。`index.js` 现有调用 `logic.createClub(store, req.user.openid, req.body || {})` 不传第 4 参，走默认值，**无需改路由**。

**Step 3b: `joinClub` 加人数上限**（替换 `server/src/logic.js:1108-1115`）

```js
async function joinClub(store, openid, code) {
  return store.txn((state) => {
    const club = Object.values(state.clubs).find((c) => c.code === code);
    if (!club) throw httpError(404, '邀请码无效');
    if (!club.members.includes(openid)) {
      if (club.members.length >= LIMITS.clubMemberMax) throw httpError(400, '该群人数已满');
      club.members.push(openid);
    }
    return { id: club.id, name: club.name, code: club.code, members: club.members.slice() };
  });
}
```

**Step 4: 跑全量测试**

Run: `cd server && npm test`
Expected: PASS（全部）

**Step 5: 提交**

```bash
git add server/src/logic.js server/tests/logic.test.js
git commit -m "feat: club creation rate limit + member cap"
```

---

### Task 7: 全量回归 + 代码自检

**Step 1: 跑全部后端测试**

Run: `cd server && npm test`
Expected: 全部 PASS，无遗漏。

**Step 2: 语法自检全部改动文件**

Run: `cd server && node --check src/store.js && node --check src/logic.js && node --check src/config.js && node --check src/index.js && echo OK`
Expected: `OK`

**Step 3（无代码改动则跳过提交）**

---

## Part A 收尾：明确不做的（YAGNI，记录在案）

- **敏感词过滤库**：邀请制（非搜索发现）+ 内容仅群内可见，搭一个失效的敏感词表收益<维护成本。以长度上限 + 速率限制覆盖真正的滥用向量（刷量）。审核若真要求再补。
- **换真 DB / Redis / 监控告警**：个人规模 JSON + 轮转备份够；并发真上来再说。

---

## Part B — 运维发布 Runbook（人工 checklist，非代码）

> 顺序即依赖关系。⏳ = 有等待时长，尽早启动。

### 阶段 0 — 立刻并行启动（最长 lead time，~2–4 周）

> ⚠️ 备案是整个计划最长的杆，必须最先启动。**个人主体要过两道备案**——「域名 ICP 备案」+「小程序备案」，互不依赖、并行办。两道都走各省通信管理局，管局审核 7–20 个工作日，总计 ~2–4 周。
> **云服务商：选腾讯云**（与微信同属腾讯，备案/合法域名/微信云托管生态最顺）。下文按腾讯云写；阿里云流程几乎一致（注意其备案要求服务器**首次购买 ≥12 个月**）。
> **简化方案**：若后端改用「微信云托管」（容器部署）可省掉 0.2 域名 ICP 备案（它打包已备案域名+HTTPS），但 DEPLOY.md 的 VM 方案要换成容器部署。自用规模建议先按 VM 走。

#### 0.1 前置（Day 0，域名实名 ~1–3 天）

> 铁律：腾讯云**账号实名 = 域名实名 = 备案主体**，三者同一身份证（你本人），中途换人会被卡。

- [ ] 腾讯云账号注册（微信扫码）→ **账号实名认证**（账号中心 → 个人实名 → 身份证 + 人脸）。
- [ ] 买**轻量应用服务器**（控制台 → 轻量应用服务器 → 新建）：
  - 地域：**中国内地**（北京/上海/广州，挑离你近的）——必须内地才能备案。
  - 镜像：**Ubuntu 22.04 或 24.04**（DEPLOY.md 是 Linux + systemd + Nginx + certbot，Ubuntu 最顺）。
  - 规格：**2 核 2G** 入门够（单进程 Node + JSON 文件库 + 邀请制低并发）；想宽裕选 2 核 4G。带宽 3–4M。
  - 时长：**≥3 个月、包年包月**（腾讯云备案硬要求；建议直接买 1 年，常有"买 1 年送几个月"活动，省续费麻烦）。
  - 付款后记下**公网 IP**。
- [ ] **域名注册 + 实名**：域名注册 → 先建**信息模板**（填本人信息 + 身份证，等实名审核 ~1–3 天）→ 模板过了再买域名（如 `badminton.你的域名`）→ 注册局通过后实名同步生效（**没过实名不能解析、不能备案**）。
- [ ] **解析**（实名过后）：DNSPod → 添加 **A 记录**（主机记录 `@` 或子域如 `badminton`，记录值 = 服务器公网 IP）。

#### 0.2 域名 ICP 备案（在腾讯云办 → 给后端域名用）

- [ ] 进腾讯云**备案小程序**（或网页备案系统）→ 验证备案类型。
- [ ] 填主体信息（你本人）→ 填网站/域名信息 → 上传**身份证原件拍照**、域名证书、核验照（App 内拍）。
- [ ] **腾讯云初审**（1–3 工作日）。
- [ ] **工信部短信核验**：发件号 **12381**，**24 小时内**回复，超时打回重来。
- [ ] **管局审核**（7–20 工作日）→ 下发备案号 → 域名可用于生产。

#### 0.3 小程序备案（在微信公众平台办 → 与 0.2 并行，不依赖服务器）

- [ ] mp.weixin.qq.com → **设置 → ICP备案** 进入。
- [ ] 填主体信息 + 小程序信息 + 负责人信息（**负责人 = 主办人本人 / 小程序管理员**；手机号邮箱一人一套）。
- [ ] 上传**身份证原件拍照**（有效期 ≥3 个月）+ 小程序备注说明。
- [ ] **微信初审**（1–2 工作日）。
- [ ] **工信部短信核验**（同 0.2，12381，24 小时内）。
- [ ] **管局复审**（最长 ~20 工作日）→ 下发备案号 → 小程序可对外服务。

#### 0.4 备案期间可并行（不必等备案下来）

- [ ] 服务器装好 Node ≥18、Nginx、Certbot。
- [ ] 按 `DEPLOY.md` 部署后端代码 + 配 systemd（用 IP 或临时域名自测，合法域名等备案下来再正式配）。
- [ ] 微信后台先办不依赖域名的事：类目「生活服务-预约/报名」、用户隐私保护指引、订阅消息模板 id；**合法域名(request/downloadFile)** 等域名备案下来再填。

> **备案的坑**：① 两道缺一不可——小程序备案缺→不能上线；域名备案缺→后端域名进不了合法域名列表。② 短信核验 24h 内必须回，盯紧。③ 域名实名认证是前置（1–3 天）。④ 备案号下来后，**网站底部要挂备案号并链接 `beian.miit.gov.cn`**（个人主体同样要求）；备案号在 [工信部备案系统](https://beian.miit.gov.cn) 查。

### 阶段 1 — 后端上线 + 提审前配置

- [ ] 按 `DEPLOY.md` 第一节部署后端到 `/opt/badminton`，`npm install --omit=dev`。
- [ ] 配生产 `.env`：`HOST=127.0.0.1`、`DATA_FILE` 用代码目录外绝对路径、`TOKEN_SECRET` 用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成、**填真实 `WX_APPID`/`WX_SECRET`**（填了即关 devMode）、`WX_ENV_VERSION=release`、`BACKUP_INTERVAL_SECONDS`/`BACKUP_KEEP` 按需。
- [ ] systemd 服务 `badminton-server` `active(running)` 且开机自启（`DEPLOY.md` 一.4）。
- [ ] Nginx 反代 + `certbot --nginx` 申请证书；`curl https://你的域名/api/health` 返回 `{"ok":true,...,"devMode":false}`。
- [ ] **前端 `miniprogram/utils/config.js`**：`PROD_URL` 改成 `https://你的域名`；`SUBSCRIBE_TEMPLATES.*` 填后台创建的真实模板 id（`PROMOTE_TPL_ID` 等占位符替换掉，未替换的会自动跳过发送）。
- [ ] **微信小程序后台** ([mp.weixin.qq.com](https://mp.weixin.qq.com))：
  - [ ] 开发管理 → 开发设置 → **服务器域名(request)** 加 `https://你的域名`；**downloadFile 合法域名**加同域（二维码保存用）。
  - [ ] 拿 `AppID` / `AppSecret`（Secret 即 `.env` 的 `WX_SECRET`）。
  - [ ] 订阅消息 → 创建 3 个模板（候补上位/报名成功/活动前提醒），把模板 id 填进上一步 `config.js`。
  - [ ] **用户隐私保护指引**：设置 → 基本设置 → 服务内容声明 / 用户隐私保护，声明收集 openid、昵称、头像、水平、性别、出勤（审核必查）。
- [ ] **真机走通完整流程一遍**（`DEPLOY.md` 第五节清单）：登录 → 建群 → 建活动 → 报名 → 候补 → 取消上位 → 扫码进活动 → AA 记账/签到。日志干净。

### 阶段 2 — 提审 + 体验版并行跡坑

- [ ] 微信开发者工具**编译**确认无报错 → **上传**为开发版（版本号如 `1.0.0`）。
- [ ] 后台 版本管理 → 开发版 **选为体验版**；成员管理加几个球友为体验成员（验证真实登录/数据）。
- [ ] 后台 版本管理 → 开发版 → **提交审核**：
  - [ ] **类目选「生活服务 → 预约/报名」**（个人主体天然落点，无需资质）。备选「工具」。**勿选「体育」**。
  - [ ] 名称/简介写「羽毛球活动报名/预约工具」，勿写「体育赛事平台」。
  - [ ] 功能页填活动详情页。
- [ ] 审核期间继续用体验版跡平真实登录/数据/备份问题。

### 阶段 2.5 — 审核通过后、正式发布前（补齐加固，确认线上生效）

- [ ] 确认线上备份在跑：服务器上 `ls -la <DATA_FILE>.bak.*` 应随时间出现轮转文件；可手动 `kill -USR1` 之外的验证方式：等一个 `BACKUP_INTERVAL_SECONDS` 或临时把间隔调小观察。
- [ ] 确认防滥用线上生效：用 `curl` 以不同 `devUserId`（devMode 已关，但可用真实两人或临时下调 `activityWindowMax` 验证）刷建活动，应 429。
- [ ] 手动触发一次备份并验证可恢复：`cp <DATA_FILE> <DATA_FILE>.manualbak`，确认 `.bak.1` 内容完整、可被 `_read` 解析。

### 阶段 3 — 发布

- [ ] 后台 版本管理 → 审核通过版本 → **发布**（可选「分阶段发布」灰度）。
- [ ] 发布后人数无上限；把活动/群邀请码/二维码扩散给球友。
- [ ] 发布后头几天盯服务器日志（请求日志 + 备份/异常日志）。

### 回退预案
- **审核被拒** → 按 [常见拒绝情形](https://developers.weixin.qq.com/miniprogram/product/reject.html) 改类目/描述/功能重提；个人主体可换「工具」类目再试。
- **数据丢失/损坏** → 停服务 → 用最近的 `.bak.N` 覆盖 `DATA_FILE` → 重启（`_read` 通常已自动从 `.bak.1` 恢复）。
- **真实登录异常** → 体验版先复现；检查 `WX_APPID`/`WX_SECRET` 与后台一致、`WX_ENV_VERSION=release`、域名已备案且在合法域名列表。

---

## 完成定义（DoD）

- Part A 全部 Task 提交，`npm test` 全绿，四个改动文件 `node --check` 通过。
- Part B checklist 全部勾选，正式版已发布且至少一个真实球友（非体验成员）能完整走通「扫码 → 加群 → 报名」。
- 线上 `db.json.bak.*` 轮转文件存在；防滥用 429 可复现。
