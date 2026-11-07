require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { EJSON } = require("mongoose").mongo.BSON;
const { connectMongo, getDb } = require("../src/db/mongo");

const BACKUP_ROOT = process.env.BACKUP_DIR || path.join(__dirname, "../backups");
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || "8", 10) || 8);

/** Write one document per line (canonical Extended JSON keeps ObjectId/Date types). */
async function dumpCollection(col, filePath) {
  const out = fs.createWriteStream(filePath, { encoding: "utf8", mode: 0o600 });
  let count = 0;
  try {
    for await (const doc of col.find({})) {
      if (!out.write(EJSON.stringify(doc, { relaxed: false }) + "\n")) {
        await new Promise((r) => out.once("drain", r));
      }
      count++;
    }
  } finally {
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  }
  return count;
}

/** Keep only the newest BACKUP_KEEP backups. */
function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return;
  const dirs = fs
    .readdirSync(BACKUP_ROOT)
    .filter((d) => d.startsWith("full_db_backup_"))
    .sort(); // ISO timestamps sort chronologically
  for (const d of dirs.slice(0, Math.max(0, dirs.length - BACKUP_KEEP))) {
    fs.rmSync(path.join(BACKUP_ROOT, d), { recursive: true, force: true });
    console.log(`🧹 Removed old backup ${d}`);
  }
}

/**
 * Full database backup: <BACKUP_DIR>/full_db_backup_<timestamp>/<collection>.jsonl
 * Restore one collection with:
 *   mongoimport --uri "$MONGO_URI" --collection <name> --file <name>.jsonl
 * Streams each collection, so memory use stays flat however big the database is.
 * NOTE: backups contain password hashes — keep the folder private.
 */
async function backupFullDatabase() {
  console.log("🔌 Connecting to MongoDB...");
  await connectMongo();
  const db = getDb();

  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).filter(
    (c) => !c.name.startsWith("system.")
  );
  console.log(`📦 Found ${collections.length} collections in database.`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(BACKUP_ROOT, `full_db_backup_${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  let total = 0;
  for (const { name } of collections) {
    const filePath = path.join(backupDir, `${name}.jsonl`);
    const n = await dumpCollection(db.collection(name), filePath);
    total += n;
    console.log(`  └─ Saved '${name}': ${n} documents`);
  }

  console.log(`✅ Full Database Backup Completed: ${collections.length} collections, ${total} documents -> ${backupDir}`);
  pruneOldBackups();
  return backupDir;
}

// Execute standalone if called directly
if (require.main === module) {
  backupFullDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Full Database Backup Failed:", err);
      process.exit(1);
    });
}

module.exports = { backupFullDatabase };
