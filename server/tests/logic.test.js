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

test('token sign/verify round-trips and rejects tampering', async () => {
  // Load auth after setting a known secret via env is tricky here; verify
  // functional correctness through the exported module using current config.
  const { sign, verify } = require('../src/auth');
  const t = sign({ openid: 'o123', iat: 1 });
  assert.equal(verify(t).openid, 'o123');
  assert.equal(verify(t + 'x'), null);
  assert.equal(verify('garbage'), null);
});
