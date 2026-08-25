require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { connectMongo, getDb } = require("../src/db/mongo");

async function backupFullDatabase() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await connectMongo();
    const db = getDb();

    // Get all collections in the database
    const collections = await db.listCollections().toArray();
    console.log(`📦 Found ${collections.length} collections in database.`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(__dirname, "../backups", `full_db_backup_${timestamp}`);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const fullDatabaseExport = {};
    let totalDocsCount = 0;

    for (const colInfo of collections) {
      const colName = colInfo.name;
      // Skip system collections
      if (colName.startsWith("system.")) continue;

      const col = db.collection(colName);
      const docs = await col.find({}).toArray();
      totalDocsCount += docs.length;

      fullDatabaseExport[colName] = docs;

      // Save individual collection JSON
      const colFilePath = path.join(backupDir, `${colName}.json`);
      fs.writeFileSync(colFilePath, JSON.stringify(docs, null, 2), "utf8");
      console.log(`  └─ Saved '${colName}': ${docs.length} documents -> ${colFilePath}`);
    }

    // Save combined full database JSON
    const combinedFilePath = path.join(backupDir, "_full_database.json");
    fs.writeFileSync(combinedFilePath, JSON.stringify(fullDatabaseExport, null, 2), "utf8");

    console.log("\n==========================================");
    console.log(`✅ Full Database Backup Completed!`);
    console.log(`📁 Backup Folder: ${backupDir}`);
    console.log(`📊 Total Collections: ${Object.keys(fullDatabaseExport).length}`);
    console.log(`📄 Total Documents Backed Up: ${totalDocsCount}`);
    console.log("==========================================\n");

    return backupDir;
  } catch (err) {
    console.error("❌ Full Database Backup Failed:", err);
    throw err;
  }
}

// Execute standalone if called directly
if (require.main === module) {
  backupFullDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { backupFullDatabase };
