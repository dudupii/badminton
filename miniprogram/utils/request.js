const { BASE_URL } = require('./config');

function getToken() {
  return getApp().globalData.token;
}

function setToken(t) {
  const app = getApp();
  app.globalData.token = t || null;
  if (t) wx.setStorageSync('token', t);
  else wx.removeStorageSync('token');
}

function rawRequest(method, path, data, token) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      success: resolve,
      fail: reject,
    });
  });
}

// Wraps wx.request: auto-attaches the token, transparently re-logs-in on 401,
// and throws on any error (caller shows toast). Resolves with the `data` field.
async function request(method, path, data) {
  let token = getToken();
  let res = await rawRequest(method, path, data || {}, token);

  if (res.statusCode === 401) {
    const { ensureLogin } = require('./auth'); // lazy to avoid a require cycle
    token = await ensureLogin({ force: true });
    res = await rawRequest(method, path, data || {}, token);
  }

  const body = res.data || {};
  if (res.statusCode >= 400 || body.ok === false) {
    throw new Error(body.error || '请求失败 (' + res.statusCode + ')');
  }
  return body.data;
}

module.exports = { request, setToken, getToken, BASE_URL };
