'use strict';

const express = require('express');
const config = require('./config');
const { Store } = require('./store');
const { sign, verify, codeToOpenid, requireAuth, optionalAuth } = require('./auth');
const logic = require('./logic');

const store = new Store(config.dataFile);
const app = express();

app.use(express.json({ limit: '256kb' }));

// --- CORS (mini-program requests aren't browser-CORS-bound, but the DevTools
// HTTP panel / web testing benefit) ---
app.use((req, res, next) => {
  const origin = config.corsOrigin;
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Surface { statusCode, message } from logic as proper HTTP responses.
function wrap(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req, res);
      if (data !== undefined) res.json({ ok: true, data });
    } catch (e) {
      const status = e.statusCode || 500;
      if (status >= 500) console.error(e);
      res.status(status).json({ ok: false, error: e.message || '服务器错误' });
    }
  };
}

// --- health -----------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, data: { devMode: config.wx.devMode } }));

// --- auth -------------------------------------------------------------------
app.post(
  '/api/auth/login',
  wrap(async (req) => {
    const { code, devUserId, nickname, avatarUrl } = req.body || {};
    if (!code && !config.wx.devMode) {
      throw logic.httpError(400, '缺少 code');
    }
    const openid = await codeToOpenid(code, devUserId);
    const user = await store.txn((state) => {
      const u = logic.ensureUser(state, openid);
      if (nickname) u.nickname = String(nickname).slice(0, 32);
      if (avatarUrl) u.avatarUrl = avatarUrl;
      return { openid: u.openid, nickname: u.nickname, avatarUrl: u.avatarUrl };
    });
    const token = sign({ openid, iat: Math.floor(Date.now() / 1000) });
    return { token, user };
  })
);

// --- user -------------------------------------------------------------------
app.get(
  '/api/user/me',
  requireAuth,
  wrap(async (req) => {
    const state = store.snapshot();
    const u = state.users[req.user.openid] || { openid: req.user.openid, nickname: '球友', avatarUrl: '' };
    return { openid: u.openid, nickname: u.nickname, avatarUrl: u.avatarUrl };
  })
);

app.patch(
  '/api/user/me',
  requireAuth,
  wrap(async (req) => logic.updateProfile(store, req.user.openid, req.body || {}))
);

// --- activities -------------------------------------------------------------
app.get('/api/activities', wrap(async () => logic.listActivities(store)));

app.post(
  '/api/activities',
  requireAuth,
  wrap(async (req) => logic.createActivity(store, req.body || {}, req.user.openid))
);

app.get(
  '/api/activities/:id',
  optionalAuth,
  wrap(async (req) => logic.getActivity(store, req.params.id, req.user && req.user.openid))
);

app.patch(
  '/api/activities/:id',
  requireAuth,
  wrap(async (req) => {
    const status = req.body && req.body.status;
    if (status !== 'open' && status !== 'closed') throw logic.httpError(400, 'status 取值非法');
    return logic.setActivityStatus(store, req.params.id, status, req.user.openid);
  })
);

// --- registrations ----------------------------------------------------------
app.post(
  '/api/activities/:id/register',
  requireAuth,
  wrap(async (req) => logic.register(store, req.params.id, req.user.openid))
);

app.post(
  '/api/activities/:id/cancel',
  requireAuth,
  wrap(async (req) => logic.cancel(store, req.params.id, req.user.openid))
);

app.get(
  '/api/registrations/me',
  requireAuth,
  wrap(async (req) => logic.myRegistrations(store, req.user.openid))
);

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`🏸 badminton-server listening on http://localhost:${config.port}`);
    console.log(`   devMode=${config.wx.devMode}  db=${config.dataFile}`);
  });
}

module.exports = { app, store, logic };
