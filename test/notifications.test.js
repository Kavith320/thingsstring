const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.MAIL_TRANSPORT = "json";
process.env.APP_URL = "https://app.example.com";

const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");
const { processOutbox } = require("../src/email/outbox");
const { sentInMemory } = require("../src/email/mailer");
const { checkDevices } = require("../src/services/deviceWatchdog");
const { notifyUser, unsubscribeToken, MAX_ALERTS_PER_HOUR } = require("../src/email/notify");

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
});

/** Create a user and drop their sign-up verification email. */
async function user(opts) {
  const u = await createUser(app.api, opts);
  await deliver();
  return u;
}
async function deliver() {
  await processOutbox(db);
  return sentInMemory.splice(0);
}
const MIN = 60e3;
/** Make the device's latest reading `ageMs` old (relative to `now`). */
async function lastSeen(deviceId, now, ageMs) {
  await db.collection("device_telemetry").deleteMany({ deviceId });
  await db.collection("device_telemetry").insertOne({ deviceId, createdAt: new Date(now - ageMs), t: 1 });
}

/* ───────────────────────── Watchdog ───────────────────────── */

const setAlerts = (token, deviceId, offline) => app.api("PUT", `/api/devices/${deviceId}/alerts`, { token, body: { offline } });

test("offline alerts are off by default, per device, with a custom delay", async () => {
  const alice = await user();
  await createDevice(db, "d1", alice.id);
  await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body: { displayName: "Greenhouse Pump" } });
  let now = Date.now();

  let r = await app.api("GET", "/api/devices/d1/alerts", { token: alice.token });
  assert.deepEqual(r.body.alerts.offline, { enabled: false, afterMin: 10 });
  await lastSeen("d1", now, 60 * MIN);
  await checkDevices(db, { now });
  assert.equal((await deliver()).length, 0, "nothing while alerts are off");

  await lastSeen("d1", now, 0);
  r = await setAlerts(alice.token, "d1", { enabled: true, afterMin: 30 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alerts.offline, { enabled: true, afterMin: 30 });
  assert.equal((await setAlerts(alice.token, "d1", { afterMin: 1 })).status, 400);
  assert.equal((await setAlerts(alice.token, "d1", { afterMin: 2000 })).status, 400);

  now += 20 * MIN;
  await checkDevices(db, { now });
  assert.equal((await deliver()).length, 0, "20 min silent < 30 min setting");

  now += 11 * MIN;
  assert.equal((await checkDevices(db, { now })).offlineAlerts, 1);
  const [off] = await deliver();
  assert.match(off.subject, /Greenhouse Pump is offline/);
  assert.match(off.html, /more than 30 minutes/);
  assert.match(off.headers["List-Unsubscribe"], /^<https:\/\/app\.example\.com\/unsubscribe\?token=/);

  now += MIN;
  await checkDevices(db, { now });
  assert.equal((await deliver()).length, 0, "still offline: no repeat");

  await lastSeen("d1", now, 0);
  assert.equal((await checkDevices(db, { now })).onlineAlerts, 1);
  assert.match((await deliver())[0].subject, /back online/);
});

test("flapping within 30 minutes sends one offline email and one back-online email", async () => {
  const alice = await user();
  await createDevice(db, "d1", alice.id);
  await setAlerts(alice.token, "d1", { enabled: true, afterMin: 5 });
  let now = Date.now();
  for (let i = 0; i < 3; i++) {
    now += 6 * MIN;
    await lastSeen("d1", now, 6 * MIN);
    await checkDevices(db, { now });
    await lastSeen("d1", now, 0);
    await checkDevices(db, { now });
  }
  const mails = await deliver();
  assert.equal(mails.filter((m) => /is offline/.test(m.subject)).length, 1);
  assert.equal(mails.filter((m) => /back online/.test(m.subject)).length, 1);
});

test("turning alerts on while a device is already offline doesn't alert for that outage", async () => {
  const alice = await user();
  await createDevice(db, "d1", alice.id);
  const now = Date.now();
  await lastSeen("d1", now, 60 * MIN);
  await setAlerts(alice.token, "d1", { enabled: true, afterMin: 5 });
  await checkDevices(db, { now });
  await lastSeen("d1", now, 0);
  await checkDevices(db, { now });
  assert.equal((await deliver()).length, 0);
});

test("platform outage: when every device goes silent nothing is sent; one silent device still alerts", async () => {
  const alice = await user();
  await createDevice(db, "a", alice.id);
  await createDevice(db, "b", alice.id);
  await setAlerts(alice.token, "a", { enabled: true, afterMin: 5 });
  let now = Date.now();
  await checkDevices(db, { now });

  now += 10 * MIN;
  await lastSeen("a", now, 10 * MIN);
  await lastSeen("b", now, 10 * MIN);
  const s = await checkDevices(db, { now });
  assert.equal(s.platformSilent, true);
  assert.equal((await deliver()).length, 0);

  await lastSeen("b", now, 0); // data flows again, "a" is still silent: a real outage of "a"
  const s2 = await checkDevices(db, { now });
  assert.equal(s2.platformSilent, false);
  assert.equal(s2.offlineAlerts, 1);
});

test("locked devices and users with the master switch off get nothing", async () => {
  const bob = await user();
  const carol = await user();
  await createDevice(db, "locked", bob.id);
  await createDevice(db, "quiet", carol.id);
  await createDevice(db, "live", carol.id);
  await setAlerts(bob.token, "locked", { enabled: true, afterMin: 5 });
  await setAlerts(carol.token, "quiet", { enabled: true, afterMin: 5 });
  await db.collection("device_config").updateOne({ _id: "locked" }, { $set: { isDisabled: true } });
  await app.api("PATCH", "/api/me/notifications", { token: carol.token, body: { deviceOffline: false } });

  const now = Date.now() + 10 * MIN;
  await lastSeen("locked", now, 10 * MIN);
  await lastSeen("quiet", now, 10 * MIN);
  await lastSeen("live", now, 0);
  await checkDevices(db, { now });
  assert.equal((await deliver()).length, 0);
});

test("the unsubscribe link in an offline alert turns off only that device", async () => {
  const alice = await user();
  await createDevice(db, "d1", alice.id);
  await createDevice(db, "d2", alice.id);
  await setAlerts(alice.token, "d1", { enabled: true, afterMin: 5 });
  await setAlerts(alice.token, "d2", { enabled: true, afterMin: 5 });

  const now = Date.now() + 10 * MIN;
  await lastSeen("d1", now, 10 * MIN);
  await lastSeen("d2", now, 0);
  await checkDevices(db, { now });
  const [mail] = await deliver();
  const token = /unsubscribe\?token=([A-Za-z0-9_.-]+)/.exec(mail.text)[1];

  const r = await app.api("POST", "/api/auth/unsubscribe", { body: { token } });
  assert.equal(r.status, 200);
  assert.equal(r.body.deviceId, "d1");
  assert.equal((await app.api("GET", "/api/devices/d1/alerts", { token: alice.token })).body.alerts.offline.enabled, false);
  assert.equal((await app.api("GET", "/api/devices/d2/alerts", { token: alice.token })).body.alerts.offline.enabled, true);
});

/* ───────────────────────── Settings & unsubscribe ───────────────────────── */

test("notification settings and the unsubscribe link", async () => {
  const alice = await user();
  let r = await app.api("GET", "/api/me/notifications", { token: alice.token });
  assert.deepEqual(r.body.notifications, { deviceOffline: true, automation: true });
  assert.equal((await app.api("PATCH", "/api/me/notifications", { token: alice.token, body: { automation: "no" } })).status, 400);

  const token = unsubscribeToken(alice.id, "automation");
  r = await app.api("POST", "/api/auth/unsubscribe", { body: { token } });
  assert.equal(r.status, 200);
  assert.equal(r.body.notifications.automation, false);
  assert.equal((await app.api("GET", "/api/me", { token: alice.token })).body.user.notifications.automation, false);

  const forged = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
  assert.equal((await app.api("POST", "/api/auth/unsubscribe", { body: { token: forged } })).status, 400);
  assert.equal((await app.api("POST", "/api/auth/unsubscribe", { body: { token: "garbage" } })).status, 400);
});

test("optional alerts are capped per user per hour; account notices are not", async () => {
  const alice = await user();
  for (let i = 0; i < MAX_ALERTS_PER_HOUR + 5; i++) {
    await notifyUser(db, { userId: alice.id, category: "deviceOffline", template: "deviceOffline", data: { deviceId: `d${i}`, deviceName: `d${i}` } });
  }
  const capped = await notifyUser(db, { userId: alice.id, category: "deviceOffline", template: "deviceOffline", data: { deviceId: "z", deviceName: "z" } });
  assert.equal(capped.reason, "hourly cap");
  const account = await notifyUser(db, { userId: alice.id, category: "account", template: "accountReactivated" });
  assert.equal(account.queued, true);
  assert.equal((await deliver()).length, MAX_ALERTS_PER_HOUR + 1);
});

/* ───────────────────────── Automation emails ───────────────────────── */

async function flowVia(token, body) {
  return app.api("POST", "/api/automation/flows", {
    token,
    body: { name: "Hot", deviceId: "d1", metricPath: "data.temp", condition: { operator: ">", value: 30 }, cooldownSec: 0, ...body },
  });
}

test("alert-only rule emails when the condition is met, at most once per 15 minutes", async () => {
  const alice = await user();
  await createDevice(db, "d1", alice.id); // data.temp = 31
  assert.equal((await flowVia(alice.token, {})).status, 400, "needs an action or notify.email");

  const r = await flowVia(alice.token, { notify: { email: true } });
  assert.equal(r.status, 201);
  assert.equal(r.body.flow.action, null);

  await runFlow(db, r.body.flow._id);
  await runFlow(db, r.body.flow._id);
  const mails = await deliver();
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Hot: data\.temp is 31/);
  assert.match(mails[0].html, /Email only/);

  const log = await db.collection("automation_flow_logs").find().sort({ _id: 1 }).next();
  assert.equal(log.status, "ran");
  assert.equal(log.emailed, true);
});

test("rule with an action and 'Email me' says what it did; turning automation emails off stops them", async () => {
  const alice = await user();
  await createDevice(db, "d1", alice.id);
  const r = await flowVia(alice.token, { action: { actuatorKey: "relay1", setValue: true }, notify: { email: true } });
  await runFlow(db, r.body.flow._id);
  const [mail] = await deliver();
  assert.match(mail.html, /Set relay1 to ON/);
  assert.equal((await db.collection("device_control").findOne({ _id: "d1" })).actuators.relay1.state, "ON", "action still runs");

  await app.api("PATCH", "/api/me/notifications", { token: alice.token, body: { automation: false } });
  await db.collection("email_outbox").deleteMany({}); // clear the 15-minute dedupe
  await runFlow(db, r.body.flow._id);
  assert.equal((await deliver()).length, 0);
});

test("rules without 'Email me' never email", async () => {
  const alice = await user();
  await createDevice(db, "d1", alice.id);
  const r = await flowVia(alice.token, { action: { actuatorKey: "relay1", setValue: true } });
  assert.deepEqual(r.body.flow.notify, { email: false });
  await runFlow(db, r.body.flow._id);
  assert.equal((await deliver()).length, 0);
});

/* ───────────────────────── Admin notices ───────────────────────── */

test("admin lock/unlock, suspend/reactivate, transfer and password reset notify the user", async () => {
  const admin = await user({ role: "admin" });
  const alice = await user();
  const bob = await user();
  await createDevice(db, "d1", alice.id);
  await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body: { displayName: "Barn Fan" } });
  const A = (method, path, body) => app.api(method, path, { token: admin.token, body });

  await A("POST", "/api/admin/devices/d1/lockout", { disabled: true, reason: "Sparks" });
  let [m] = await deliver();
  assert.equal(m.to[0].address, alice.email);
  assert.match(m.subject, /Barn Fan was locked/);
  assert.match(m.html, /Sparks/);
  await A("POST", "/api/admin/devices/d1/lockout", { disabled: true }); // already locked: no repeat
  assert.equal((await deliver()).length, 0);
  await A("POST", "/api/admin/devices/d1/lockout", { disabled: false });
  assert.match((await deliver())[0].subject, /unlocked/);

  await A("PUT", `/api/admin/users/${alice.id}/status`, { status: "disabled" });
  assert.match((await deliver())[0].subject, /suspended/);
  await A("PUT", `/api/admin/users/${alice.id}/status`, { status: "active" });
  assert.match((await deliver())[0].subject, /active again/);

  await A("POST", `/api/admin/users/${alice.id}/reset-password`, { newPassword: "adminset123" });
  assert.match((await deliver())[0].subject, /reset by an administrator/);

  await A("PUT", "/api/admin/devices/d1/transfer", { targetUserId: bob.id });
  const mails = await deliver();
  const to = Object.fromEntries(mails.map((x) => [x.to[0].address, x.subject]));
  assert.match(to[alice.email], /Barn Fan was removed/);
  assert.match(to[bob.email], /added to your/);
});
