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

test('each activity gets a short invite code; by-code lookup resolves it', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(
    store,
    { title: '二维码测试', startTime: '2099-01-01T10:00:00', capacity: 4 },
    'org'
  );
  assert.ok(act.code, 'code present');
  assert.match(act.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, '6 readable chars');

  const byCode = await logic.getActivityByCode(store, act.code);
  assert.equal(byCode.id, act.id);

  // a second activity gets a distinct code
  const act2 = await logic.createActivity(
    store,
    { title: '另一场', startTime: '2099-02-01T10:00:00', capacity: 4 },
    'org'
  );
  assert.notEqual(act.code, act2.code);
});

test('getActivityByCode rejects unknown codes', async () => {
  const store = tmpStore();
  await withError(404, logic.getActivityByCode(store, 'NOPE01'));
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

test('creator can delete their activity and its registrations; others cannot', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, {
    title: '删除',
    startTime: '2099-01-01T10:00:00',
    capacity: 2,
  }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  await withError(403, logic.deleteActivity(store, act.id, 'stranger'));
  await logic.deleteActivity(store, act.id, 'org');
  await withError(404, logic.getActivity(store, act.id));
  assert.equal(store.snapshot().registrations.filter((r) => r.activityId === act.id).length, 0);
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

test('myCreatedActivities returns only my activities, newest first', async () => {
  const store = tmpStore();
  // Inject distinct `now` so createdAt ordering is deterministic (Date.now()
  // can collide within the same millisecond for back-to-back creates).
  await logic.createActivity(store, { title: 'A', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org', 1000);
  await logic.createActivity(store, { title: 'B', startTime: '2099-02-01T10:00:00', capacity: 4 }, 'org', 2000);
  await logic.createActivity(store, { title: 'C', startTime: '2099-03-01T10:00:00', capacity: 4 }, 'other', 3000);
  const mine = await logic.myCreatedActivities(store, 'org');
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((a) => a.title), ['B', 'A']); // newest first
  assert.ok(mine[0].code, 'returns publicActivity shape with code');
});

test('updateProfile sets level/gender and rejects invalid enums', async () => {
  const store = tmpStore();
  const u = await logic.updateProfile(store, 'u1', { level: '中级', gender: '男' });
  assert.equal(u.level, '中级');
  assert.equal(u.gender, '男');
  await withError(400, logic.updateProfile(store, 'u1', { level: '大神' }));
  await withError(400, logic.updateProfile(store, 'u1', { gender: '其它' }));
});

test('roster entries include level and gender', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.updateProfile(store, 'u1', { level: '高级', gender: '女' });
  await logic.register(store, act.id, 'u1');
  const d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed[0].level, '高级');
  assert.equal(d.confirmed[0].gender, '女');
});

test('subscription credits: add then consume', async () => {
  const store = tmpStore();
  await logic.ensureUserExists(store, 'u1'); // ensure user exists
  await logic.addSubscription(store, 'u1', 'TPL_A');
  await logic.addSubscription(store, 'u1', 'TPL_A');
  assert.equal(await logic.consumeSubscription(store, 'u1', 'TPL_A'), true);
  assert.equal(await logic.consumeSubscription(store, 'u1', 'TPL_A'), true);
  assert.equal(await logic.consumeSubscription(store, 'u1', 'TPL_A'), false); // no credit left
});

test('updateActivity: creator edits fields; only creator allowed; 404 unknown', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: '原标题', startTime: '2099-01-01T10:00:00', capacity: 4, location: '旧地点' }, 'org');
  const updated = await logic.updateActivity(store, act.id, 'org', {
    title: '新标题', location: '新地点', capacity: 6, description: '说明',
  });
  assert.equal(updated.title, '新标题');
  assert.equal(updated.location, '新地点');
  assert.equal(updated.capacity, 6);
  assert.equal(updated.description, '说明');
  await withError(403, logic.updateActivity(store, act.id, 'stranger', { title: 'X' }));
  await withError(404, logic.updateActivity(store, 'act_nope', 'org', { title: 'X' }));
});

test('updateActivity: capacity cannot drop below current confirmed count', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 3 }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  await logic.register(store, act.id, 'u2', 2000); // 2 confirmed
  await withError(400, logic.updateActivity(store, act.id, 'org', { capacity: 1 })); // < confirmed
  const ok = await logic.updateActivity(store, act.id, 'org', { capacity: 2 }); // == confirmed OK
  assert.equal(ok.capacity, 2);
});

test('updateActivity: validates title and startTime', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await withError(400, logic.updateActivity(store, act.id, 'org', { title: '   ' }));
  await withError(400, logic.updateActivity(store, act.id, 'org', { startTime: 'not-a-date' }));
  const u = await logic.updateActivity(store, act.id, 'org', { startTime: '2099-08-01T09:00:00' });
  assert.equal(u.startTime, Date.parse('2099-08-01T09:00:00'));
});

test('createRecurring generates N activities spaced by stepDays, each with a unique code', async () => {
  const store = tmpStore();
  const list = await logic.createRecurring(
    store,
    { title: '周场', startTime: '2099-01-01T10:00:00', endTime: '2099-01-01T12:00:00', capacity: 4 },
    'org',
    { count: 3, stepDays: 7 }
  );
  assert.equal(list.length, 3);
  const t0 = Date.parse('2099-01-01T10:00:00');
  assert.equal(list[0].startTime, t0);
  assert.equal(list[1].startTime, t0 + 7 * 86400000);
  assert.equal(list[2].startTime, t0 + 14 * 86400000);
  // endTime tracks the same spacing
  const e0 = Date.parse('2099-01-01T12:00:00');
  assert.equal(list[2].endTime, e0 + 14 * 86400000);
  // distinct invite codes
  assert.equal(new Set(list.map((a) => a.code)).size, 3);
});

test('createRecurring validates count and stepDays', async () => {
  const store = tmpStore();
  const base = { title: 'x', startTime: '2099-01-01T10:00:00', capacity: 1 };
  await withError(400, logic.createRecurring(store, base, 'org', { count: 0, stepDays: 7 }));
  await withError(400, logic.createRecurring(store, base, 'org', { count: 13, stepDays: 7 })); // cap 12
  await withError(400, logic.createRecurring(store, base, 'org', { count: 2, stepDays: 0 }));
  // also surfaces base-field errors (title)
  await withError(400, logic.createRecurring(store, { startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org', { count: 2, stepDays: 7 }));
});

test('findActivitiesNeedingReminder picks open activities within the lead window', async () => {
  const store = tmpStore();
  const NOW = 1_000_000;
  const soon = await logic.createActivity(store, { title: 'soon', startTime: NOW + 3_600_000, capacity: 2 }, 'org', NOW); // +1h
  await logic.createActivity(store, { title: 'far', startTime: NOW + 100 * 3_600_000, capacity: 2 }, 'org', NOW); // +100h (>24h)
  await logic.createActivity(store, { title: 'past', startTime: NOW - 3_600_000, capacity: 2 }, 'org', NOW); // -1h
  const leadMs = 24 * 3_600_000;
  let ids = logic.findActivitiesNeedingReminder(store, { now: NOW, leadMs });
  assert.deepEqual(ids, [soon.id]);

  // mark soon as reminded → it drops out
  await logic.sendReminders(store, soon.id, 'TPL_REMIND', { now: NOW + 10 });
  ids = logic.findActivitiesNeedingReminder(store, { now: NOW, leadMs });
  assert.deepEqual(ids, []);
});

test('sendReminders consumes credits of registered users, returns targets, fires once', async () => {
  const store = tmpStore();
  const NOW = 5_000_000;
  const act = await logic.createActivity(store, { title: 'r', startTime: NOW + 3_600_000, capacity: 5 }, 'org', NOW);
  await logic.register(store, act.id, 'u1', NOW + 1);
  await logic.register(store, act.id, 'u2', NOW + 2);
  await logic.addSubscription(store, 'u1', 'TPL_REMIND'); // u1 has credit, u2 does not

  const t1 = await logic.sendReminders(store, act.id, 'TPL_REMIND', { now: NOW + 10 });
  assert.deepEqual(t1.map((t) => t.openid), ['u1']); // only the credited user

  const t2 = await logic.sendReminders(store, act.id, 'TPL_REMIND', { now: NOW + 11 });
  assert.deepEqual(t2, []); // already reminded → no-op
});

test('setAvatar persists avatarUrl on the user record', async () => {
  const store = tmpStore();
  const u = await logic.setAvatar(store, 'u1', '/avatars/u1.png');
  assert.equal(u.avatarUrl, '/avatars/u1.png');
  assert.equal(store.snapshot().users.u1.avatarUrl, '/avatars/u1.png');
  // survives an unrelated updateProfile (which must not clear it)
  const after = await logic.updateProfile(store, 'u1', { nickname: '新名' });
  assert.equal(after.avatarUrl, '/avatars/u1.png');
});

test('setFee sets activity.fee; rejects bad combos and non-creator', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  // total mode
  const a = await logic.setFee(store, act.id, 'org', { totalCents: 12000, splitBy: 'confirmed' });
  assert.equal(a.fee.totalCents, 12000);
  assert.equal(a.fee.splitBy, 'confirmed');
  // fixed mode
  const b = await logic.setFee(store, act.id, 'org', { perPersonCents: 3000, splitBy: 'confirmed' });
  assert.equal(b.fee.perPersonCents, 3000);
  assert.equal(b.fee.totalCents, null);
  // must choose exactly one of total/perPerson
  await withError(400, logic.setFee(store, act.id, 'org', { splitBy: 'confirmed' })); // neither
  await withError(400, logic.setFee(store, act.id, 'org', { totalCents: 1000, perPersonCents: 1000, splitBy: 'confirmed' })); // both
  await withError(400, logic.setFee(store, act.id, 'org', { totalCents: 1000, splitBy: 'wednesday' })); // bad splitBy
  // non-creator rejected
  await withError(403, logic.setFee(store, act.id, 'stranger', { perPersonCents: 1000, splitBy: 'confirmed' }));
  // clear fee with empty input
  const c = await logic.setFee(store, act.id, 'org', {});
  assert.equal(c.fee, null);
});

test('markPaid toggles a confirmed registrant; organizer only', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  const r = await logic.markPaid(store, act.id, 'org', 'u1', true);
  assert.equal(r.paid, true);
  assert.ok(r.paidAt);
  const r2 = await logic.markPaid(store, act.id, 'org', 'u1', false);
  assert.equal(r2.paid, false);
  assert.equal(r2.paidAt, null);
  await withError(403, logic.markPaid(store, act.id, 'u1', 'u1', true));
  await withError(404, logic.markPaid(store, act.id, 'org', 'ghost', true));
});

test('markAttend sets attended (true/false/null); organizer only', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  assert.equal((await logic.markAttend(store, act.id, 'org', 'u1', true)).attended, true);
  assert.equal((await logic.markAttend(store, act.id, 'org', 'u1', false)).attended, false);
  assert.equal((await logic.markAttend(store, act.id, 'org', 'u1', null)).attended, null);
  await withError(403, logic.markAttend(store, act.id, 'u1', 'u1', true));
  await withError(404, logic.markAttend(store, act.id, 'org', 'ghost', true));
});

test('enrichActivity computes per-person owedCents + feeSummary', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.register(store, act.id, 'u1', 1000);
  await logic.register(store, act.id, 'u2', 2000);
  await logic.register(store, act.id, 'u3', 3000); // 3 confirmed
  await logic.setFee(store, act.id, 'org', { totalCents: 9000, splitBy: 'confirmed' }); // 9000/3 = 3000 each
  let d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed[0].owedCents, 3000);
  assert.equal(d.feeSummary.totalOwedCents, 9000);
  assert.equal(d.feeSummary.totalPaidCents, 0);
  assert.equal(d.feeSummary.settled, false);

  await logic.markPaid(store, act.id, 'org', 'u1', true);
  d = await logic.getActivity(store, act.id);
  assert.equal(d.feeSummary.totalPaidCents, 3000);
  assert.equal(d.confirmed.find((x) => x.openid === 'u1').paid, true);

  // attended split: only attendees split the total
  await logic.markAttend(store, act.id, 'org', 'u1', true);
  await logic.markAttend(store, act.id, 'org', 'u2', true); // 2 attended
  await logic.setFee(store, act.id, 'org', { totalCents: 6000, splitBy: 'attended' }); // 6000/2 = 3000 each attendee
  d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed.find((x) => x.openid === 'u1').owedCents, 3000);
  assert.equal(d.confirmed.find((x) => x.openid === 'u3').owedCents, 0); // didn't attend → owes 0

  // fixed per-person mode
  await logic.setFee(store, act.id, 'org', { perPersonCents: 2500, splitBy: 'confirmed' });
  d = await logic.getActivity(store, act.id);
  assert.equal(d.confirmed[0].owedCents, 2500);
});

test('generateGroups: snake-draft balances level across N groups', () => {
  const confirmed = [
    { openid: 'a', nickname: 'A', level: '高级' },
    { openid: 'b', nickname: 'B', level: '高级' },
    { openid: 'c', nickname: 'C', level: '中级' },
    { openid: 'd', nickname: 'D', level: '中级' },
    { openid: 'e', nickname: 'E', level: '初级' },
    { openid: 'f', nickname: 'F', level: '初级' },
  ];
  const groups = logic.generateGroups(confirmed, { mode: 'groups', count: 2 });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((x) => x.openid), ['a', 'd', 'e']);
  assert.deepEqual(groups[1].map((x) => x.openid), ['b', 'c', 'f']);
  assert.equal(groups[0].reduce((s, x) => s + x.weight, 0), 9);
  assert.equal(groups[1].reduce((s, x) => s + x.weight, 0), 9);
});

test('generateGroups: pairs mode pairs strong with weak', () => {
  const confirmed = [
    { openid: 'a', level: '高级' },
    { openid: 'b', level: '中级' },
    { openid: 'c', level: '中级' },
    { openid: 'd', level: '初级' },
  ];
  const pairs = logic.generateGroups(confirmed, { mode: 'pairs' });
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0].map((x) => x.openid), ['a', 'd']);
  assert.deepEqual(pairs[1].map((x) => x.openid), ['b', 'c']);
});

test('generateGroups: empty level defaults to weight 2', () => {
  const confirmed = [{ openid: 'a', level: '' }, { openid: 'b', level: '高级' }];
  const pairs = logic.generateGroups(confirmed, { mode: 'pairs' });
  assert.equal(pairs[0][0].weight, 4);
  assert.equal(pairs[0][1].weight, 2);
});

test('attendanceStats aggregates confirmed/attended/noShow across organizer activities', async () => {
  const store = tmpStore();
  const a1 = await logic.createActivity(store, { title: 'A1', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org', 1000);
  const a2 = await logic.createActivity(store, { title: 'A2', startTime: '2099-02-01T10:00:00', capacity: 4 }, 'org', 2000);
  // u1: two confirmed, both attended
  await logic.register(store, a1.id, 'u1', 1100);
  await logic.register(store, a2.id, 'u1', 2100);
  await logic.markAttend(store, a1.id, 'org', 'u1', true);
  await logic.markAttend(store, a2.id, 'org', 'u1', true);
  // u2: one confirmed, no-show
  await logic.register(store, a1.id, 'u2', 1200);
  await logic.markAttend(store, a1.id, 'org', 'u2', false);
  // someone else's activity — must be excluded
  const other = await logic.createActivity(store, { title: 'X', startTime: '2099-03-01T10:00:00', capacity: 4 }, 'other', 3000);
  await logic.register(store, other.id, 'u1', 3100);

  const stats = logic.attendanceStats(store, 'org');
  const u1 = stats.find((s) => s.openid === 'u1');
  assert.equal(u1.confirmed, 2);
  assert.equal(u1.attended, 2);
  assert.equal(u1.noShow, 0);
  assert.equal(u1.rate, 1);
  const u2 = stats.find((s) => s.openid === 'u2');
  assert.equal(u2.confirmed, 1);
  assert.equal(u2.noShow, 1);
  assert.equal(u2.rate, 0);
  // sorted by attended desc → u1 first
  assert.equal(stats[0].openid, 'u1');
});

test('markPaid/markAttend reject waitlisted (non-confirmed) registrants', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 1 }, 'org');
  await logic.register(store, act.id, 'u1', 1000); // confirmed
  await logic.register(store, act.id, 'u2', 2000); // waitlist
  await withError(404, logic.markPaid(store, act.id, 'org', 'u2', true));
  await withError(404, logic.markAttend(store, act.id, 'org', 'u2', true));
  // confirmed still works
  assert.equal((await logic.markPaid(store, act.id, 'org', 'u1', true)).paid, true);
});

test('createActivity/updateActivity accept optional rules; validateRules', async () => {
  const store = tmpStore();
  const a = await logic.createActivity(
    store,
    { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { noShowBanDays: 7, allowedLevels: ['新手', '初级'] } },
    'org'
  );
  assert.equal(a.rules.noShowBanDays, 7);
  assert.deepEqual(a.rules.allowedLevels, ['新手', '初级']);
  const b = await logic.createActivity(store, { title: 'T2', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  assert.equal(b.rules, null);
  await withError(400, logic.createActivity(store, { title: 'X', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { noShowBanDays: 0 } }, 'org'));
  await withError(400, logic.createActivity(store, { title: 'X', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { allowedLevels: ['大神'] } }, 'org'));
  const c = await logic.createActivity(store, { title: 'Y', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { allowedLevels: [] } }, 'org');
  assert.equal(c.rules, null);
  const u = await logic.updateActivity(store, a.id, 'org', { rules: { noShowBanDays: 3 } });
  assert.equal(u.rules.noShowBanDays, 3);
  assert.equal(u.rules.allowedLevels, undefined);
  const u2 = await logic.updateActivity(store, a.id, 'org', { rules: null });
  assert.equal(u2.rules, null);
});

test('register enforces level restriction (allowedLevels)', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(
    store,
    { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { allowedLevels: ['新手', '初级'] } },
    'org'
  );
  await logic.updateProfile(store, 'u1', { level: '中级' });
  await withError(400, logic.register(store, act.id, 'u1', 1000)); // 中级 not allowed
  await logic.updateProfile(store, 'u2', { level: '初级' });
  assert.equal((await logic.register(store, act.id, 'u2', 2000)).status, 'confirmed'); // 初级 ok
  await withError(400, logic.register(store, act.id, 'u3', 3000)); // empty level blocked
});

test('register enforces no-show ban within window, same organizer only', async () => {
  const store = tmpStore();
  const DAY = 86400000;
  const T0 = 1_000_000_000; // a past activity's start time
  // organizer 'org' ran a past activity; u1 no-showed
  const past = await logic.createActivity(store, { title: 'past', startTime: T0, capacity: 4 }, 'org', 100);
  await logic.register(store, past.id, 'u1', T0 - DAY); // registered before start
  await logic.markAttend(store, past.id, 'org', 'u1', false); // marked absent

  // a NEW org activity with noShowBanDays=7, start far future
  const next = await logic.createActivity(store, { title: 'next', startTime: T0 + 365 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 200);
  // within 7-day window → BANNED
  await withError(400, logic.register(store, next.id, 'u1', T0 + 1 * DAY));
  // outside window → OK
  assert.equal((await logic.register(store, next.id, 'u1', T0 + 8 * DAY)).status, 'confirmed');

  // cross-organizer: u2 no-showed a DIFFERENT organizer's activity → not banned from org's
  const pastOther = await logic.createActivity(store, { title: 'pastOther', startTime: T0, capacity: 4 }, 'other', 300);
  await logic.register(store, pastOther.id, 'u2', T0 - DAY);
  await logic.markAttend(store, pastOther.id, 'other', 'u2', false);
  const next2 = await logic.createActivity(store, { title: 'next2', startTime: T0 + 365 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 400);
  assert.equal((await logic.register(store, next2.id, 'u2', T0 + 1 * DAY)).status, 'confirmed'); // not banned

  // attended === null (unsigned) does NOT count as no-show
  const past2 = await logic.createActivity(store, { title: 'past2', startTime: T0, capacity: 4 }, 'org', 500);
  await logic.register(store, past2.id, 'u3', T0 - DAY); // not marked attended
  const next3 = await logic.createActivity(store, { title: 'next3', startTime: T0 + 365 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 600);
  assert.equal((await logic.register(store, next3.id, 'u3', T0 + 1 * DAY)).status, 'confirmed');
});

test('validateRules: minLevel, cancelDeadlineHours, allowedGenders; level modes mutually exclusive', async () => {
  const store = tmpStore();
  const base = { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 4 };
  const a = await logic.createActivity(store, { ...base, rules: { minLevel: '中级' } }, 'org');
  assert.equal(a.rules.minLevel, '中级');
  const b = await logic.createActivity(store, { ...base, rules: { noShowBanDays: 7, cancelDeadlineHours: 2 } }, 'org');
  assert.equal(b.rules.cancelDeadlineHours, 2);
  const c = await logic.createActivity(store, { ...base, rules: { allowedGenders: ['女'] } }, 'org');
  assert.deepEqual(c.rules.allowedGenders, ['女']);
  await withError(400, logic.createActivity(store, { ...base, rules: { allowedLevels: ['新手'], minLevel: '中级' } }, 'org'));
  await withError(400, logic.createActivity(store, { ...base, rules: { minLevel: '大神' } }, 'org'));
  await withError(400, logic.createActivity(store, { ...base, rules: { allowedGenders: ['不公开'] } }, 'org'));
  await withError(400, logic.createActivity(store, { ...base, rules: { cancelDeadlineHours: 0 } }, 'org'));
  const d = await logic.createActivity(store, { ...base, rules: { allowedGenders: [] } }, 'org');
  assert.equal(d.rules, null);
});

test('register enforces minLevel and gender restrictions', async () => {
  const store = tmpStore();
  const actMin = await logic.createActivity(store, { title: 'min', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { minLevel: '中级' } }, 'org');
  await logic.updateProfile(store, 'u1', { level: '初级' });
  await withError(400, logic.register(store, actMin.id, 'u1', 1000)); // 初级 < 中级
  await logic.updateProfile(store, 'u2', { level: '高级' });
  assert.equal((await logic.register(store, actMin.id, 'u2', 2000)).status, 'confirmed'); // 高级 ≥ 中级
  await withError(400, logic.register(store, actMin.id, 'u3', 3000)); // empty level

  const actG = await logic.createActivity(store, { title: 'g', startTime: '2099-01-01T10:00:00', capacity: 4, rules: { allowedGenders: ['女'] } }, 'org');
  await logic.updateProfile(store, 'g1', { gender: '男' });
  await withError(400, logic.register(store, actG.id, 'g1', 1000)); // 男 blocked
  await logic.updateProfile(store, 'g2', { gender: '女' });
  assert.equal((await logic.register(store, actG.id, 'g2', 2000)).status, 'confirmed'); // 女 ok
  await logic.updateProfile(store, 'g3', { gender: '不公开' });
  await withError(400, logic.register(store, actG.id, 'g3', 3000)); // 不公开 blocked
});

test('late cancel (past cancelDeadline) marks attended=false and feeds the no-show ban', async () => {
  const store = tmpStore();
  const DAY = 86400000;
  const T0 = 2_000_000_000; // activity start
  const act = await logic.createActivity(
    store,
    { title: 'a', startTime: T0, capacity: 4, rules: { noShowBanDays: 7, cancelDeadlineHours: 2 } },
    'org', 100
  );
  await logic.register(store, act.id, 'u1', T0 - DAY); // registered before start
  // cancel AFTER deadline (T0-1h > T0-2h) → attended=false
  await logic.cancel(store, act.id, 'u1', T0 - 3600000);
  assert.equal(store.snapshot().registrations.find((r) => r.openid === 'u1').attended, false);

  // a NEW org activity with noShowBanDays=7; u1 registers after T0 → BANNED
  const next = await logic.createActivity(store, { title: 'next', startTime: T0 + 365 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 200);
  await withError(400, logic.register(store, next.id, 'u1', T0 + DAY));

  // cancelling BEFORE the deadline does NOT mark attended
  const act2 = await logic.createActivity(
    store,
    { title: 'a2', startTime: T0 + 10 * DAY, capacity: 4, rules: { noShowBanDays: 7, cancelDeadlineHours: 2 } },
    'org', 300
  );
  await logic.register(store, act2.id, 'u2', T0 + 9 * DAY);
  await logic.cancel(store, act2.id, 'u2', T0 + 10 * DAY - 5 * 3600000); // 5h before start > 2h deadline ⇒ before deadline
  assert.equal(store.snapshot().registrations.find((r) => r.openid === 'u2').attended, undefined);

  // no cancelDeadlineHours ⇒ cancel never marks attended
  const act3 = await logic.createActivity(store, { title: 'a3', startTime: T0 + 20 * DAY, capacity: 4, rules: { noShowBanDays: 7 } }, 'org', 400);
  await logic.register(store, act3.id, 'u3', T0 + 19 * DAY);
  await logic.cancel(store, act3.id, 'u3', T0 + 20 * DAY - 3600000); // late, but no deadline configured
  assert.equal(store.snapshot().registrations.find((r) => r.openid === 'u3').attended, undefined);
});

test('enrichActivity defaults unmarked attendees to 到场 after start, 未签 before', async () => {
  const store = tmpStore();
  // future activity: unmarked → 未签 (null)
  const fut = await logic.createActivity(store, { title: 'fut', startTime: '2099-01-01T10:00:00', capacity: 4 }, 'org');
  await logic.register(store, fut.id, 'u1', 1000);
  assert.equal((await logic.getActivity(store, fut.id)).confirmed[0].attended, null);

  // past activity: can't register via API (past), so seed a confirmed reg directly
  const past = await logic.createActivity(store, { title: 'past', startTime: '2000-01-01T10:00:00', capacity: 4 }, 'org');
  await store.txn((state) => {
    state.registrations.push({ id: 'r1', activityId: past.id, openid: 'u2', status: 'confirmed', createdAt: 1, cancelledAt: null });
  });
  assert.equal((await logic.getActivity(store, past.id)).confirmed[0].attended, true); // default 到场
  // explicit 缺 (false) still respected
  await store.txn((state) => {
    state.registrations.find((r) => r.id === 'r1').attended = false;
  });
  assert.equal((await logic.getActivity(store, past.id)).confirmed[0].attended, false);
});

test('generateRotation: structure + feasibility + no-2-rests (feasible) + fairness', () => {
  const mk = (id, level) => ({ openid: id, nickname: id, level });
  const ps = Array.from({ length: 16 }, (_, i) => mk('u' + i, ['新手', '初级', '中级', '高级'][i % 4]));
  const res = logic.generateRotation(ps, { courts: 2, rounds: 4, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(res.schedule.length, 4);
  res.schedule.forEach((round) => {
    assert.equal(round.length, 2);
    round.forEach((court) => assert.equal(court.length, 4));
  });
  const restRounds = {};
  ps.forEach((p) => (restRounds[p.openid] = []));
  res.resting.forEach((ids, r) => ids.forEach((id) => restRounds[id].push(r)));
  Object.entries(restRounds).forEach(([id, rs]) => {
    for (let i = 1; i < rs.length; i++) assert.ok(rs[i] !== rs[i - 1] + 1, id + ' rested 2 in a row');
  });
  const played = {};
  res.schedule.forEach((round) => round.forEach((c) => c.forEach((p) => (played[p.openid] = (played[p.openid] || 0) + 1))));
  const counts = Object.values(played);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'unfair: ' + counts.join(','));
});

test('generateRotation: relaxes no-2-rests when infeasible (players > 8*courts)', () => {
  const mk = (id) => ({ openid: id, nickname: id, level: '中级' });
  const ps = Array.from({ length: 20 }, (_, i) => mk('u' + i));
  const res = logic.generateRotation(ps, { courts: 1, rounds: 3, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(res.schedule.length, 3);
  res.schedule.forEach((round) => {
    assert.equal(round.length, 1);
    assert.equal(round[0].length, 4);
  });
});

test('generateRotation: 400 when too few players to fill courts', () => {
  const ps = Array.from({ length: 5 }, (_, i) => ({ openid: 'u' + i, level: '中级' }));
  assert.throws(() => logic.generateRotation(ps, { courts: 2, rounds: 2 }), (e) => e.statusCode === 400);
});

test('generateRotation: homogeneous tiers courts by level', () => {
  const mk = (id, lv) => ({ openid: id, level: lv });
  const ps = [mk('a', '高级'), mk('b', '高级'), mk('c', '中级'), mk('d', '中级'), mk('e', '初级'), mk('f', '初级'), mk('g', '新手'), mk('h', '新手')];
  const w = (lv) => ({ 新手: 1, 初级: 2, 中级: 3, 高级: 4 }[lv]);
  const hom = logic.generateRotation(ps, { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] });
  const top0 = Math.min(...hom.schedule[0][0].map((p) => w(p.level)));
  const top1 = Math.max(...hom.schedule[0][1].map((p) => w(p.level)));
  assert.ok(top0 >= top1, 'homogeneous should tier courts');
});

test('generateRotation: fixed pairs end up on the same court', () => {
  const mk = (id) => ({ openid: id, level: '中级' });
  const ps = Array.from({ length: 8 }, (_, i) => mk('u' + i));
  const res = logic.generateRotation(ps, { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [['u0', 'u5']] });
  const courtOf = {};
  res.schedule[0].forEach((court, ci) => court.forEach((p) => (courtOf[p.openid] = ci)));
  assert.equal(courtOf['u0'], courtOf['u5'], 'fixed pair reunited');
});

test('setRotation stores + clearRotation removes; creator only; pool = attended', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  for (let i = 0; i < 10; i++) await logic.register(store, act.id, 'u' + i, 1000 + i);
  for (let i = 0; i < 10; i++) await logic.markAttend(store, act.id, 'org', 'u' + i, i < 8); // u0..u7 attended, u8/u9 absent
  await withError(403, logic.setRotation(store, act.id, 'stranger', { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] }));
  const r = await logic.setRotation(store, act.id, 'org', { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(r.rotation.schedule.length, 1);
  assert.equal(r.rotation.schedule[0][0].length, 4);
  const d = await logic.getActivity(store, act.id);
  assert.ok(d.rotation && d.rotation.schedule.length === 1);
  const ids = new Set();
  d.rotation.schedule.forEach((rd) => rd.forEach((c) => c.forEach((p) => ids.add(p.openid))));
  assert.ok(!ids.has('u8') && !ids.has('u9')); // absent excluded from pool
  await logic.clearRotation(store, act.id, 'org');
  assert.equal((await logic.getActivity(store, act.id)).rotation, null);
  await withError(403, logic.clearRotation(store, act.id, 'stranger'));
});

test('generateRotation: matchFormat forms one format-court when enough of the gender', () => {
  const mk = (id, g, lv) => ({ openid: id, nickname: id, gender: g, level: lv });
  const ps = [];
  for (let i = 0; i < 8; i++) ps.push(mk('m' + i, '男', ['高级', '中级', '初级', '新手'][i % 4]));
  for (let i = 0; i < 8; i++) ps.push(mk('f' + i, '女', ['高级', '中级', '初级', '新手'][i % 4]));

  const womens = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'womens' });
  assert.equal(womens.schedule[0][0].filter((p) => p.gender === '女').length, 4, 'womens court[0] all women');

  const mens = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'mens' });
  assert.equal(mens.schedule[0][0].filter((p) => p.gender === '男').length, 4, 'mens court[0] all men');

  const mixed = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'mixed' });
  const c0 = mixed.schedule[0][0];
  assert.equal(c0.filter((p) => p.gender === '男').length, 2, 'mixed court[0] 2 men');
  assert.equal(c0.filter((p) => p.gender === '女').length, 2, 'mixed court[0] 2 women');

  const anyR = logic.generateRotation(ps, { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [] });
  assert.equal(anyR.schedule[0][0].length, 4); // default 'any' → 4 players, not gender-constrained
});

test('generateRotation: matchFormat falls back to level-based when gender insufficient', () => {
  const mk = (id, g) => ({ openid: id, nickname: id, gender: g, level: '中级' });
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(mk('m' + i, '男'));
  for (let i = 0; i < 2; i++) ps.push(mk('f' + i, '女'));
  const r = logic.generateRotation(ps, { courts: 2, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'womens' });
  assert.equal(r.schedule[0].length, 2);
  r.schedule[0].forEach((c) => assert.equal(c.length, 4));
  // only 2 women total ⇒ no all-women court ⇒ each court has a man (proves format didn't force)
  r.schedule[0].forEach((c) => assert.ok(c.some((p) => p.gender === '男'), 'each court has a man (no forced womens court)'));
});

test('setRotation persists matchFormat + pool carries gender', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  for (let i = 0; i < 16; i++) {
    await logic.register(store, act.id, 'u' + i, 1000 + i);
    await logic.updateProfile(store, 'u' + i, { gender: i % 2 === 0 ? '男' : '女', level: '中级' });
  }
  const r = await logic.setRotation(store, act.id, 'org', { courts: 4, rounds: 1, levelMode: 'homogeneous', fixedPairs: [], matchFormat: 'womens' });
  assert.equal(r.rotation.matchFormat, 'womens');
  const c0 = r.rotation.schedule[0][0];
  assert.equal(c0.filter((p) => p.gender === '女').length, 4, 'womens court formed from persisted pool');
  const r2 = await logic.setRotation(store, act.id, 'org', { courts: 4, rounds: 1, levelMode: 'homogeneous' });
  assert.equal(r2.rotation.matchFormat, 'any');
});

test('assignOneRound: selects + assigns one round, updates games/lastRest', () => {
  const mk = (id, lv) => ({ openid: id, nickname: id, level: lv });
  const ps = []; for (let i = 0; i < 16; i++) ps.push(mk('u' + i, ['新手','初级','中级','高级'][i % 4]));
  const games = {}; ps.forEach((p) => (games[p.openid] = 0));
  const lastRest = {}; ps.forEach((p) => (lastRest[p.openid] = false));
  const r = logic.assignOneRound(ps, { courts: 2, levelMode: 'homogeneous', matchFormat: 'any', games, lastRest });
  assert.equal(r.courts.length, 2);
  r.courts.forEach((c) => assert.equal(c.length, 4));
  assert.equal(r.resting.length, 8);
  r.courts.flat().forEach((p) => assert.equal(r.games[p.openid], 1));
  r.resting.forEach((id) => assert.equal(r.lastRest[id], true));
  assert.throws(() => logic.assignOneRound(ps.slice(0, 5), { courts: 2, levelMode: 'homogeneous', matchFormat: 'any', games, lastRest }), (e) => e.statusCode === 400);
});

test('assignOneRound: no-consecutive-rest (forced from lastRest)', () => {
  const mk = (id) => ({ openid: id, nickname: id, level: '中级' });
  const ps = []; for (let i = 0; i < 16; i++) ps.push(mk('u' + i));
  const games = {}; ps.forEach((p) => (games[p.openid] = 0));
  const lastRest = {}; ps.forEach((p) => (lastRest[p.openid] = false));
  for (let i = 0; i < 8; i++) lastRest['u' + i] = true;
  const r = logic.assignOneRound(ps, { courts: 2, levelMode: 'homogeneous', matchFormat: 'any', games, lastRest });
  r.resting.forEach((id) => assert.ok(Number(id.slice(1)) >= 8, 'previous rester not resting again: ' + id));
});

test('session: start + assign + clear; creator only; pool = confirmed', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  for (let i = 0; i < 16; i++) {
    await logic.register(store, act.id, 'u' + i, 1000 + i);
    await logic.updateProfile(store, 'u' + i, { level: ['新手','初级','中级','高级'][i % 4], gender: i % 2 === 0 ? '男' : '女' });
  }
  await withError(403, logic.startSession(store, act.id, 'stranger', { courts: 2, levelMode: 'homogeneous', matchFormat: 'any' }));
  const s = await logic.startSession(store, act.id, 'org', { courts: 2, levelMode: 'homogeneous', matchFormat: 'any' });
  assert.equal(s.session.currentRound, 0);
  assert.equal(s.session.rounds.length, 0);
  const present = Array.from({ length: 16 }, (_, i) => 'u' + i);
  const r0 = await logic.assignSession(store, act.id, 'org', { present });
  assert.equal(r0.round.courts.length, 2);
  assert.equal(r0.session.currentRound, 1);
  // late arrival: round 1 only 12 present (u0..u3 "late")
  const present1 = Array.from({ length: 12 }, (_, i) => 'u' + (i + 4));
  const r1 = await logic.assignSession(store, act.id, 'org', { present: present1 });
  assert.equal(r1.round.courts.length, 2);
  assert.equal(r1.session.currentRound, 2);
  assert.equal(r1.session.games['u0'], 1); // u0 played round 0 but not round 1
  await withError(400, logic.assignSession(store, act.id, 'org', { present: ['u0', 'u1'] }));
  await logic.clearSession(store, act.id, 'org');
  assert.equal((await logic.getActivity(store, act.id)).session, null);
  await withError(403, logic.clearSession(store, act.id, 'stranger'));
});

test('setCurrentRound + undoSession + setSessionCourts', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 20 }, 'org');
  for (let i = 0; i < 16; i++) await logic.register(store, act.id, 'u' + i, 1000 + i);
  await logic.setRotation(store, act.id, 'org', { courts: 2, rounds: 3, levelMode: 'homogeneous', fixedPairs: [] });
  const cr = await logic.setCurrentRound(store, act.id, 'org', 1);
  assert.equal(cr.rotation.currentRound, 1);
  await withError(403, logic.setCurrentRound(store, act.id, 'stranger', 0));
  await logic.startSession(store, act.id, 'org', { courts: 2, levelMode: 'homogeneous', matchFormat: 'any' });
  const present = Array.from({ length: 16 }, (_, i) => 'u' + i);
  await logic.assignSession(store, act.id, 'org', { present });
  assert.equal((await logic.getActivity(store, act.id)).session.currentRound, 1);
  const undone = await logic.undoSession(store, act.id, 'org');
  assert.equal(undone.session.currentRound, 0);
  assert.equal(undone.session.rounds.length, 0);
  assert.equal(undone.session.games['u0'], 0);
  await withError(400, logic.undoSession(store, act.id, 'org'));
  await withError(403, logic.undoSession(store, act.id, 'stranger'));
  const sc = await logic.setSessionCourts(store, act.id, 'org', 3);
  assert.equal(sc.session.courts, 3);
  await withError(403, logic.setSessionCourts(store, act.id, 'stranger', 2));
});

test('proxyRegister: creator adds guest by nickname; forceRemove: creator kicks', async () => {
  const store = tmpStore();
  const act = await logic.createActivity(store, { title: 'T', startTime: '2099-01-01T10:00:00', capacity: 2 }, 'org');
  await logic.register(store, act.id, 'u1', 1000); // confirmed
  // non-creator proxy → 403
  await withError(403, logic.proxyRegister(store, act.id, 'stranger', { nickname: '嘉宾' }));
  // creator adds guest
  const g = await logic.proxyRegister(store, act.id, 'org', { nickname: '小王', level: '中级', gender: '男' });
  assert.equal(g.status, 'confirmed');
  assert.equal(g.nickname, '小王');
  // now capacity 2/2 full → next proxy goes waitlist
  const g2 = await logic.proxyRegister(store, act.id, 'org', { nickname: '小李' });
  assert.equal(g2.status, 'waitlist');
  // forceRemove non-creator → 403
  await withError(403, logic.forceRemove(store, act.id, 'stranger', g.openid));
  // creator kicks the confirmed guest → waitlister promotes
  const removed = await logic.forceRemove(store, act.id, 'org', g.openid);
  assert.equal(removed.cancelled, true);
  assert.equal(removed.promoted.openid, g2.openid); // 小李 auto-promoted
  // unknown target → 404
  await withError(404, logic.forceRemove(store, act.id, 'org', 'ghost'));
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
