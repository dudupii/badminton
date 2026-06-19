// Backend URL is auto-selected by the mini-program's environment version:
//   develop (模拟器 + 真机预览) -> DEV_URL   (开发机，可走局域网 HTTP)
//   trial / release (体验版/正式版) -> PROD_URL (公网 HTTPS 后端，必须)
//
// 这样发布前后端地址自动切换，无需手动改代码。发布前只需把 PROD_URL
// 改成你自己的域名。
const DEV_URL = 'http://192.168.50.154:3001'; // 开发机局域网地址（同 WiFi）— 模拟器手测临时改 3001（3000 被其他服务占用）
const PROD_URL = 'https://badminton.example.com'; // ← 改成你的生产域名（HTTPS）

function detectEnv() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion; // develop|trial|release
  } catch (e) {
    return 'develop';
  }
}

const ENV = detectEnv();
const BASE_URL = ENV === 'release' || ENV === 'trial' ? PROD_URL : DEV_URL;

// 订阅消息模板 id（小程序后台「订阅消息」创建后填入）
const SUBSCRIBE_TEMPLATES = {
  promote: 'PROMOTE_TPL_ID', // 候补自动上位
  registered: 'REGISTERED_TPL_ID', // 报名成功
  remind: 'REMIND_TPL_ID', // 活动开始前提醒
};

module.exports = { BASE_URL, ENV, DEV_URL, PROD_URL, SUBSCRIBE_TEMPLATES };
