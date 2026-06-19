'use strict';

// Token auth using HMAC-SHA256 (no external JWT dependency).
// Token format: base64url(payload).base64url(hmac)
// payload: { openid, iat }

const crypto = require('crypto');
const config = require('./config');

const b64u = {
  encode: (buf) => buf.toString('base64url'),
  decode: (str) => Buffer.from(str, 'base64url'),
};

function sign(payload) {
  const body = b64u.encode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64u.encode(crypto.createHmac('sha256', config.tokenSecret).update(body).digest());
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64u.encode(crypto.createHmac('sha256', config.tokenSecret).update(body).digest());
  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64u.decode(body).toString('utf8'));
    if (!payload || typeof payload.openid !== 'string') return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Exchange a wx.login() code for an openid. Real mode hits code2session;
// dev mode derives a stable openid from a client-supplied devUserId.
async function codeToOpenid(code, devUserId) {
  if (config.wx.devMode) {
    const base = devUserId || ('anon-' + String(code || '').slice(0, 8));
    return 'dev_' + base;
  }
  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${encodeURIComponent(config.wx.appid)}` +
    `&secret=${encodeURIComponent(config.wx.secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode || !data.openid) {
    const err = new Error(`code2session failed: ${JSON.stringify(data)}`);
    err.statusCode = 401;
    throw err;
  }
  return data.openid;
}

// Express middleware: require a valid bearer token, attach req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verify(token);
  if (!payload) return res.status(401).json({ ok: false, error: '未登录或登录已过期' });
  req.user = { openid: payload.openid };
  next();
}

// Soft auth: decode token if present, but never reject (public endpoints that
// still want to personalize for a logged-in viewer).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verify(token) : null;
  req.user = payload ? { openid: payload.openid } : null;
  next();
}

module.exports = { sign, verify, codeToOpenid, requireAuth, optionalAuth };
