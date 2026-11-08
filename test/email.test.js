const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.MAIL_TRANSPORT = "json";
process.env.APP_URL = "https://app.example.com";
process.env.MAIL_FROM = "ThingsString <no-reply@thingsstring.com>";

const { startDb, stopDb, resetDb, startApp, createUser } = require("./helpers");
const { processOutbox, enqueueEmail } = require("../src/email/outbox");
const { sentInMemory } = require("../src/email/mailer");

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
beforeEach(async () => {
  await resetDb(db);
  sentInMemory.length = 0;
});

/** Send everything queued and return the delivered messages. */
async function deliver() {
  await processOutbox(db);
  return sentInMemory.splice(0);
}
const tokenFrom = (msg, path) => {
  const m = new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(msg.text);
  assert.ok(m, `no ${path} link in: ${msg.text}`);
  return m[1];
};

test("register sends a verification email; the link verifies once", async () => {
  const u = await createUser(app.api);
  const [mail] = await deliver();
  assert.equal(mail.to[0].address, u.email);
  assert.equal(mail.from.address, "no-reply@thingsstring.com");
  assert.match(mail.subject, /Verify/);
  assert.match(mail.html, /https:\/\/app\.example\.com\/verify-email\?token=/);

  let me = await app.api("GET", "/api/me", { token: u.token });
  assert.equal(me.body.user.emailVerified, false);

  const token = tokenFrom(mail, "/verify-email");
  const r = await app.api("POST", "/api/auth/verify-email", { body: { token } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.emailVerified, true);
  assert.equal((await app.api("POST", "/api/auth/verify-email", { body: { token } })).status, 400, "single use");

  me = await app.api("GET", "/api/me", { token: u.token });
  assert.equal(me.body.user.emailVerified, true);
  assert.equal((await app.api("POST", "/api/auth/verify-email/send", { token: u.token })).status, 400, "already verified");
});

test("resend revokes the old link; tokens are stored hashed and bodies erased after sending", async () => {
  const u = await createUser(app.api);
  const [first] = await deliver();
  await app.api("POST", "/api/auth/verify-email/send", { token: u.token });
  const [second] = await deliver();

  const oldToken = tokenFrom(first, "/verify-email");
  const newToken = tokenFrom(second, "/verify-email");
  assert.equal((await app.api("POST", "/api/auth/verify-email", { body: { token: oldToken } })).status, 400);

  const stored = await db.collection("email_tokens").find().toArray();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]._id, newToken, "only the hash is stored");

  const outbox = await db.collection("email_outbox").find().toArray();
  assert.ok(outbox.every((m) => m.status === "sent" && m.html === undefined && m.text === undefined));
});

test("forgot/reset password: same answer for unknown emails, link works once, sessions revoked", async () => {
  const u = await createUser(app.api);
  await deliver(); // verification mail

  const unknown = await app.api("POST", "/api/auth/forgot-password", { body: { email: "nobody@example.com" } });
  const known = await app.api("POST", "/api/auth/forgot-password", { body: { email: u.email.toUpperCase() } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body, "no account enumeration");

  const mails = await deliver();
  assert.equal(mails.length, 1, "only the real account gets an email");
  const token = tokenFrom(mails[0], "/reset-password");

  assert.equal((await app.api("POST", "/api/auth/reset-password", { body: { token, newPassword: "short" } })).status, 400);
  const r = await app.api("POST", "/api/auth/reset-password", { body: { token, newPassword: "brandnew123" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.emailVerified, true);
  assert.equal((await app.api("GET", "/api/me", { token: u.token })).status, 401, "old sessions logged out");
  assert.equal((await app.api("GET", "/api/me", { token: r.body.token })).status, 200);
  assert.equal((await app.api("POST", "/api/auth/reset-password", { body: { token, newPassword: "again12345" } })).status, 400);

  const login = await app.api("POST", "/api/auth/login", { body: { email: u.email, password: "brandnew123" } });
  assert.equal(login.status, 200);
  const [notice] = await deliver();
  assert.match(notice.subject, /password was changed/);
});

test("forgot password is rate limited per email", async () => {
  const u = await createUser(app.api);
  for (let i = 0; i < 3; i++) await app.api("POST", "/api/auth/forgot-password", { body: { email: u.email } });
  const r = await app.api("POST", "/api/auth/forgot-password", { body: { email: u.email } });
  assert.equal(r.status, 429);
});

test("change email: needs the password, confirmed from the new inbox, old inbox told", async () => {
  const u = await createUser(app.api);
  const other = await createUser(app.api);
  await deliver();

  const ask = (body) => app.api("POST", "/api/me/email", { token: u.token, body });
  assert.equal((await ask({ newEmail: "new@example.com", currentPassword: "wrong" })).status, 400);
  assert.equal((await ask({ newEmail: other.email, currentPassword: "password123" })).status, 409);
  assert.equal((await ask({ newEmail: "not-an-email", currentPassword: "password123" })).status, 400);

  assert.equal((await ask({ newEmail: "New@Example.com", currentPassword: "password123" })).status, 200);
  const [confirm] = await deliver();
  assert.equal(confirm.to[0].address, "new@example.com");
  assert.equal((await app.api("GET", "/api/me", { token: u.token })).body.user.email, u.email, "unchanged until confirmed");

  const token = tokenFrom(confirm, "/confirm-email");
  const r = await app.api("POST", "/api/auth/confirm-email", { body: { token } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, "new@example.com");

  const [notice] = await deliver();
  assert.equal(notice.to[0].address, u.email, "old address is notified");
  assert.match(notice.subject, /email was changed/);

  assert.equal((await app.api("POST", "/api/auth/login", { body: { email: "new@example.com", password: "password123" } })).status, 200);
});

test("password change from settings sends a security notice", async () => {
  const u = await createUser(app.api);
  await deliver();
  await app.api("PUT", "/api/me/password", { token: u.token, body: { currentPassword: "password123", newPassword: "another123" } });
  const [notice] = await deliver();
  assert.match(notice.subject, /password was changed/);
});

test("user names are HTML-escaped in emails", async () => {
  await enqueueEmail(db, { to: "x@example.com", template: "passwordChanged", data: { name: '<img src=x onerror="alert(1)">' } });
  const [mail] = await deliver();
  assert.ok(!mail.html.includes("<img src=x"), "raw HTML from a name never reaches the email");
  assert.match(mail.html, /&lt;img/);
});

test("outbox retries failures with backoff, then gives up", async () => {
  await enqueueEmail(db, { to: "a@example.com", template: "passwordChanged", data: { name: "x" } });
  const failing = async () => {
    throw Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
  };

  await processOutbox(db, { send: failing });
  let row = await db.collection("email_outbox").findOne();
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt > new Date(), "retry is scheduled in the future");
  assert.match(row.lastError, /timeout/);

  for (let i = 0; i < 3; i++) {
    await db.collection("email_outbox").updateOne({}, { $set: { nextAttemptAt: new Date(0) } });
    await processOutbox(db, { send: failing });
  }
  row = await db.collection("email_outbox").findOne();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 4);
  assert.equal(row.html, undefined, "failed mail bodies are erased too");
});

test("a rejected recipient (550) fails at once without retrying", async () => {
  await enqueueEmail(db, { to: "gone@example.com", template: "passwordChanged", data: { name: "x" } });
  await processOutbox(db, {
    send: async () => {
      throw Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 });
    },
  });
  const row = await db.collection("email_outbox").findOne();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
});

test("dedupeKey prevents sending the same alert twice", async () => {
  await enqueueEmail(db, { to: "a@example.com", template: "passwordChanged", data: { name: "a" }, dedupeKey: "k1" });
  const second = await enqueueEmail(db, { to: "a@example.com", template: "passwordChanged", data: { name: "a" }, dedupeKey: "k1" });
  assert.equal(second.queued, false);
  assert.equal((await deliver()).length, 1);
});

test("requireVerifiedEmail blocks unverified users", async () => {
  const { requireVerifiedEmail } = require("../src/middleware/auth.middleware");
  let status;
  const res = { status: (s) => ((status = s), { json: () => {} }) };
  let called = false;
  requireVerifiedEmail({ user: { emailVerified: false } }, res, () => (called = true));
  assert.equal(status, 403);
  assert.equal(called, false);
  requireVerifiedEmail({ user: { emailVerified: true } }, res, () => (called = true));
  assert.equal(called, true);
});
