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
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        users: parsed.users || {},
        activities: parsed.activities || {},
        registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
        clubs: parsed.clubs || {},
      };
    } catch (e) {
      return structuredClone(DEFAULT_STATE);
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
}

function newId(prefix) {
  return prefix + crypto.randomUUID();
}

module.exports = { Store, newId };
