require("dotenv").config();
const { connectMongo, getDb } = require("../src/db/mongo");
const { backupFullDatabase } = require("./backup_full_db");

async function backupAndCleanupTelemetry(daysToKeep = 7) {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await connectMongo();
    const db = getDb();

    // 1. Perform FULL Database Backup first
    console.log("📦 Starting Full Database Backup before telemetry cleanup...");
    const backupDir = await backupFullDatabase();

    // 2. Telemetry Cleanup logic (direct database-level deletion)
    const telemetryCol = db.collection("device_telemetry");
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    console.log(`🗓️ Cleaning telemetry older than ${daysToKeep} days (before ${cutoffDate.toISOString()})...`);

    const deleteResult = await telemetryCol.deleteMany({
      createdAt: { $lt: cutoffDate }
    });
    console.log(`✅ Successfully deleted ${deleteResult.deletedCount} old telemetry records.`);

    // 3. Ensure TTL index on createdAt (7 days = 604,800 seconds)
    const expireSeconds = daysToKeep * 24 * 60 * 60;
    console.log(`⚡ Setting up TTL index on 'createdAt' (auto-expires after ${daysToKeep} days)...`);
    await telemetryCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: expireSeconds, background: true });
    console.log("✅ TTL index successfully ensured.");

    const remainingCount = await telemetryCol.countDocuments();
    console.log(`🎉 Cleanup complete! Remaining active telemetry records: ${remainingCount}`);
    console.log(`📁 Full Backup saved in: ${backupDir}`);
    return { backupDir, remainingCount, deletedCount: deleteResult.deletedCount };
  } catch (err) {
    console.error("❌ Backup and cleanup failed:", err);
    throw err;
  }
}

// Execute standalone if called directly via CLI
if (require.main === module) {
  backupAndCleanupTelemetry(7)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { backupAndCleanupTelemetry };

