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

/* ───────────────────────── Free-tier email budget ───────────────────────── */

test("email budget: alerts stop at (limit - reserved); the sender never exceeds the limit", async () => {
  process.env.MAIL_DAILY_LIMIT = "5";
  process.env.MAIL_RESERVED = "2";
  const { notifyUser } = require("../src/email/notify");
  const owner = await verified();
  const admin = await verified({ role: "admin" });

  // exactly 3 emails sent today (drop the sign-up emails of the users above)
  await db.collection("email_outbox").deleteMany({});
  await db.collection("email_outbox").insertMany(
    [1, 2, 3].map(() => ({ to: "x@example.com", status: "sent", sentAt: new Date(), createdAt: new Date(), category: "security" }))
  );
  const alert = await notifyUser(db, { userId: owner.id, category: "automation", template: "accountReactivated" });
  assert.equal(alert.reason, "daily budget", "alerts can't eat into the reserve");
  const important = await notifyUser(db, { userId: owner.id, category: "account", template: "accountReactivated" });
  assert.equal(important.queued, true, "account notices still go out");

  // fill to the hard limit: the rest waits
  for (let i = 0; i < 3; i++) await notifyUser(db, { userId: owner.id, category: "account", template: "accountSuspended", dedupeKey: `k${i}` });
  const sent = await deliver();
  assert.equal(sent.length, 2, "only 2 more fit under the limit of 5");
  assert.equal(await db.collection("email_outbox").countDocuments({ status: "pending" }), 2);

  const stats = await call(admin, "GET", "/api/admin/email/stats");
  assert.equal(stats.body.limit, 5);
  assert.equal(stats.body.sent24h, 5);
  assert.equal(stats.body.alertsAllowed, false);

  await createDevice(db, "d1", owner.id);
  const inv = await call(owner, "POST", "/api/devices/d1/invites", { email: "z@example.com", role: "viewer" });
  assert.equal(inv.status, 503, "invites pause when nothing is left for today");
});

/* ───────────────────────── Admin ───────────────────────── */

test("admin transfer resets sharing; deleting a user removes their access elsewhere", async () => {
  const admin = await verified({ role: "admin" });
  const owner = await verified();
  const bob = await verified();
  const carol = await verified();
  await createDevice(db, "d1", owner.id);
  await createDevice(db, "c1", carol.id);
  await share(owner, "d1", bob, "operator");
  await share(carol, "c1", bob, "viewer");
  await invite(owner, "d1", "pending@example.com", "viewer");

  assert.equal((await call(admin, "PUT", "/api/admin/devices/d1/transfer", { targetUserId: carol.id })).status, 200);
  assert.equal((await call(bob, "GET", "/api/devices/d1")).status, 404, "old shares removed");
  assert.equal(await db.collection("device_invites").countDocuments({ deviceId: "d1", status: "pending" }), 0);
  assert.equal((await call(carol, "GET", "/api/devices/d1")).body.device.role, "owner");

  assert.equal((await call(admin, "DELETE", `/api/admin/users/${bob.id}`)).status, 200);
  assert.equal(await db.collection("device_access").countDocuments({ userId: bob.id }), 0);
});

test("startup migration re-keys old device_ui documents to per-user keys (idempotent)", async () => {
  const { migrateDeviceUiKeys } = require("../src/services/deviceUi");
  await db.collection("device_ui").insertMany([
    { _id: "d1", user_id: "u1", displayName: "Old Pump", updatedAt: new Date() },
    { _id: "orphan", displayName: "no owner" },
  ]);
  await migrateDeviceUiKeys(db);
  await migrateDeviceUiKeys(db); // second run changes nothing
  const docs = await db.collection("device_ui").find().toArray();
  assert.equal(docs.length, 1);
  assert.equal(docs[0]._id, "u1:d1");
  assert.equal(docs[0].deviceId, "d1");
  assert.equal(docs[0].displayName, "Old Pump");
});
