const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

process.env.MAIL_TRANSPORT = "json";
process.env.APP_URL = "https://app.example.com";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-report-"));
process.env.UPLOAD_DIR = tmp;

const { ObjectId } = require("mongoose").mongo;
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");
const { processOutbox } = require("../src/email/outbox");
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
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb(db);
  sentInMemory.length = 0;
});

async function deliver() {
  await processOutbox(db);
  return sentInMemory.splice(0);
}
async function verified() {
  const u = await createUser(app.api);
  await db.collection("users").updateOne({ _id: new ObjectId(u.id) }, { $set: { emailVerified: true } });
  await deliver();
  return u;
}
const call = (u, method, p, body) => app.api(method, p, { token: u.token, body });

/** Read an .xlsx (our own zip output) into { sheetNames, sheets: [xml, ...] }. */
function readXlsx(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const comp = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nameLen);
    const start = i + 30 + nameLen + extra;
    files[name] = zlib.inflateRawSync(buf.subarray(start, start + comp)).toString("utf8");
    i = start + comp;
  }
  const sheetNames = [...files["xl/workbook.xml"].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const sheets = sheetNames.map((_, n) => files[`xl/worksheets/sheet${n + 1}.xml`]);
  return { sheetNames, sheets };
}
const xlsxOf = (mail) => Buffer.from(mail.attachments.find((a) => a.filename.endsWith(".xlsx")).content, "base64");

async function shareAs(owner, deviceId, member, role) {
  await call(owner, "POST", `/api/devices/${deviceId}/invites`, { email: member.email, role });
  const mail = (await deliver()).find((m) => m.to[0].address === member.email);
  const token = /invite\?token=([A-Za-z0-9_-]+)/.exec(mail.text)[1];
  assert.equal((await call(member, "POST", "/api/invites/accept", { token })).status, 200);
}

test("weekly report: one email per user, Excel with a summary sheet and one sheet per device", async () => {
  const owner = await verified();
  const op = await verified();
  const viewer = await verified();
  const nobody = await verified(); // no devices: no report
  await createDevice(db, "d1", owner.id);
  await createDevice(db, "d2", owner.id);
  await call(owner, "PATCH", "/api/devices/d1/ui", { displayName: "Greenhouse Pump", icon: "emoji:💧", color: "#16a34a" });
  await shareAs(owner, "d1", op, "operator");
  await shareAs(owner, "d1", viewer, "viewer");
  await call(op, "POST", "/api/devices/d1/control", { actuators: { relay1: { state: "ON" } } });

  const now = Date.now();
  await db.collection("device_telemetry").insertMany(
    Array.from({ length: 24 }, (_, i) => ({ deviceId: "d1", createdAt: new Date(now - i * 3600e3), temp: 20 + (i % 5), fw: "1.0" }))
  );

  const res = await call(await verifiedAdmin(), "POST", "/api/admin/maintenance/weekly-report", {});
  assert.equal(res.status, 200);
  assert.equal(res.body.queued, 3, "owner, operator, viewer");
  const mails = await deliver();
  assert.equal(mails.filter((m) => m.to[0].address === nobody.email).length, 0);

  const ownerMail = mails.find((m) => m.to[0].address === owner.email);
  assert.match(ownerMail.subject, /weekly report/);
  assert.match(ownerMail.html, /Greenhouse Pump/);
  assert.match(ownerMail.html, /ID: d1/);
  assert.match(ownerMail.html, /Turn off these emails/);

  const book = readXlsx(xlsxOf(ownerMail));
  assert.deepEqual(book.sheetNames, ["Summary", "d2", "Greenhouse Pump"]);
  assert.match(book.sheets[0], /Greenhouse Pump/);
  assert.match(book.sheets[2], new RegExp(op.email.replace(/[.+]/g, "\\$&")), "owner sees who did it");
  assert.match(book.sheets[2], /Set relay1: state=ON/);
  assert.match(book.sheets[2], /temp/, "daily reading stats");
  assert.match(book.sheets[1], /No activity this week/);

  const viewerBook = readXlsx(xlsxOf(mails.find((m) => m.to[0].address === viewer.email)));
  assert.deepEqual(viewerBook.sheetNames, ["Summary", "Greenhouse Pump"], "only the devices shared with them");
  assert.doesNotMatch(viewerBook.sheets[1], new RegExp(op.email.replace(/[.+]/g, "\\$&")), "viewers don't see other members' emails");
  assert.match(viewerBook.sheets[1], /A member/);

  // running again in the same week doesn't send twice
  await call(await verifiedAdmin(), "POST", "/api/admin/maintenance/weekly-report", {});
  assert.equal((await deliver()).length, 0);
});

let adminUser;
async function verifiedAdmin() {
  if (adminUser && (await db.collection("users").findOne({ _id: new ObjectId(adminUser.id) }))) return adminUser;
  const u = await createUser(app.api, { role: "admin" });
  await deliver();
  adminUser = u;
  return u;
}

test("users who turned weekly reports off don't get one; the unsubscribe link turns it off", async () => {
  const owner = await verified();
  await createDevice(db, "d1", owner.id);
  const { sendWeeklyReports } = require("../src/services/weeklyReport");

  await sendWeeklyReports(db);
  const [mail] = await deliver();
  const token = /unsubscribe\?token=([A-Za-z0-9_.-]+)/.exec(mail.text)[1];
  assert.equal((await app.api("POST", "/api/auth/unsubscribe", { body: { token } })).body.notifications.weeklyReport, false);

  await db.collection("email_outbox").deleteMany({});
  const r = await sendWeeklyReports(db);
  assert.equal(r.queued, 0);
  assert.equal((await deliver()).length, 0);
});

test("the backup runs even when the weekly reports fail", async () => {
  const reportPath = require.resolve("../src/services/weeklyReport");
  const backupPath = require.resolve("../scripts/backup_and_cleanup_telemetry");
  const realReport = require(reportPath);
  const realBackup = require(backupPath);
  let backedUp = false;
  require.cache[reportPath].exports = { ...realReport, sendWeeklyReports: async () => { throw new Error("SMTP exploded"); } };
  require.cache[backupPath].exports = { ...realBackup, backupAndCleanupTelemetry: async () => { backedUp = true; } };
  try {
    const handlers = {};
    require("../src/scheduler/jobs").defineJobs({ define: (name, fn) => (handlers[name] = fn) });
    await handlers["weekly-backup-and-cleanup"]();
    assert.equal(backedUp, true);
  } finally {
    require.cache[reportPath].exports = realReport;
    require.cache[backupPath].exports = realBackup;
  }
});

test("device emails show the configured name, icon and id (uploaded icons are embedded)", async () => {
  const owner = await verified();
  await createDevice(db, "ESP32-A1", owner.id);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  const up = await fetch(`${app.base}/api/files/icons`, { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "image/png" }, body: png });
  const icon = (await up.json()).icon;
  await call(owner, "PATCH", "/api/devices/ESP32-A1/ui", { displayName: "Greenhouse Pump", icon: icon.ref, color: "#16a34a" });
  await call(owner, "PUT", "/api/devices/ESP32-A1/alerts", { offline: { enabled: true, afterMin: 5 } });

  const { checkDevices } = require("../src/services/deviceWatchdog");
  await db.collection("device_telemetry").updateMany({ deviceId: "ESP32-A1" }, { $set: { createdAt: new Date(Date.now() - 10 * 60e3) } });
  await checkDevices(db);
  const [mail] = await deliver();
  assert.match(mail.subject, /Greenhouse Pump is offline/);
  assert.match(mail.html, /ID: ESP32-A1/);
  assert.match(mail.html, new RegExp(`cid:file-${icon.id}`));
  const att = mail.attachments.find((a) => a.cid === `file-${icon.id}`);
  assert.ok(att, "uploaded icon embedded");
  assert.deepEqual(Buffer.from(att.content, "base64"), png);
  assert.match(mail.text, /Device: Greenhouse Pump \(ID: ESP32-A1\)/);
});

test("device emails fall back to the device's own name when none was set in Customize", async () => {
  const owner = await verified();
  await createDevice(db, "e00e6c1c4278", owner.id);
  await db.collection("device_config").updateOne({ _id: "e00e6c1c4278" }, { $set: { "device.name": "Smart Solenoid Valve" } });
  await call(owner, "PUT", "/api/devices/e00e6c1c4278/alerts", { offline: { enabled: true, afterMin: 5 } });

  const { checkDevices } = require("../src/services/deviceWatchdog");
  await db.collection("device_telemetry").updateMany({ deviceId: "e00e6c1c4278" }, { $set: { createdAt: new Date(Date.now() - 10 * 60e3) } });
  await checkDevices(db);
  const [mail] = await deliver();
  assert.match(mail.subject, /Smart Solenoid Valve is offline/);
  assert.match(mail.html, /ID: e00e6c1c4278/);

  // A name set in Customize still wins
  const { deviceDisplayName } = require("../src/email/notify");
  await call(owner, "PATCH", "/api/devices/e00e6c1c4278/ui", { displayName: "Garden Valve" });
  assert.equal((await deviceDisplayName(db, "e00e6c1c4278")).name, "Garden Valve");
});
