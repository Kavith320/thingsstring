const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.MAIL_TRANSPORT = "json";
process.env.APP_URL = "https://app.example.com";

const { ObjectId } = require("mongoose").mongo;
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");
const { processOutbox } = require("../src/email/outbox");
const { sentInMemory } = require("../src/email/mailer");

let db;
let app;
let runFlow;

before(async () => {
  db = await startDb();
  app = await startApp();
  ({ runFlow } = require("../src/automation/flowJobs"));
});
after(async () => {
  await app.close();
  await stopDb();
});
beforeEach(async () => {
  await resetDb(db);
  sentInMemory.length = 0;
  delete process.env.MAIL_DAILY_LIMIT;
  delete process.env.MAIL_RESERVED;
});

async function deliver() {
  await processOutbox(db);
  return sentInMemory.splice(0);
}
async function verified(opts) {
  const u = await createUser(app.api, opts);
  await db.collection("users").updateOne({ _id: new ObjectId(u.id) }, { $set: { emailVerified: true } });
  await deliver();
  return u;
}
const call = (u, method, path, body) => app.api(method, path, { token: u.token, body });
const tokenFrom = (mail) => /invite\?token=([A-Za-z0-9_-]+)/.exec(mail.text)[1];

/** Owner invites `email` as `role`; returns the raw token from the email. */
async function invite(owner, deviceId, email, role) {
  const r = await call(owner, "POST", `/api/devices/${deviceId}/invites`, { email, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const mails = await deliver();
  const mail = mails.find((m) => m.to[0].address === email);
  assert.ok(mail, "invitation email sent");
  return { token: tokenFrom(mail), mail };
}
async function share(owner, deviceId, member, role) {
  const { token } = await invite(owner, deviceId, member.email, role);
  const r = await call(member, "POST", "/api/invites/accept", { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

/* ───────────────────────── Invites ───────────────────────── */

test("invite an existing user: email, lookup, accept; they see only the shared device", async () => {
  const owner = await verified();
  const bob = await verified();
  await createDevice(db, "d1", owner.id);
  await createDevice(db, "private", owner.id);
  await call(owner, "PATCH", "/api/devices/d1/ui", { displayName: "Barn Pump" });

  const { token, mail } = await invite(owner, "d1", bob.email, "operator");
  assert.match(mail.subject, /shared "Barn Pump" with you/);
  assert.match(mail.html, /Accept invitation/);

  const look = await app.api("POST", "/api/invites/lookup", { body: { token } });
  assert.equal(look.status, 200);
  assert.equal(look.body.invite.deviceName, "Barn Pump");
  assert.equal(look.body.invite.role, "operator");
  assert.equal(look.body.invite.accountExists, true);

  assert.equal((await call(bob, "POST", "/api/invites/accept", { token })).status, 200);
  assert.equal((await call(bob, "POST", "/api/invites/accept", { token })).status, 400, "single use");

  const list = await call(bob, "GET", "/api/devices");
  assert.deepEqual(list.body.devices.map((d) => d.deviceId), ["d1"], "only the shared device");
  assert.equal(list.body.devices[0].role, "operator");
  assert.equal(list.body.devices[0].sharedBy.email, owner.email);
  assert.equal((await call(bob, "GET", "/api/devices/private")).status, 404);

  assert.equal((await call(bob, "POST", "/api/devices/d1/control", { actuators: { relay1: { state: "ON" } } })).status, 200, "operator can switch");
  const sched = await call(bob, "POST", "/api/schedules/devices/d1/schedules", {
    name: "x", cron: "0 8 * * *", timezone: "UTC", actions: [{ actuator: "relay1", set: { state: "ON" } }],
  });
  assert.equal(sched.status, 403, "operator can't schedule");
  assert.equal(sched.body.error.includes("manager"), true);
});

test("a brand-new person signs up from the invite link: verified, device appears, no verification email", async () => {
  const owner = await verified();
  await createDevice(db, "d1", owner.id);
  const { token, mail } = await invite(owner, "d1", "newbie@example.com", "viewer");
  assert.match(mail.html, /Create account &amp; accept/);
  assert.equal((await app.api("POST", "/api/invites/lookup", { body: { token } })).body.invite.accountExists, false);

  const reg = await app.api("POST", "/api/auth/register", {
    body: { name: "Newbie", email: "newbie@example.com", password: "password123", inviteToken: token },
  });
  assert.equal(reg.status, 201);
  assert.deepEqual(reg.body.invite, { deviceId: "d1", role: "viewer" });
  assert.equal(reg.body.user.emailVerified, true);
  assert.equal((await deliver()).length, 0, "no verification email needed");

  const list = await app.api("GET", "/api/devices", { token: reg.body.token });
  assert.equal(list.body.devices[0].role, "viewer");
});

test("an invite can't be taken by another account, and unverified users can't invite", async () => {
  const owner = await verified();
  const eve = await verified();
  const unverified = await createUser(app.api);
  await createDevice(db, "d1", owner.id);
  await createDevice(db, "d2", unverified.id);

  const { token } = await invite(owner, "d1", "bob@example.com", "operator");
  const r = await call(eve, "POST", "/api/invites/accept", { token });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /bob@example\.com/);

  const reg = await app.api("POST", "/api/auth/register", { body: { name: "E", email: "eve2@example.com", password: "password123", inviteToken: token } });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.invite, undefined, "token for another email is ignored at sign-up");
  assert.equal(reg.body.user.emailVerified, false);

  const blocked = await call(unverified, "POST", "/api/devices/d2/invites", { email: "x@example.com", role: "viewer" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "EMAIL_NOT_VERIFIED");
});

test("in-app invitations: listed and accepted by verified users only", async () => {
  const owner = await verified();
  const bob = await verified();
  await createDevice(db, "d1", owner.id);
  await invite(owner, "d1", bob.email, "viewer");

  const mine = await call(bob, "GET", "/api/invites");
  assert.equal(mine.body.count, 1);
  const id = mine.body.invites[0].id;

  await db.collection("users").updateOne({ _id: new ObjectId(bob.id) }, { $set: { emailVerified: false } });
  assert.equal((await call(bob, "POST", `/api/invites/${id}/accept`)).status, 403);
  await db.collection("users").updateOne({ _id: new ObjectId(bob.id) }, { $set: { emailVerified: true } });
  assert.equal((await call(bob, "POST", `/api/invites/${id}/accept`)).status, 200);
  assert.equal((await call(bob, "GET", "/api/devices/d1")).body.device.role, "viewer");
});

/* ───────────────────────── Roles ───────────────────────── */

test("role rules: viewers watch, managers manage operators/viewers only, owners manage all", async () => {
  const owner = await verified();
  const mgr = await verified();
  const mgr2 = await verified();
  const viewer = await verified();
  await createDevice(db, "d1", owner.id);
  await share(owner, "d1", mgr, "manager");
  await share(owner, "d1", mgr2, "manager");
  await share(mgr, "d1", viewer, "viewer");

  // viewer
  assert.equal((await call(viewer, "GET", "/api/devices/d1/telemetry?limit=5")).status, 200);
  const ctl = await call(viewer, "POST", "/api/devices/d1/control", { actuators: { relay1: { state: "ON" } } });
  assert.equal(ctl.status, 403);
  assert.equal(ctl.body.code, "DEVICE_ROLE_TOO_LOW");
  assert.equal((await call(viewer, "GET", "/api/devices/d1/members")).status, 403);
  assert.equal((await call(viewer, "GET", "/api/devices/d1/activity")).status, 403);

  // manager
  assert.equal((await call(mgr, "POST", "/api/devices/d1/invites", { email: "m3@example.com", role: "manager" })).status, 403);
  assert.equal((await call(mgr, "DELETE", `/api/devices/d1/members/${mgr2.id}`)).status, 403, "manager can't remove a manager");
  assert.equal((await call(mgr, "PATCH", `/api/devices/d1/members/${viewer.id}`, { role: "operator" })).status, 200);
  const members = await call(mgr, "GET", "/api/devices/d1/members");
  assert.equal(members.body.owner.email, owner.email);
  assert.equal(members.body.members.length, 3);

  // owner
  assert.equal((await call(owner, "PATCH", `/api/devices/d1/members/${mgr2.id}`, { role: "viewer" })).status, 200);
  assert.equal((await call(owner, "DELETE", `/api/devices/d1/members/${owner.id}`)).status, 400, "owner can't leave");
});

test("removing a member cuts access everywhere and pauses their schedules and rules", async () => {
  const owner = await verified();
  const mgr = await verified();
  await createDevice(db, "d1", owner.id);
  await share(owner, "d1", mgr, "manager");

  const s = await call(mgr, "POST", "/api/schedules/devices/d1/schedules", {
    name: "Morning", cron: "0 8 * * *", timezone: "UTC", actions: [{ actuator: "relay1", set: { state: "ON" } }],
  });
  assert.equal(s.status, 201);
  const f = await call(mgr, "POST", "/api/automation/flows", {
    name: "Hot", deviceId: "d1", metricPath: "data.temp", condition: { operator: ">", value: 30 }, action: { actuatorKey: "relay1", setValue: true },
  });
  assert.equal(f.status, 201);
  await call(mgr, "PATCH", "/api/devices/d1/ui", { displayName: "Mgr's name" });
  await call(mgr, "PUT", "/api/devices/d1/alerts", { offline: { enabled: true, afterMin: 5 } });

  assert.equal((await call(owner, "GET", "/api/schedules/devices/d1/schedules")).body.count, 1, "owner sees the manager's schedule");
  assert.equal((await call(owner, "GET", "/api/devices/d1/ui")).body.ui.displayName, null, "personal settings stay personal");

  assert.equal((await call(owner, "DELETE", `/api/devices/d1/members/${mgr.id}`)).status, 200);
  assert.equal((await call(mgr, "GET", "/api/devices/d1")).status, 404);
  assert.equal((await call(mgr, "GET", "/api/devices")).body.count, 0);
  const sched = await db.collection("device_schedules").findOne({});
  assert.equal(sched.enabled, false);
  assert.equal(sched.disabledReason, "access removed");
  assert.equal((await db.collection("automation_flows").findOne({})).enabled, false);
  assert.equal(await db.collection("device_alerts").countDocuments(), 0);
  assert.equal(await db.collection("device_ui").countDocuments({ user_id: mgr.id }), 0);

  // even if re-enabled directly, the rule can't run without access
  await db.collection("automation_flows").updateOne({}, { $set: { enabled: true } });
  await runFlow(db, f.body.flow._id);
  const log = await db.collection("automation_flow_logs").find().sort({ _id: -1 }).next();
  assert.equal(log.reason, "flow owner has no access to the device");
});

test("members can leave; a re-invite replaces the old link", async () => {
  const owner = await verified();
  const bob = await verified();
  await createDevice(db, "d1", owner.id);
  const first = await invite(owner, "d1", bob.email, "viewer");
  const second = await invite(owner, "d1", bob.email, "operator");
  assert.equal((await call(bob, "POST", "/api/invites/accept", { token: first.token })).status, 400, "old link revoked");
  assert.equal((await call(bob, "POST", "/api/invites/accept", { token: second.token })).status, 200);

  assert.equal((await call(bob, "DELETE", `/api/devices/d1/members/${bob.id}`)).status, 200);
  assert.equal((await call(bob, "GET", "/api/devices/d1")).status, 404);
});

/* ───────────────────────── Activity log ───────────────────────── */

test("activity log records who did what, including automations", async () => {
  const owner = await verified();
  const op = await verified();
  await createDevice(db, "d1", owner.id);
  await share(owner, "d1", op, "operator");
  await call(op, "POST", "/api/devices/d1/control", { actuators: { relay1: { state: "ON" } } });
  await call(owner, "POST", "/api/schedules/devices/d1/schedules", {
    name: "Night", cron: "0 20 * * *", timezone: "UTC", actions: [{ actuator: "relay1", set: { state: "OFF" } }],
  });
  const f = await call(owner, "POST", "/api/automation/flows", {
    name: "Hot", deviceId: "d1", metricPath: "data.temp", condition: { operator: ">", value: 30 }, action: { actuatorKey: "relay1", setValue: true },
  });
  await runFlow(db, f.body.flow._id);

  const r = await call(owner, "GET", "/api/devices/d1/activity");
  assert.equal(r.status, 200);
  const actions = r.body.activity.map((a) => `${a.action}:${a.actor.type}`);
  for (const expected of ["share.invite:user", "share.accept:user", "control.update:user", "schedule.create:user", "automation.create:user", "control.update:automation"]) {
    assert.ok(actions.includes(expected), `missing ${expected} in ${actions}`);
  }
  const byOp = r.body.activity.find((a) => a.action === "control.update" && a.actor.type === "user");
  assert.equal(byOp.actor.email, op.email);
  assert.deepEqual(byOp.details.actuators, { relay1: { state: "ON" } });

  const filtered = await call(owner, "GET", "/api/devices/d1/activity?action=share&limit=1");
  assert.equal(filtered.body.count, 1);
  assert.ok(filtered.body.activity[0].action.startsWith("share."));
  assert.ok(filtered.body.nextBefore);
});

