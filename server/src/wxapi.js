'use strict';

// WeChat platform API helpers, used only in production mode (real AppID/secret):
//  - access_token fetching with in-memory caching
//  - wxacode.getUnlimited -> returns a mini-program QR code (小程序码) PNG.
//    The `scene` value lands on the target page's options.scene when scanned.

const config = require('./config');

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  // refresh a few minutes before expiry to be safe
  if (tokenCache.token && tokenCache.expiresAt - now > 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const url =
    `https://api.weixin.qq.com/cgi-bin/token` +
    `?grant_type=client_credential` +
    `&appid=${encodeURIComponent(config.wx.appid)}` +
    `&secret=${encodeURIComponent(config.wx.secret)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.access_token) {
    const err = new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
    err.statusCode = 502;
    throw err;
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ? data.expires_in * 1000 : 7200 * 1000),
  };
  return tokenCache.token;
}

// Returns { buffer, contentType }. buffer is a PNG when successful.
async function getMiniProgramCode({ scene, page, width = 430 }) {
  const token = await getAccessToken();
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scene, // <= 32 chars -> page options.scene
      page, // no leading slash
      check_path: false,
      env_version: config.wx.envVersion, // release | trial | develop
      width,
      auto_color: false,
      line_color: { r: 22, g: 163, b: 74 }, // #16a34a brand green
      is_hyaline: false,
    }),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.startsWith('image/')) {
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), contentType };
  }
  // Error: WeChat returns JSON with errcode/errmsg instead of an image.
  let detail = '';
  try {
    detail = JSON.stringify(await res.json());
  } catch (e) {
    detail = await res.text().catch(() => '');
  }
  const err = new Error(`生成小程序码失败: ${detail}`);
  err.statusCode = 502;
  throw err;
}

// Send a one-time subscribe message. `data` keys must match the template's
// field names (e.g. { thing1: { value: '...' }, time2: { value: '...' } }).
async function sendSubscribeMessage(openid, templateId, data, page) {
  const token = await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`;
  const state = config.wx.envVersion === 'release' ? 'formal' : config.wx.envVersion === 'trial' ? 'trial' : 'developer';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: openid,
      template_id: templateId,
      page,
      data,
      miniprogram_state: state,
      lang: 'zh_CN',
    }),
  });
  const j = await res.json();
  if (j.errcode) {
    const err = new Error(`subscribe send failed: ${JSON.stringify(j)}`);
    err.detail = j;
    throw err;
  }
  return j;
}

module.exports = { getAccessToken, getMiniProgramCode, sendSubscribeMessage };
