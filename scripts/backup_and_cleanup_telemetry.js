require("dotenv").config();
const fs = require("fs");
const path = require("path");
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

    // 2. Telemetry Cleanup logic
    const telemetryCol = db.collection("device_telemetry");
    const allTelemetry = await telemetryCol.find({}).toArray();

    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    console.log(`🗓️ Filtering telemetry older than ${daysToKeep} days (before ${cutoffDate.toISOString()})...`);

    const oldIds = [];
    allTelemetry.forEach((doc) => {
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

    console.log(`🗑️ Identified ${oldIds.length} telemetry records to delete out of ${allTelemetry.length} total.`);

    // 3. Delete old telemetry records
    if (oldIds.length > 0) {
      const deleteResult = await telemetryCol.deleteMany({ _id: { $in: oldIds } });
      console.log(`✅ Successfully deleted ${deleteResult.deletedCount} old telemetry records.`);
    } else {
      console.log("ℹ️ No telemetry records found older than cutoff date. Skipping deletion.");
    }

    // 4. Ensure TTL index on createdAt (7 days = 604,800 seconds)
    const expireSeconds = daysToKeep * 24 * 60 * 60;
    console.log(`⚡ Setting up TTL index on 'createdAt' (auto-expires after ${daysToKeep} days)...`);
    await telemetryCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: expireSeconds, background: true });
    console.log("✅ TTL index successfully ensured.");

    const remainingCount = await telemetryCol.countDocuments();
    console.log(`🎉 Cleanup complete! Remaining active telemetry records: ${remainingCount}`);
    console.log(`📁 Full Backup saved in: ${backupDir}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Backup and cleanup failed:", err);
    process.exit(1);
  }
}

backupAndCleanupTelemetry(7);
