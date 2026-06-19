'use strict';

// Minimal .env loader so the server has zero non-express dependencies.
// Reads a .env file at the project root if present, without overriding
// variables that are already set in the real environment.
const path = require('path');
const fs = require('fs');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const bool = (v) => v === '1' || v === 'true' || v === 'TRUE';

const config = {
  port: Number(process.env.PORT || 3000),
  // Behind Nginx in prod, bind to loopback only so only the proxy can reach it.
  // Dev (no Nginx) needs 0.0.0.0 to be reachable from the simulator/phone on LAN.
  host: process.env.HOST || '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  dataFile: path.join(__dirname, '..', process.env.DATA_FILE || './data/db.json'),

  tokenSecret: process.env.TOKEN_SECRET || 'dev-insecure-secret',

  wx: {
    appid: process.env.WX_APPID || '',
    secret: process.env.WX_SECRET || '',
    // Mini-program QR codes target which version: 'release' | 'trial' | 'develop'.
    // Use 'develop'/'trial' while testing before publishing.
    envVersion: process.env.WX_ENV_VERSION || 'release',
    // Dev mode = no real WeChat credentials. Login then accepts a stable
    // devUserId from the client to give a persistent identity offline.
    devMode: !(process.env.WX_APPID && process.env.WX_SECRET),
  },
};

// always-available helper for tests / callers
config.isDev = () => config.wx.devMode;

module.exports = config;
