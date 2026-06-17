'use strict';

// Pure-ish domain logic. Each public function is a transaction against the
// store, so capacity / waitlist / promote mutations are serialized & atomic.
// `now` params default to Date.now() but can be injected by tests.

const crypto = require('crypto');
const { newId } = require('./store');

// Readable alphabet (no 0/O/1/I/L) for activity invite codes — these become
// the `scene` value embedded in the mini-program QR code (max 32 chars).
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

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
      createdAt: Date.now(),
    };
  }
  return state.users[openid];
}

async function updateProfile(store, openid, { nickname, avatarUrl }) {
  return store.txn((state) => {
    const u = ensureUser(state, openid);
    if (typeof nickname === 'string' && nickname.trim()) u.nickname = nickname.trim().slice(0, 32);
    if (typeof avatarUrl === 'string') u.avatarUrl = avatarUrl;
    return { openid: u.openid, nickname: u.nickname, avatarUrl: u.avatarUrl };
  });
}

// ---- activities ------------------------------------------------------------

async function createActivity(store, input, creatorOpenid) {
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
      createdAt: Date.now(),
      status: 'open',
    };
    state.activities[activity.id] = activity;
    return publicActivity(activity);
  });
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

module.exports = {
  httpError,
  toMs,
  ensureUser,
  updateProfile,
  createActivity,
  listActivities,
  getActivity,
  getActivityByCode,
  setActivityStatus,
  register,
  cancel,
  myRegistrations,
};
