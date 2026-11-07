const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");

let db;
let app;

before(async () => {
  db = await startDb();
  app = await startApp();
});
after(async () => {
  await app.close();
  await stopDb();
});
beforeEach(() => resetDb(db));

const flowBody = (deviceId, actionDeviceId) => ({
  name: "x",
  deviceId,
  metricPath: "data.temp",
  condition: { operator: ">", value: 30 },
  action: { deviceId: actionDeviceId, actuatorKey: "relay1", setValue: true },
});

test("automation: cannot create or retarget a flow onto someone else's device", async () => {
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "alice-dev", alice.id);
  await createDevice(db, "bob-dev", bob.id);

  let r = await app.api("POST", "/api/automation/flows", { token: alice.token, body: flowBody("alice-dev", "bob-dev") });
  assert.equal(r.status, 404);
  r = await app.api("POST", "/api/automation/flows", { token: alice.token, body: flowBody("bob-dev", "alice-dev") });
  assert.equal(r.status, 404);

  r = await app.api("POST", "/api/automation/flows", { token: alice.token, body: flowBody("alice-dev", "alice-dev") });
  assert.equal(r.status, 201);
  const id = r.body.flow._id;

  r = await app.api("PUT", `/api/automation/flows/${id}`, {
    token: alice.token,
    body: { action: { deviceId: "bob-dev", actuatorKey: "relay1", setValue: true } },
  });
  assert.equal(r.status, 404);

  r = await app.api("PUT", `/api/automation/flows/${id}`, { token: alice.token, body: { intervalSec: 1, user_id: bob.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.flow.intervalSec, 5, "interval clamped to the 5s minimum");
  assert.equal(r.body.flow.user_id, alice.id, "owner cannot be changed");
});

test("automation: logs of another user's flow are not readable; bad ids are 400", async () => {
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "alice-dev", alice.id);
  const r = await app.api("POST", "/api/automation/flows", { token: alice.token, body: flowBody("alice-dev") });
  const id = r.body.flow._id;

  assert.equal((await app.api("GET", `/api/automation/flows/${id}/logs`, { token: bob.token })).status, 404);
  assert.equal((await app.api("GET", `/api/automation/flows/${id}/logs`, { token: alice.token })).status, 200);
  assert.equal((await app.api("GET", `/api/automation/flows/not-an-id`, { token: alice.token })).status, 400);
});

test("device control: rejects path-injection keys and empty patches", async () => {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id);
  const ctl = (actuators) => app.api("POST", "/api/devices/d1/control", { token: alice.token, body: { actuators } });

  assert.equal((await ctl({ "relay1.x": { state: "ON" } })).status, 400);
  assert.equal((await ctl({ constructor: { state: "ON" } })).status, 400);
  assert.equal((await ctl({ relay1: { $where: 1 } })).status, 400);
  assert.equal((await ctl({ relay1: {} })).status, 400);
  assert.equal((await ctl({})).status, 400);
  const ok = await ctl({ relay1: { state: "ON" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.control.actuators.relay1.state, "ON");
});

test("device control: a locked device can't be controlled by its owner", async () => {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id);
  await db.collection("device_config").updateOne({ _id: "d1" }, { $set: { isDisabled: true } });
  const r = await app.api("POST", "/api/devices/d1/control", { token: alice.token, body: { actuators: { relay1: { state: "ON" } } } });
  assert.equal(r.status, 403);
});

test("auth: password reset revokes old tokens; suspended users can't log in", async () => {
  const admin = await createUser(app.api, { role: "admin" });
  const bob = await createUser(app.api);

  assert.equal((await app.api("GET", "/api/auth/me", { token: bob.token })).status, 200);
  const r = await app.api("POST", `/api/admin/users/${bob.id}/reset-password`, { token: admin.token, body: { newPassword: "newpassword1" } });
  assert.equal(r.status, 200);
  assert.equal((await app.api("GET", "/api/auth/me", { token: bob.token })).status, 401, "old token revoked");

  await app.api("PUT", `/api/admin/users/${bob.id}/status`, { token: admin.token, body: { status: "disabled" } });
  const login = await app.api("POST", "/api/auth/login", { body: { email: bob.email, password: "newpassword1" } });
  assert.equal(login.status, 403);
});

test("auth: tokens without a version (issued before this release) keep working", async () => {
  const bob = await createUser(app.api);
  const { signToken } = require("../src/utils/jwt");
  const legacy = signToken({ sub: bob.id, email: bob.email, role: "user" });
  assert.equal((await app.api("GET", "/api/auth/me", { token: legacy })).status, 200);
});

test("auth: weak passwords rejected, login is rate limited per account", async () => {
  let r = await app.api("POST", "/api/auth/register", { body: { name: "a", email: "short@example.com", password: "123" } });
  assert.equal(r.status, 400);

  const statuses = [];
  for (let i = 0; i < 11; i++) {
    r = await app.api("POST", "/api/auth/login", { body: { email: "victim@example.com", password: "guess" + i } });
    statuses.push(r.status);
  }
  assert.equal(statuses[0], 401);
  assert.equal(statuses[10], 429);
});

test("admin: cannot lock themselves out or remove the last admin", async () => {
  const admin = await createUser(app.api, { role: "admin" });
  assert.equal((await app.api("PUT", `/api/admin/users/${admin.id}/role`, { token: admin.token, body: { role: "user" } })).status, 400);
  assert.equal((await app.api("PUT", `/api/admin/users/${admin.id}/status`, { token: admin.token, body: { status: "disabled" } })).status, 400);
  assert.equal((await app.api("DELETE", `/api/admin/users/${admin.id}`, { token: admin.token })).status, 400);
});

test("admin: role change and transfer are audited; transfer clears old owner's flows", async () => {
  const admin = await createUser(app.api, { role: "admin" });
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "d1", alice.id);
  await app.api("POST", "/api/automation/flows", { token: alice.token, body: flowBody("d1") });

  await app.api("PUT", `/api/admin/users/${bob.id}/role`, { token: admin.token, body: { role: "admin" } });
  const t = await app.api("PUT", "/api/admin/devices/d1/transfer", { token: admin.token, body: { targetUserId: bob.id } });
  assert.equal(t.status, 200);

  const cfg = await db.collection("device_config").findOne({ _id: "d1" });
  assert.equal(cfg.device.user_id, bob.id);
  assert.equal(cfg.user_id, bob.id);
  assert.equal(await db.collection("automation_flows").countDocuments({ user_id: alice.id }), 0);

  const actions = (await db.collection("admin_audit_logs").find({}).toArray()).map((l) => l.action);
  assert.ok(actions.includes("USER_ROLE_UPDATE"));
  assert.ok(actions.includes("DEVICE_TRANSFER"));
});

test("admin: automation log filters match how logs are stored", async () => {
  const admin = await createUser(app.api, { role: "admin" });
  const { ObjectId } = require("mongoose").Types;
  const flowId = new ObjectId();
  await db.collection("automation_flow_logs").insertMany([
    { flowId, deviceId: "s1", actuatorDeviceId: "a1", status: "ran", ts: new Date(2) },
    { flowId, deviceId: "s1", status: "skipped", ts: new Date(3) },
    { flowId: new ObjectId(), deviceId: "zz", status: "ran", ts: new Date(1) },
  ]);
  const q = (s) => app.api("GET", `/api/admin/automation/logs?${s}`, { token: admin.token });
  assert.equal((await q("status=RAN")).body.count, 2);
  assert.equal((await q(`flowId=${flowId}`)).body.count, 2);
  assert.equal((await q("deviceId=a1")).body.count, 1);
  const all = (await q("")).body.logs;
  assert.deepEqual(all.map((l) => l.ts), [...all.map((l) => l.ts)].sort().reverse(), "newest first");
});

test("admin: broadcast refuses server-side JS filters", async () => {
  const admin = await createUser(app.api, { role: "admin" });
  const r = await app.api("POST", "/api/admin/broadcast/control", {
    token: admin.token,
    body: { actuators: { relay1: { state: "OFF" } }, filter: { $where: "sleep(1000)" } },
  });
  assert.equal(r.status, 400);
});

test("schedules: invalid cron and timezone rejected", async () => {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id);
  const body = (o) => ({ name: "s", cron: "0 8 * * *", timezone: "UTC", actions: [{ actuator: "relay1", set: { state: "ON" } }], ...o });
  const post = (o) => app.api("POST", "/api/schedules/devices/d1/schedules", { token: alice.token, body: body(o) });

  assert.equal((await post({ cron: "every day" })).status, 400);
  assert.equal((await post({ timezone: "Mars/Base" })).status, 400);
  assert.equal((await post({ timezone: "Asia/Colombo" })).status, 201);
});

test("malformed JSON is a clean 400 and unknown routes a JSON 404", async () => {
  const res = await fetch(app.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "Invalid JSON body" });
  assert.equal((await app.api("GET", "/api/nope")).status, 404);
});
