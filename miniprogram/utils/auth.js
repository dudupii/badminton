const { request, setToken } = require('./request');

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
async function ensureLogin(opts) {
  const app = getApp();
  if (app.globalData.token && !opts.force) return app.globalData.token;

  const code = await wxLogin();
  const data = await request('POST', '/api/auth/login', {
    code,
    devUserId: devUserId(),
  });
  setToken(data.token);
  app.globalData.openid = data.user.openid;
  app.globalData.userInfo = data.user;
  return data.token;
}

module.exports = { ensureLogin, devUserId };
