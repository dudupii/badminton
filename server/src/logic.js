'use strict';

// Pure-ish domain logic. Each public function is a transaction against the
// store, so capacity / waitlist / promote mutations are serialized & atomic.
// `now` params default to Date.now() but can be injected by tests.

const crypto = require('crypto');
const { newId } = require('./store');

// Readable alphabet (no 0/O/1/I/L) for activity invite codes — these become
// the `scene` value embedded in the mini-program QR code (max 32 chars).
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// User-selectable level / gender tags (kept in sync with the profile pickers).
const LEVELS = ['新手', '初级', '中级', '高级'];
const GENDERS = ['男', '女', '不公开'];

// Normalize + validate an optional activity-rules input. Returns
// { noShowBanDays?, allowedLevels? } or null when no rule is active.
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
  if (!out.noShowBanDays && !out.allowedLevels) return null;
  return out;
}

// Per-person amount owed given a fee config and the splitting-pool size.
function perPersonOwedCents(fee, poolSize) {
  if (!fee || !poolSize) return 0;
  if (fee.totalCents != null) return Math.round(fee.totalCents / poolSize);
  if (fee.perPersonCents != null) return fee.perPersonCents;
  return 0;
}

const LEVEL_WEIGHT = { 新手: 1, 初级: 2, 中级: 3, 高级: 4 };
function levelWeight(level) {
  return LEVEL_WEIGHT[level] || 2; // 未知水平按初级(2) 算
}

// Pure: split a confirmed roster into balanced groups (snake draft by level)
// or doubles pairs (strong + weak). Each returned item gains a `weight`.
function generateGroups(confirmed, { mode, count }) {
  const withWeight = (e) => ({ ...e, weight: levelWeight(e.level) });
  const sorted = [...confirmed].sort((a, b) => levelWeight(b.level) - levelWeight(a.level));
  if (mode === 'pairs') {
    const pairs = [];
    const n = Math.floor(sorted.length / 2);
    for (let i = 0; i < n; i++) {
      pairs.push([withWeight(sorted[i]), withWeight(sorted[sorted.length - 1 - i])]);
    }
    if (sorted.length % 2 === 1) pairs.push([withWeight(sorted[n])]); // 落单
    return pairs;
  }
  // groups: snake draft
  const c = Math.max(1, Number(count) || 1);
  const groups = Array.from({ length: c }, () => []);
  sorted.forEach((p, i) => {
    const round = Math.floor(i / c);
    const idxInRound = i % c;
    const idx = round % 2 === 0 ? idxInRound : c - 1 - idxInRound;
    groups[idx].push(withWeight(p));
  });
  return groups.filter((g) => g.length);
}

function genCode(state, len = 6) {
  const existing = new Set(Object.values(state.activities).map((a) => a.code));
  for (let attempt = 0; attempt < 16; attempt++) {
    const bytes = crypto.randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    if (!existing.has(s)) return s;
  }
  return CODE_CHARS.replace(/[^A-Z0-9]/g, '').slice(0, len); // astronomically unlikely fallback
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function toMs(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function publicActivity(a) {
  return {
    id: a.id,
    code: a.code,
    title: a.title,
    description: a.description,
    location: a.location,
    startTime: a.startTime,
    endTime: a.endTime,
    capacity: a.capacity,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    status: a.status, // 'open' | 'closed'
    fee: a.fee || null,
    rules: a.rules || null,
  };
}

// ---- users -----------------------------------------------------------------

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

// Thin store-backed wrapper over ensureUser — lets tests / callers guarantee a
// user record exists without touching raw state.
async function ensureUserExists(store, openid) {
  return store.txn((state) => {
    const u = ensureUser(state, openid);
    return { openid: u.openid };
  });
}

// Persist a server-relative avatar path on the user (uploaded + served by the
// route layer). Returns the stored avatarUrl.
async function setAvatar(store, openid, avatarUrl) {
  return store.txn((state) => {
    const u = ensureUser(state, openid);
    u.avatarUrl = avatarUrl;
    return { openid: u.openid, avatarUrl: u.avatarUrl };
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

// ---- activities ------------------------------------------------------------

async function createActivity(store, input, creatorOpenid, now = Date.now()) {
  const title = (input.title || '').trim();
  if (!title) throw httpError(400, '请填写活动标题');
  const capacity = Number(input.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) throw httpError(400, '名额需为大于 0 的整数');
  const startTime = toMs(input.startTime);
  if (!startTime) throw httpError(400, '请填写有效的开始时间');
  const endTime = toMs(input.endTime) || null;
  const rules = validateRules(input.rules);

  return store.txn((state) => {
    const activity = {
      id: newId('act_'),
      code: genCode(state),
      title,
      description: (input.description || '').trim(),
      location: (input.location || '').trim(),
      startTime,
      endTime,
      capacity,
      createdBy: creatorOpenid,
      createdAt: now,
      status: 'open',
      rules,
    };
    state.activities[activity.id] = activity;
    return publicActivity(activity);
  });
}

// Create `count` copies of an activity spaced `stepDays` apart (same weekday &
// time when stepDays is a multiple of 7). Used for recurring weekly sessions.
// Each instance is a separate activity with its own invite code; base-field
// validation runs per-instance via createActivity.
async function createRecurring(store, input, creatorOpenid, { count, stepDays }) {
  const n = Number(count);
  const step = Number(stepDays);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, '场数需为正整数');
  if (n > 12) throw httpError(400, '一次最多生成 12 场');
  if (!Number.isInteger(step) || step < 1) throw httpError(400, '周期天数需为正整数');

  const baseStart = toMs(input.startTime);
  if (!baseStart) throw httpError(400, '请填写有效的开始时间');
  const hasEnd = input.endTime !== undefined && input.endTime !== null && input.endTime !== '';
  const baseEnd = hasEnd ? toMs(input.endTime) : null;
  if (hasEnd && !baseEnd) throw httpError(400, '结束时间无效');

  const stepMs = step * 24 * 60 * 60 * 1000;
  const created = [];
  for (let i = 0; i < n; i++) {
    const instance = { ...input, startTime: baseStart + i * stepMs };
    if (hasEnd) instance.endTime = baseEnd + i * stepMs;
    created.push(await createActivity(store, instance, creatorOpenid));
  }
  return created;
}

async function listActivities(store) {
  const state = store.snapshot();
  return Object.values(state.activities)
    .map((a) => enrichActivity(state, a))
    .sort((a, b) => a.startTime - b.startTime);
}

async function getActivity(store, id, viewerOpenid) {
  const state = store.snapshot();
  const a = state.activities[id];
  if (!a) throw httpError(404, '活动不存在');
  return enrichActivity(state, a, viewerOpenid);
}

// Look up by invite code — used when the mini-program is opened by scanning
// the activity QR code (options.scene == code).
async function getActivityByCode(store, code, viewerOpenid) {
  const state = store.snapshot();
  const a = Object.values(state.activities).find((x) => x.code === code);
  if (!a) throw httpError(404, '活动不存在');
  return enrichActivity(state, a, viewerOpenid);
}

function enrichActivity(state, a, viewerOpenid) {
  const regs = state.registrations
    .filter((r) => r.activityId === a.id && r.status !== 'cancelled')
    .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));

  const confirmed = [];
  const waitlist = [];
  for (const r of regs) {
    const u = state.users[r.openid] || { openid: r.openid, nickname: '未知球友', avatarUrl: '', level: '', gender: '' };
    const entry = {
      openid: r.openid,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      level: u.level || '',
      gender: u.gender || '',
      paid: !!r.paid,
      attended: r.attended === undefined ? null : r.attended,
      createdAt: r.createdAt,
    };
    (confirmed.length < a.capacity ? confirmed : waitlist).push(entry);
  }

  // fee: who owes what
  const fee = a.fee || null;
  const pool = fee
    ? fee.splitBy === 'attended' ? confirmed.filter((e) => e.attended === true) : confirmed
    : [];
  const owed = perPersonOwedCents(fee, pool.length);
  const inPool = new Set(pool.map((e) => e.openid));
  for (const e of confirmed) e.owedCents = inPool.has(e.openid) ? owed : 0;

  let feeSummary = null;
  if (fee) {
    let totalOwed = 0;
    let totalPaid = 0;
    for (const e of confirmed) {
      totalOwed += e.owedCents;
      if (e.paid) totalPaid += e.owedCents;
    }
    feeSummary = { totalOwedCents: totalOwed, totalPaidCents: totalPaid, settled: totalPaid >= totalOwed && totalOwed > 0 };
  }

  const mine = viewerOpenid ? regs.find((r) => r.openid === viewerOpenid) : null;

  return {
    ...publicActivity(a),
    fee,
    feeSummary,
    confirmedCount: confirmed.length,
    waitlistCount: waitlist.length,
    confirmed,
    waitlist,
    myStatus: mine ? mine.status : null,
  };
}

async function setActivityStatus(store, id, status, actorOpenid) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    a.status = status;
    return publicActivity(a);
  });
}

// Edit an existing activity's content. Only the creator may edit. Capacity can
// be lowered but never below the current confirmed headcount (would evict
// people). Only fields present in `input` are touched.
async function updateActivity(store, id, actorOpenid, input) {
  // --- validate provided fields before entering the txn ------------------
  let title;
  if (input.title !== undefined) {
    title = (input.title || '').trim();
    if (!title) throw httpError(400, '请填写活动标题');
  }
  let capacity;
  if (input.capacity !== undefined) {
    capacity = Number(input.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) throw httpError(400, '名额需为大于 0 的整数');
  }
  let startTime;
  if (input.startTime !== undefined) {
    startTime = toMs(input.startTime);
    if (!startTime) throw httpError(400, '请填写有效的开始时间');
  }
  let endTime;
  if (input.endTime !== undefined) {
    // null / '' clears the end time; otherwise parse.
    endTime = input.endTime === null || input.endTime === '' ? null : toMs(input.endTime);
    if (endTime === null ? false : !endTime) throw httpError(400, '结束时间无效');
  }

  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以编辑');

    if (capacity !== undefined) {
      const confirmedCount = state.registrations.filter(
        (r) => r.activityId === id && r.status === 'confirmed'
      ).length;
      if (capacity < confirmedCount) {
        throw httpError(400, `名额不能少于已正式报名人数（${confirmedCount}）`);
      }
    }

    if (title !== undefined) a.title = title;
    if (input.description !== undefined) a.description = (input.description || '').trim();
    if (input.location !== undefined) a.location = (input.location || '').trim();
    if (startTime !== undefined) a.startTime = startTime;
    if (endTime !== undefined) a.endTime = endTime;
    if (capacity !== undefined) a.capacity = capacity;
    if (input.rules !== undefined) a.rules = validateRules(input.rules);
    return publicActivity(a);
  });
}

// Set / clear an activity's fee. Exactly one of totalCents (split among the
// pool) or perPersonCents (fixed per head) must be given alongside splitBy;
// a completely empty body clears any existing fee.
async function setFee(store, id, actorOpenid, input) {
  const totalCents = input.totalCents == null ? null : Number(input.totalCents);
  const perPersonCents = input.perPersonCents == null ? null : Number(input.perPersonCents);
  const splitBy = input.splitBy;
  const hasTotal = totalCents != null;
  const hasPer = perPersonCents != null;
  const hasSplit = splitBy != null;
  const wantsSet = hasTotal || hasPer || hasSplit; // {} → clear; any field → set

  if (hasTotal && hasPer) throw httpError(400, '总额与固定人均只能二选一');
  if (wantsSet) {
    if (!hasTotal && !hasPer) throw httpError(400, '需指定总额或人均');
    if (splitBy !== 'confirmed' && splitBy !== 'attended') throw httpError(400, 'splitBy 取值非法');
  }
  if (hasTotal && (!Number.isInteger(totalCents) || totalCents < 0)) throw httpError(400, '总额需为非负整数（分）');
  if (hasPer && (!Number.isInteger(perPersonCents) || perPersonCents < 0)) throw httpError(400, '人均需为非负整数（分）');

  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以设置费用');
    if (!wantsSet) {
      a.fee = null;
    } else {
      a.fee = {
        totalCents: hasTotal ? totalCents : null,
        perPersonCents: hasPer ? perPersonCents : null,
        splitBy,
      };
    }
    return publicActivity(a);
  });
}

// Mark a registrant paid/unpaid. Organizer only. Returns the updated slice.
async function markPaid(store, activityId, actorOpenid, targetOpenid, paid) {
  return store.txn((state) => {
    const a = state.activities[activityId];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    const r = state.registrations.find(
      (x) => x.activityId === activityId && x.openid === targetOpenid && x.status === 'confirmed'
    );
    if (!r) throw httpError(404, '该用户未正式报名');
    r.paid = !!paid;
    r.paidAt = r.paid ? Date.now() : null;
    return { openid: r.openid, paid: r.paid, paidAt: r.paidAt };
  });
}

// Mark a registrant's attendance: true=到, false=放鸽子, null/undefined=未签/清除。
async function markAttend(store, activityId, actorOpenid, targetOpenid, attended) {
  return store.txn((state) => {
    const a = state.activities[activityId];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以操作');
    const r = state.registrations.find(
      (x) => x.activityId === activityId && x.openid === targetOpenid && x.status === 'confirmed'
    );
    if (!r) throw httpError(404, '该用户未正式报名');
    r.attended = attended === undefined ? null : attended;
    return { openid: r.openid, attended: r.attended };
  });
}

async function deleteActivity(store, id, actorOpenid) {
  return store.txn((state) => {
    const a = state.activities[id];
    if (!a) throw httpError(404, '活动不存在');
    if (a.createdBy !== actorOpenid) throw httpError(403, '只有发起人可以删除');
    delete state.activities[id];
    state.registrations = state.registrations.filter((r) => r.activityId !== id);
    return { deleted: true };
  });
}

// ---- registrations ---------------------------------------------------------

async function register(store, activityId, openid, now = Date.now()) {
  return store.txn((state) => {
    const a = state.activities[activityId];
    if (!a) throw httpError(404, '活动不存在');
    if (a.status !== 'open') throw httpError(400, '该活动已关闭报名');
    if (a.startTime && a.startTime < now) throw httpError(400, '活动已开始，无法报名');

    const regs = state.registrations.filter((r) => r.activityId === activityId);
    const mine = regs.find((r) => r.openid === openid && r.status !== 'cancelled');
    if (mine) throw httpError(409, '您已报名该活动');

    const confirmedCount = regs.filter((r) => r.status === 'confirmed').length;
    const status = confirmedCount < a.capacity ? 'confirmed' : 'waitlist';

    const reg = {
      id: newId('reg_'),
      activityId,
      openid,
      status,
      createdAt: now,
      cancelledAt: null,
    };
    state.registrations.push(reg);
    return {
      status,
      message: status === 'confirmed' ? '报名成功！' : '名额已满，已加入候补。',
    };
  });
}

async function cancel(store, activityId, openid, now = Date.now()) {
  return store.txn((state) => {
    const a = state.activities[activityId];
    if (!a) throw httpError(404, '活动不存在');

    const regs = state.registrations.filter((r) => r.activityId === activityId);
    const mine = regs.find((r) => r.openid === openid && r.status !== 'cancelled');
    if (!mine) throw httpError(404, '您未报名该活动');

    const wasConfirmed = mine.status === 'confirmed';
    mine.status = 'cancelled';
    mine.cancelledAt = now;

    let promoted = null;
    if (wasConfirmed) {
      // Promote the earliest waitlister (FIFO by registration time).
      const next = regs
        .filter((r) => r.status === 'waitlist')
        .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1))[0];
      if (next) {
        next.status = 'confirmed';
        const u = state.users[next.openid] || {};
        promoted = { openid: next.openid, nickname: u.nickname };
      }
    }
    return { cancelled: true, promoted };
  });
}

// --- pre-start reminders (driven by a scheduler sweep in index.js) ---------

// Open activities whose start falls inside (now, now+leadMs] and that haven't
// been reminded yet. Read-only (no lock needed).
function findActivitiesNeedingReminder(store, { now, leadMs }) {
  const state = store.snapshot();
  return Object.values(state.activities)
    .filter((a) => a.status === 'open' && !a.remindedAt && a.startTime > now && a.startTime <= now + leadMs)
    .map((a) => a.id);
}

// For one activity, consume one reminder credit from each non-cancelled
// registrant who has one (for `templateId`), mark the activity as reminded,
// and return the openids to actually message. Atomic; the caller does the
// (non-fatal) network sends. Returns [] once already reminded.
async function sendReminders(store, activityId, templateId, { now }) {
  return store.txn((state) => {
    const a = state.activities[activityId];
    if (!a || a.remindedAt) return [];
    const targets = [];
    for (const r of state.registrations) {
      if (r.activityId !== activityId || r.status === 'cancelled') continue;
      const u = state.users[r.openid];
      if (u && u.subs && u.subs[templateId]) {
        u.subs[templateId] -= 1;
        if (u.subs[templateId] <= 0) delete u.subs[templateId];
        targets.push({ openid: r.openid });
      }
    }
    a.remindedAt = now;
    return targets;
  });
}

// All of a user's active registrations, joined with activity info.
async function myRegistrations(store, openid) {
  const state = store.snapshot();
  return state.registrations
    .filter((r) => r.openid === openid && r.status !== 'cancelled')
    .map((r) => {
      const a = state.activities[r.activityId];
      if (!a) return null;
      return { activity: publicActivity(a), status: r.status, createdAt: r.createdAt };
    })
    .filter(Boolean)
    .sort((x, y) => x.activity.startTime - y.activity.startTime);
}

// A creator's own activities, newest first — used by "copy last activity".
async function myCreatedActivities(store, openid) {
  const state = store.snapshot();
  return Object.values(state.activities)
    .filter((a) => a.createdBy === openid)
    .map(publicActivity)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Per-user attendance across the organizer's activities: confirmed / attended /
// noShow (confirmed but marked absent) / rate. Waitlisted and cancelled excluded.
function attendanceStats(store, organizerOpenid) {
  const state = store.snapshot();
  const mine = new Set(
    Object.values(state.activities)
      .filter((a) => a.createdBy === organizerOpenid)
      .map((a) => a.id)
  );
  const byUser = {};
  for (const r of state.registrations) {
    if (!mine.has(r.activityId) || r.status !== 'confirmed') continue;
    const u = byUser[r.openid] || (byUser[r.openid] = { openid: r.openid, confirmed: 0, attended: 0, noShow: 0 });
    u.confirmed++;
    if (r.attended === true) u.attended++;
    else if (r.attended === false) u.noShow++;
  }
  return Object.values(byUser)
    .map((u) => ({
      ...u,
      nickname: (state.users[u.openid] || {}).nickname || '球友',
      rate: u.confirmed ? u.attended / u.confirmed : 0,
    }))
    .sort((a, b) => b.attended - a.attended || b.confirmed - a.confirmed);
}

module.exports = {
  httpError,
  toMs,
  ensureUser,
  ensureUserExists,
  setAvatar,
  addSubscription,
  consumeSubscription,
  updateProfile,
  createActivity,
  createRecurring,
  listActivities,
  getActivity,
  getActivityByCode,
  setActivityStatus,
  updateActivity,
  setFee,
  markPaid,
  markAttend,
  deleteActivity,
  register,
  cancel,
  findActivitiesNeedingReminder,
  sendReminders,
  myRegistrations,
  myCreatedActivities,
  attendanceStats,
  generateGroups,
};
