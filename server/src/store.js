'use strict';

// JSON-file backed store. The server is single-process, so all mutations go
// through a serialized lock (a promise chain). That makes the capacity /
// waitlist / promote operations atomic without a real database.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STATE = { users: {}, activities: {}, registrations: [], clubs: {} };

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this._read();
    // Promise chain used as a mutex: each op awaits the previous tail.
    this._tail = Promise.resolve();
  }

  _read() {
    const parse = (raw) => {
      const parsed = JSON.parse(raw);
      return {
        users: parsed.users || {},
        activities: parsed.activities || {},
        registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
        clubs: parsed.clubs || {},
      };
    };
    try {
      return parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (e) {
      // Primary missing/corrupt — try the newest backup before silently resetting.
      try {
        const recovered = parse(fs.readFileSync(`${this.filePath}.bak.1`, 'utf8'));
        console.error(`⚠️  ${this.filePath} 读取失败（${e.message}），已从 .bak.1 恢复。请人工检查！`);
        return recovered;
      } catch (e2) {
        console.error(`⚠️  ${this.filePath} 与 .bak.1 均不可用，以空状态启动：${e2.message}`);
        return structuredClone(DEFAULT_STATE);
      }
    }
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // Run a synchronous mutator transaction, then persist. Serialized.
  async txn(mutator) {
    const run = this._tail.then(() => {
      const result = mutator(this.state);
      this._persist();
      return result;
    });
    // keep the chain alive even if this txn throws
    this._tail = run.catch(() => {});
    return run;
  }

  // Read-only snapshot (no lock needed — JS is single-threaded and reads are atomic).
  snapshot() {
    return this.state;
  }

  // Rotate the in-memory state into `<file>.bak.1 .. .bak.<keep>`. Newest is
  // always .bak.1. Writes a tmp file + rename (atomic). Backs up the in-memory
  // state directly so a backup is always valid JSON regardless of disk state.
  backup(keep = 10) {
    if (keep < 1) return false;
    const oldest = `${this.filePath}.bak.${keep}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${this.filePath}.bak.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.bak.${i + 1}`);
    }
    const tmp = `${this.filePath}.bak.1.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, `${this.filePath}.bak.1`);
    return true;
  }
}

function newId(prefix) {
  return prefix + crypto.randomUUID();
}

module.exports = { Store, newId };
