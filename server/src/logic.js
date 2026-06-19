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
    const u = state.users[r.openid] || { openid: r.openid, nickname: '未知球友', avatarUrl: '' };
    const entry = {
      openid: r.openid,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      level: u.level || '',
      gender: u.gender || '',
      createdAt: r.createdAt,
    };
    (confirmed.length < a.capacity ? confirmed : waitlist).push(entry);
  }

  const mine = viewerOpenid ? regs.find((r) => r.openid === viewerOpenid) : null;

  return {
    ...publicActivity(a),
    confirmedCount: confirmed.length,
    waitlistCount: waitlist.length,
    confirmed, // ordered, capacity-bounded
    waitlist, // ordered remainder
    myStatus: mine ? mine.status : null, // 'confirmed' | 'waitlist' | null
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
    return publicActivity(a);
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

module.exports = {
  httpError,
  toMs,
  ensureUser,
  ensureUserExists,
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
  deleteActivity,
  register,
  cancel,
  findActivitiesNeedingReminder,
  sendReminders,
  myRegistrations,
  myCreatedActivities,
};
