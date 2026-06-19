'use strict';

const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { Store } = require('./store');
const { sign, verify, codeToOpenid, requireAuth, optionalAuth } = require('./auth');
const wxapi = require('./wxapi');
const logic = require('./logic');

const store = new Store(config.dataFile);
const app = express();

// Uploaded avatars land here (local-file storage backend; swap to COS/S3 for
// production scale). Created on first upload.
const AVATAR_DIR = path.join(__dirname, '..', 'data', 'avatars');

app.use(express.json({ limit: '2mb' })); // room for base64 avatar uploads

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

// --- request logging (skip CORS preflight & health pings) ---
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || req.path === '/api/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      `${new Date().toISOString()}  ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`
    );
  });
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
    const u = state.users[req.user.openid] || { openid: req.user.openid, nickname: '球友', avatarUrl: '', level: '', gender: '' };
    return { openid: u.openid, nickname: u.nickname, avatarUrl: u.avatarUrl, level: u.level || '', gender: u.gender || '' };
  })
);

app.patch(
  '/api/user/me',
  requireAuth,
  wrap(async (req) => logic.updateProfile(store, req.user.openid, req.body || {}))
);

// --- avatars (local-file storage backend) ----------------------------------
// Serve uploaded avatars publicly (the <image> tag can't send auth headers).
app.use('/avatars', express.static(AVATAR_DIR));

// Accept a base64-encoded avatar, store it, and persist its server-relative
// URL on the user. Client prefixes BASE_URL when rendering.
app.post(
  '/api/user/me/avatar',
  requireAuth,
  wrap(async (req) => {
    const { avatar, ext } = req.body || {};
    if (typeof avatar !== 'string' || !avatar) throw logic.httpError(400, '缺少头像数据');
    const safeExt = ext === 'jpeg' || ext === 'jpg' ? 'jpg' : 'png';
    const data = avatar.startsWith('data:') ? avatar.slice(avatar.indexOf(',') + 1) : avatar;
    const buf = Buffer.from(data, 'base64');
    if (buf.length > 2 * 1024 * 1024) throw logic.httpError(400, '头像过大（>2MB）');
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const file = `${req.user.openid}.${safeExt}`;
    fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
    return logic.setAvatar(store, req.user.openid, '/avatars/' + file);
  })
);

// --- activities -------------------------------------------------------------
app.get('/api/activities', wrap(async () => logic.listActivities(store)));

app.post(
  '/api/activities',
  requireAuth,
  wrap(async (req) => {
    const body = req.body || {};
    const repeat = body.repeat;
    if (repeat && Number(repeat.count) > 1) {
      const list = await logic.createRecurring(store, body, req.user.openid, {
        count: repeat.count,
        stepDays: repeat.stepDays || 7,
      });
      return { activities: list };
    }
    return logic.createActivity(store, body, req.user.openid);
  })
);

app.get(
  '/api/activities/created-by/me',
  requireAuth,
  wrap(async (req) => logic.myCreatedActivities(store, req.user.openid))
);

app.get(
  '/api/activities/:id',
  optionalAuth,
  wrap(async (req) => logic.getActivity(store, req.params.id, req.user && req.user.openid))
);

// Open the activity by invite code — used when the mini-program is launched by
// scanning the activity QR code (options.scene == code).
app.get(
  '/api/activities/by-code/:code',
  optionalAuth,
  wrap(async (req) => logic.getActivityByCode(store, req.params.code, req.user && req.user.openid))
);

// QR code image for an activity. Public (the <image> tag can't send auth
// headers). Production -> official 小程序码 (scannable into the mini-program);
// dev -> a plain QR placeholder so the UI works without credentials.
app.get(
  '/api/activities/:id/qrcode',
  wrap(async (req, res) => {
    const state = store.snapshot();
    const a = state.activities[req.params.id];
    if (!a) throw logic.httpError(404, '活动不存在');

    let buffer;
    let contentType;
    if (config.wx.devMode) {
      const text =
        `羽毛球报名｜${a.title}｜口令 ${a.code}\n` +
        `（开发模式占位码；生产环境将生成可直接扫码进入小程序的小程序码）`;
      buffer = await QRCode.toBuffer(text, {
        type: 'png',
        width: 430,
        margin: 2,
        color: { dark: '#16a34a', light: '#ffffff' },
      });
      contentType = 'image/png';
    } else {
      ({ buffer, contentType } = await wxapi.getMiniProgramCode({
        scene: a.code,
        page: 'pages/detail/detail',
      }));
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  })
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

// Edit activity content (title/time/place/capacity/description). Creator only.
app.put(
  '/api/activities/:id',
  requireAuth,
  wrap(async (req) => logic.updateActivity(store, req.params.id, req.user.openid, req.body || {}))
);

app.delete(
  '/api/activities/:id',
  requireAuth,
  wrap(async (req) => logic.deleteActivity(store, req.params.id, req.user.openid))
);

// --- registrations ----------------------------------------------------------
app.post(
  '/api/activities/:id/register',
  requireAuth,
  wrap(async (req) => {
    const result = await logic.register(store, req.params.id, req.user.openid);
    // Optional "registration success" subscribe message (one-time credit).
    const tpl = config.wx.subscribeTemplates.registered;
    if (tpl && !config.wx.devMode) {
      const acted = await logic.consumeSubscription(store, req.user.openid, tpl);
      if (acted) {
        const a = store.snapshot().activities[req.params.id];
        try {
          await wxapi.sendSubscribeMessage(
            req.user.openid,
            tpl,
            {
              thing1: { value: a ? a.title : '活动' },
              time2: { value: a ? new Date(a.startTime).toLocaleString('zh-CN') : '' },
              thing3: { value: result.status === 'waitlist' ? '候补' : '正式' },
            },
            'pages/detail/detail?id=' + req.params.id
          );
        } catch (e) {
          console.error('register notify failed:', e.message); // non-fatal
        }
      }
    }
    return result;
  })
);

app.post(
  '/api/activities/:id/cancel',
  requireAuth,
  wrap(async (req) => {
    const result = await logic.cancel(store, req.params.id, req.user.openid);
    // If someone was auto-promoted, notify them (event-driven, no scheduler).
    if (result.promoted) {
      const tpl = config.wx.subscribeTemplates.promote;
      const acted = tpl && !config.wx.devMode && await logic.consumeSubscription(store, result.promoted.openid, tpl);
      if (acted) {
        const a = store.snapshot().activities[req.params.id];
        try {
          await wxapi.sendSubscribeMessage(
            result.promoted.openid,
            tpl,
            {
              thing1: { value: a ? a.title : '活动' },
              time2: { value: a ? new Date(a.startTime).toLocaleString('zh-CN') : '' },
              thing3: { value: a ? (a.location || '见详情') : '' },
            },
            'pages/detail/detail?id=' + req.params.id
          );
        } catch (e) {
          console.error('promote notify failed:', e.message); // non-fatal
        }
      }
    }
    return result;
  })
);

app.get(
  '/api/registrations/me',
  requireAuth,
  wrap(async (req) => logic.myRegistrations(store, req.user.openid))
);

// --- pre-start reminder scheduler ------------------------------------------
// Event-driven app otherwise has no timers; reminders need a periodic sweep.
// Skips itself entirely in devMode or with no template configured.
const REMIND_LEAD_MS = (Number(process.env.REMIND_LEAD_HOURS) || 24) * 3600000;
const REMIND_INTERVAL_MS = (Number(process.env.REMIND_INTERVAL_SECONDS) || 300) * 1000;

async function reminderSweep() {
  const tpl = config.wx.subscribeTemplates.remind;
  if (!tpl || config.wx.devMode) return;
  const now = Date.now();
  const ids = logic.findActivitiesNeedingReminder(store, { now, leadMs: REMIND_LEAD_MS });
  for (const id of ids) {
    const targets = await logic.sendReminders(store, id, tpl, { now });
    if (!targets.length) continue;
    const a = store.snapshot().activities[id];
    for (const t of targets) {
      try {
        await wxapi.sendSubscribeMessage(
          t.openid,
          tpl,
          {
            thing1: { value: a ? a.title : '活动' },
            time2: { value: a ? new Date(a.startTime).toLocaleString('zh-CN') : '' },
            thing3: { value: a ? (a.location || '见详情') : '' },
          },
          'pages/detail/detail?id=' + id
        );
      } catch (e) {
        console.error('remind send failed:', e.message); // non-fatal
      }
    }
  }
}

// --- subscriptions (one-time subscribe-message credits) --------------------
app.post(
  '/api/subscriptions',
  requireAuth,
  wrap(async (req) => {
    const templateId = req.body && req.body.templateId;
    return logic.addSubscription(store, req.user.openid, templateId);
  })
);

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`🏸 badminton-server listening on ${config.host}:${config.port}`);
    console.log(`   devMode=${config.wx.devMode}  db=${config.dataFile}`);
  });
  // Kick the reminder sweep periodically (and once shortly after boot).
  setInterval(reminderSweep, REMIND_INTERVAL_MS).unref();
  setTimeout(reminderSweep, 10000).unref();
}

module.exports = { app, store, logic };
