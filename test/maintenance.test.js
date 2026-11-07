const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startDb, stopDb, resetDb } = require("./helpers");

let db;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-backup-"));
process.env.BACKUP_DIR = tmp;
process.env.BACKUP_KEEP = "2";

before(async () => {
  db = await startDb();
});
after(async () => {
  await stopDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => resetDb(db));

test("ensureIndexes is idempotent and TTL retention can be changed in place", async () => {
  const { ensureIndexes, ensureTtlIndex } = require("../src/db/indexes");
  await ensureIndexes(db);
  await ensureIndexes(db); // second run must not throw

  await ensureTtlIndex(db, "device_telemetry", "createdAt", 30 * 86400); // was IndexOptionsConflict
  let ttl = (await db.collection("device_telemetry").indexes()).find((i) => i.key.createdAt);
  assert.equal(ttl.expireAfterSeconds, 30 * 86400);

  await ensureIndexes(db); // startup must not undo an admin-chosen retention
  ttl = (await db.collection("device_telemetry").indexes()).find((i) => i.key.createdAt);
  assert.equal(ttl.expireAfterSeconds, 30 * 86400);
});

test("backup streams typed JSON lines and keeps only BACKUP_KEEP backups", async () => {
  const { backupFullDatabase } = require("../scripts/backup_full_db");
  await db.collection("device_telemetry").insertOne({ deviceId: "d", createdAt: new Date(0), t: 1 });

  let dir;
  for (let i = 0; i < 3; i++) {
    dir = await backupFullDatabase();
    await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
  }
  const line = fs.readFileSync(path.join(dir, "device_telemetry.jsonl"), "utf8").trim();
  const doc = JSON.parse(line);
  assert.ok(doc._id.$oid, "ObjectId preserved");
  assert.ok(doc.createdAt.$date, "Date preserved");
  assert.equal(fs.readdirSync(tmp).filter((d) => d.startsWith("full_db_backup_")).length, 2);
});
