require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { connectMongo, getDb } = require("../src/db/mongo");

async function backupAndCleanupTelemetry(daysToKeep = 7) {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await connectMongo();
    const db = getDb();
    const telemetryCol = db.collection("device_telemetry");

    // 1. Fetch all telemetry records
    console.log("📦 Fetching all telemetry records for backup...");
    const allTelemetry = await telemetryCol.find({}).toArray();
    console.log(`📊 Found total ${allTelemetry.length} telemetry records in DB.`);

    // 2. Save backup file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(__dirname, "../backups");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupPath = path.join(backupDir, `telemetry_backup_${timestamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(allTelemetry, null, 2), "utf8");
    console.log(`✅ Backup successfully saved to: ${backupPath}`);

    // 3. Identify records older than specified days
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    console.log(`🗓️ Filtering telemetry older than ${daysToKeep} days (before ${cutoffDate.toISOString()})...`);

    const oldIds = [];
    allTelemetry.forEach((doc) => {
      // Determine record date: doc.createdAt or fallback to ObjectId timestamp
      let docDate = null;
      if (doc.createdAt) {
        docDate = new Date(doc.createdAt);
      } else if (doc._id && typeof doc._id.getTimestamp === "function") {
        docDate = doc._id.getTimestamp();
      }

      if (docDate && docDate < cutoffDate) {
        oldIds.push(doc._id);
      }
    });

    console.log(`🗑️ Identified ${oldIds.length} telemetry records to delete.`);

    // 4. Delete old records
    if (oldIds.length > 0) {
      const deleteResult = await telemetryCol.deleteMany({ _id: { $in: oldIds } });
      console.log(`✅ Successfully deleted ${deleteResult.deletedCount} old telemetry records.`);
    } else {
      console.log("ℹ️ No records found older than cutoff date. Skipping deletion.");
    }

    // 5. Ensure TTL index on createdAt (7 days = 604,800 seconds)
    const expireSeconds = daysToKeep * 24 * 60 * 60;
    console.log(`⚡ Setting up TTL index on 'createdAt' (auto-expires after ${daysToKeep} days)...`);
    await telemetryCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: expireSeconds, background: true });
    console.log("✅ TTL index successfully ensured.");

    const remainingCount = await telemetryCol.countDocuments();
    console.log(`🎉 Cleanup complete! Remaining active telemetry records: ${remainingCount}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Backup and cleanup failed:", err);
    process.exit(1);
  }
}

backupAndCleanupTelemetry(7);
