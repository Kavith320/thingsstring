require("dotenv").config({ quiet: true });
const { connectMongo, getDb } = require("../src/db/mongo");
const { ensureTtlIndex } = require("../src/db/indexes");
const { backupFullDatabase } = require("./backup_full_db");

async function backupAndCleanupTelemetry(daysToKeep = 7) {
  console.log("🔌 Connecting to MongoDB...");
  await connectMongo();
  const db = getDb();

  // 1. Full database backup first
  console.log("📦 Starting Full Database Backup before telemetry cleanup...");
  const backupDir = await backupFullDatabase();

  // 2. Delete telemetry older than the retention window
  const telemetryCol = db.collection("device_telemetry");
  const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
  console.log(`🗓️ Cleaning telemetry older than ${daysToKeep} days (before ${cutoffDate.toISOString()})...`);
  const deleteResult = await telemetryCol.deleteMany({ createdAt: { $lt: cutoffDate } });
  console.log(`✅ Deleted ${deleteResult.deletedCount} old telemetry records.`);

  // 3. Keep the TTL index in line with the retention (adjusted in place if it differs)
  await ensureTtlIndex(db, "device_telemetry", "createdAt", daysToKeep * 24 * 60 * 60);

  const remainingCount = await telemetryCol.estimatedDocumentCount();
  console.log(`🎉 Cleanup complete! Remaining telemetry records: ~${remainingCount}`);
  return { backupDir, remainingCount, deletedCount: deleteResult.deletedCount };
}

// Execute standalone if called directly via CLI
if (require.main === module) {
  backupAndCleanupTelemetry(7)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Backup and cleanup failed:", err);
      process.exit(1);
    });
}

module.exports = { backupAndCleanupTelemetry };
