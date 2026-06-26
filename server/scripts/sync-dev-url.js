'use strict';
// 开发便利：检测本机当前局域网 IP，写回 miniprogram/utils/config.js 的 DEV_URL。
// WiFi 变了跑一下（npm run dev / npm start 会自动先跑），省得每次手改。
// 仅开发用，不动 PROD_URL；生产部署若没有前端文件则安静跳过、不阻断启动。
const os = require('os');
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'config.js');
const PORT = process.env.PORT || '3001';

// 跳过 loopback / docker 网桥 / VPN / 虚拟网卡，优先 WiFi/有线网卡
const SKIP = /^(lo|docker|br-|veth|virbr|tun|wg|surfshark|vpn|utun|tailscale|tap)/;
const PREFER = /^(wl|wlan|en|eth)/;

function pickLanIp() {
  let preferred = null;
  let fallback = null;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (SKIP.test(name)) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [b1, b2] = a.address.split('.').map(Number);
      // 排除 docker 常用网段 172.16~31（家宽 LAN 极少落在这一段）
      if (b1 === 172 && b2 >= 16 && b2 <= 31) continue;
      if (PREFER.test(name) && !preferred) preferred = a.address;
      if (!fallback) fallback = a.address;
    }
  }
  return preferred || fallback;
}

if (!fs.existsSync(CONFIG)) {
  // 生产/仅后端部署可能没有前端文件 —— 安静跳过，不阻断 npm start
  process.exit(0);
}

const ip = pickLanIp();
if (!ip) {
  console.log('sync-dev-url: 没找到局域网 IP，跳过');
  process.exit(0);
}

const src = fs.readFileSync(CONFIG, 'utf8');
const re = /(const DEV_URL = 'http:\/\/)([^:]+)(:\d+)(')/;
const m = re.exec(src);
if (!m) {
  console.error('sync-dev-url: 在 config.js 找不到 DEV_URL 行，放弃');
  process.exit(0); // 不阻断启动
}
const before = m[2] + m[3];
fs.writeFileSync(CONFIG, src.replace(re, `$1${ip}:${PORT}$4`));
console.log(`sync-dev-url: DEV_URL  ${before}  →  ${ip}:${PORT}`);
