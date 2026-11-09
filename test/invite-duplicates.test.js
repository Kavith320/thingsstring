const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.MAIL_TRANSPORT = "json";
process.env.APP_URL = "https://app.example.com";

const { ObjectId } = require("mongoose").mongo;
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");
const { processOutbox } = require("../src/email/outbox");
const { sentInMemory } = require("../src/email/mailer");
const { ensureIndexes } = require("../src/db/indexes");

let db;
let app;

before(async () => {
  db = await startDb();
  await ensureIndexes(db);
  app = await startApp();
});
after(async () => {
  await app.close();
  await stopDb();
});
beforeEach(async () => {
  for (const c of ["users", "device_config", "device_control", "device_telemetry", "device_invites", "email_outbox", "device_activity"]) {
    await db.collection(c).deleteMany({});
  }
  sentInMemory.length = 0;
});

async function deliver() {
  await processOutbox(db);
  return sentInMemory.splice(0);
}
async function owner() {
  const u = await createUser(app.api);
  await db.collection("users").updateOne({ _id: new ObjectId(u.id) }, { $set: { emailVerified: true } });
  await createDevice(db, "d1", u.id);
  await deliver();
  return u;
}
const send = (u, body) => app.api("POST", "/api/devices/d1/invites", { token: u.token, body });

test("15 simultaneous invite requests (held Enter key / retry loop) send exactly one email", async () => {
  const o = await owner();
  const results = await Promise.all(Array.from({ length: 15 }, () => send(o, { email: "friend@example.com", role: "operator" })));

  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((s) => [200, 201, 429].includes(s)), `unexpected statuses ${statuses}`);
  assert.equal(statuses.filter((s) => s === 201).length, 1, "one invitation created");
  assert.ok(results.filter((r) => r.status === 200).every((r) => r.body.alreadySent === true));

  assert.equal(await db.collection("device_invites").countDocuments({ status: "pending" }), 1);
  assert.equal((await deliver()).length, 1, "one email, not fifteen");
});

test("re-sending within 2 minutes sends nothing; a changed role updates the sent invitation", async () => {
  const o = await owner();
  assert.equal((await send(o, { email: "friend@example.com", role: "viewer" })).status, 201);
  assert.equal((await deliver()).length, 1);

  const again = await send(o, { email: "friend@example.com", role: "operator" });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadySent, true);
  assert.equal(again.body.invite.role, "operator");
  assert.equal((await deliver()).length, 0);
  assert.equal((await db.collection("device_invites").findOne({ status: "pending" })).role, "operator");
});

test("after the cooldown, 'resend' replaces the invitation and sends a new email", async () => {
  const o = await owner();
  await send(o, { email: "friend@example.com", role: "viewer" });
  await deliver();
  await db.collection("device_invites").updateMany({}, { $set: { createdAt: new Date(Date.now() - 3 * 60e3) } });

  assert.equal((await send(o, { email: "friend@example.com", role: "viewer" })).status, 201);
  assert.equal((await deliver()).length, 1);
  assert.equal(await db.collection("device_invites").countDocuments({ status: "pending" }), 1);
  assert.equal(await db.collection("device_invites").countDocuments({ status: "revoked", revokedReason: "replaced" }), 1);
});

test("an expired invitation doesn't block a new one", async () => {
  const o = await owner();
  await send(o, { email: "friend@example.com", role: "viewer" });
  await db.collection("device_invites").updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await send(o, { email: "friend@example.com", role: "viewer" })).status, 201);
  assert.equal(await db.collection("device_invites").countDocuments({ status: "expired" }), 1);
});
