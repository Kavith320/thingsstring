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

/* ───────────────────────── Shared device settings ───────────────────────── */

test("everyone sees the owner's device settings; only owner and managers can change them", async () => {
  const owner = await verified();
  const mgr = await verified();
  const viewer = await verified();
  const op = await verified();
  await createDevice(db, "d1", owner.id);
  for (const [u, role] of [[mgr, "manager"], [viewer, "viewer"], [op, "operator"]]) await share(owner, "d1", u, role);

  // owner customises, with an icon they uploaded
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const up = await fetch(`${app.base}/api/files/icons`, { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "image/png" }, body: png });
  const iconRef = (await up.json()).icon.ref;
  const settings = {
    displayName: "Greenhouse Pump",
    icon: iconRef,
    color: "#22c55e",
    sensors: [{ key: "data.temp", label: "Temp", unit: "°C", pinned: true }, { key: "rssi", visible: false }],
    actuators: [{ key: "relay1", label: "Pump" }],
    location: { lat: 6.9, lng: 79.8, label: "Farm" },
  };
  assert.equal((await call(owner, "PATCH", "/api/devices/d1/ui", settings)).status, 200);

  for (const u of [viewer, op, mgr]) {
    const list = await call(u, "GET", "/api/devices");
    const ui = list.body.devices[0].ui;
    assert.equal(ui.displayName, "Greenhouse Pump");
    assert.equal(ui.icon, iconRef);
    assert.equal(ui.sensors[1].visible, false, "hidden values hidden for everyone");
    assert.equal(ui.actuators[0].label, "Pump");
    assert.equal((await call(u, "GET", "/api/devices/d1")).body.device.ui.color, "#22c55e");
    assert.equal((await call(u, "GET", "/api/devices/map")).body.count, 1, "location shared on the map");
  }
  assert.equal((await call(viewer, "GET", "/api/devices/d1/ui")).body.canEdit, false);
  assert.equal((await call(mgr, "GET", "/api/devices/d1/ui")).body.canEdit, true);

  // viewers and operators can't change them
  assert.equal((await call(viewer, "PATCH", "/api/devices/d1/ui", { displayName: "Mine" })).status, 403);
  assert.equal((await call(op, "PATCH", "/api/devices/d1/ui", { displayName: "Mine" })).status, 403);

  // a manager can, even re-sending the owner's uploaded icon
  const r = await call(mgr, "PATCH", "/api/devices/d1/ui", { displayName: "Main Pump", icon: iconRef });
  assert.equal(r.status, 200);
  assert.equal((await call(owner, "GET", "/api/devices/d1/ui")).body.ui.displayName, "Main Pump");
  const hist = await call(owner, "GET", "/api/devices/d1/activity?action=settings");
  assert.equal(hist.body.activity[0].actor.email, mgr.email);

  // alert settings stay personal
  await call(viewer, "PUT", "/api/devices/d1/alerts", { offline: { enabled: true, afterMin: 15 } });
  assert.equal((await call(owner, "GET", "/api/devices/d1/alerts")).body.alerts.offline.enabled, false);
  assert.equal((await call(viewer, "GET", "/api/devices/d1/alerts")).body.alerts.offline.enabled, true);
});

