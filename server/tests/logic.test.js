'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { Store } = require('../src/store');
const logic = require('../src/logic');

function tmpStore() {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bm-test-')),
    'db.json'
  );
  return new Store(file);
}

function withError(status, run) {
  return assert.rejects(run, (err) => err.statusCode === status);
}

test('register fills capacity, then waitlists in order', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '周二打球',
    startTime: '2099-01-01T10:00:00',
    capacity: 2,
  }, 'org');

  const a = await logic.register(store, act.id, 'u1', 1000);
  const b = await logic.register(store, act.id, 'u2', 2000);
  const c = await logic.register(store, act.id, 'u3', 3000);
  assert.equal(a.status, 'confirmed');
  assert.equal(b.status, 'confirmed');
  assert.equal(c.status, 'waitlist');

  const detail = await logic.getActivity(store, act.id, 'u3');
  assert.equal(detail.confirmedCount, 2);
  assert.equal(detail.waitlistCount, 1);
  assert.deepEqual(detail.confirmed.map((x) => x.openid), ['u1', 'u2']);
  assert.equal(detail.myStatus, 'waitlist');
});

test('cancelling a confirmed spot promotes the earliest waitlister', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '满员测试',
    startTime: '2099-01-01T10:00:00',
    capacity: 1,
  }, 'org');

  await logic.register(store, act.id, 'u1', 1000);
  await logic.register(store, act.id, 'u2', 2000); // waitlist
  await logic.register(store, act.id, 'u3', 3000); // waitlist

  const res = await logic.cancel(store, act.id, 'u1', 5000);
  assert.equal(res.cancelled, true);
  assert.equal(res.promoted.openid, 'u2'); // FIFO promotion

  const detail = await logic.getActivity(store, act.id);
  assert.deepEqual(
    detail.confirmed.map((x) => x.openid),
    ['u2']
  );
  assert.deepEqual(
    detail.waitlist.map((x) => x.openid),
    ['u3']
  );
});

test('cancelling a waitlisted spot promotes nobody', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '候补取消',
    startTime: '2099-01-01T10:00:00',
    capacity: 1,
  }, 'org');

  await logic.register(store, act.id, 'u1', 1000);
  await logic.register(store, act.id, 'u2', 2000); // waitlist
  const res = await logic.cancel(store, act.id, 'u2', 3000);
  assert.equal(res.promoted, null);

  const detail = await logic.getActivity(store, act.id);
  assert.equal(detail.confirmedCount, 1);
  assert.equal(detail.waitlistCount, 0);
});

test('cannot register twice for the same activity', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '重复',
    startTime: '2099-01-01T10:00:00',
    capacity: 5,
  }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  await withError(409, logic.register(store, act.id, 'u1', 2000));
});

test('re-registering after cancelling works', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '再次报名',
    startTime: '2099-01-01T10:00:00',
    capacity: 2,
  }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  await logic.cancel(store, act.id, 'u1', 2000);
  const again = await logic.register(store, act.id, 'u1', 3000);
  assert.equal(again.status, 'confirmed');
});

test('past activity rejects registration', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '已过期',
    startTime: '2000-01-01T10:00:00',
    capacity: 2,
  }, 'org');
  await withError(400, logic.register(store, act.id, 'u1'));
});

test('createActivity validates inputs', async () => {
  const store = tmpStore();
  await withError(400, logic.createActivity(store, { title: '', startTime: '2099', capacity: 1 }, 'o'));
  await withError(400, logic.createActivity(store, { title: 'x', startTime: '2099', capacity: 0 }, 'o'));
  await withError(400, logic.createActivity(store, { title: 'x', capacity: 1 }, 'o'));
});

test('only the creator can close an activity', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '权限',
    startTime: '2099-01-01T10:00:00',
    capacity: 2,
  }, 'org');
  await withError(403, logic.setActivityStatus(store, act.id, 'closed', 'someone-else'));
  const closed = await logic.setActivityStatus(store, act.id, 'closed', 'org');
  assert.equal(closed.status, 'closed');
  // closed activity rejects registration
  await withError(400, logic.register(store, act.id, 'u1'));
});

test('myRegistrations returns only active signups', async () => {
  const store = tmpStore();
  const a = await logic.createActivity(store, { title: 'A', startTime: '2099-01-01T10:00:00', capacity: 5 }, 'org');
  const b = await logic.createActivity(store, { title: 'B', startTime: '2099-02-01T10:00:00', capacity: 5 }, 'org');
  await logic.register(store, a.id, 'u1', 1000);
  await logic.register(store, b.id, 'u1', 2000);
  await logic.cancel(store, a.id, 'u1', 3000);
  const mine = await logic.myRegistrations(store, 'u1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].activity.id, b.id);
});

test('token sign/verify round-trips and rejects tampering', async () => {
  // Load auth after setting a known secret via env is tricky here; verify
  // functional correctness through the exported module using current config.
  const { sign, verify } = require('../src/auth');
  const t = sign({ openid: 'o123', iat: 1 });
  assert.equal(verify(t).openid, 'o123');
  assert.equal(verify(t + 'x'), null);
  assert.equal(verify('garbage'), null);
});
