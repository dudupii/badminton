'use strict';
// 一次性迁移：把现有级别数据全重置为「未设」（user.level=''，删除活动的
// minLevel/allowedLevels）。级别从 4 档改 6 档，旧自评在新细档下不准，决定
// 全重置让球友凭新说明重选。幂等：没有旧级别值就跳过。运行前自动备份。
//
// ⚠️ 运行前必须停服务器：Store 把整个 db 放内存、每次 txn 写回 data/db.json，
//    若服务器在跑，迁移改了磁盘文件后会被下一次写覆盖回去。
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', 'data', 'db.json');
const BAK = DB + '.bak-levels';

if (!fs.existsSync(DB)) {
  console.log('找不到 db.json，跳过');
  process.exit(0);
}

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

// 幂等检测：是否还有任何已设级别值
let dirty = false;
const users = Object.values(db.users || {});
for (const u of users) if (u.level) { dirty = true; break; }
if (!dirty) {
  for (const a of Object.values(db.activities || {})) {
    if (a.rules && (a.rules.minLevel || (a.rules.allowedLevels && a.rules.allowedLevels.length))) { dirty = true; break; }
  }
}
if (!dirty) {
  console.log('没有已设级别数据，无需迁移，跳过');
  process.exit(0);
}

// 备份
fs.writeFileSync(BAK, JSON.stringify(db, null, 2));
console.log('已备份 →', BAK);

let userCleared = 0;
for (const u of users) {
  if (u.level) { u.level = ''; userCleared++; }
}

let actCleared = 0;
for (const a of Object.values(db.activities || {})) {
  if (!a.rules) continue;
  let changed = false;
  if (a.rules.minLevel) { delete a.rules.minLevel; changed = true; }
  if (Array.isArray(a.rules.allowedLevels) && a.rules.allowedLevels.length) { delete a.rules.allowedLevels; changed = true; }
  if (changed) actCleared++;
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2));
console.log(`完成：清空 ${userCleared} 个用户水平、${actCleared} 个活动的级别规则`);
console.log('（其它规则 noShowBanDays/cancelDeadlineHours/allowedGenders 保留）');
