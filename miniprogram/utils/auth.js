const { request, setToken } = require('./request');
const { ENV } = require('./config');

// Stable per-device identity used ONLY in dev mode (server has no WeChat
// AppID). In production the server ignores this and uses the real openid from
// code2session.
function devUserId() {
  let id = wx.getStorageSync('devUserId');
  if (!id) {
    id = 'dev-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    wx.setStorageSync('devUserId', id);
  }
  return id;
}

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({ success: (res) => resolve(res.code), fail: reject });
  });
}

// Ensures we have a valid session token. Cached in globalData + storage.
// Short-circuits only when BOTH token and openid are cached — otherwise a
// reload with a cached token would leave globalData.openid null (it's not in
// the token), breaking any client-side creator/self check (isCreator, etc.).
async function ensureLogin(opts) {
  const app = getApp();
  if (app.globalData.token && app.globalData.openid && !opts.force) {
    return app.globalData.token;
  }

  // wx.login() times out on the Linux community port (no WeChat credentials).
  // In develop env, skip it entirely — the server uses devUserId, not code.
  let code;
  if (ENV !== 'develop') {
    code = await wxLogin();
  }
  const data = await request('POST', '/api/auth/login', {
    code,
    devUserId: devUserId(),
  });
  if (!data || !data.token || !data.user) {
    throw new Error('登录响应异常: ' + JSON.stringify(data).slice(0, 100));
  }
  setToken(data.token);
  app.globalData.openid = data.user.openid;
  app.globalData.userInfo = data.user;
  wx.setStorageSync('openid', data.user.openid);
  return data.token;
}

module.exports = { ensureLogin, devUserId };
