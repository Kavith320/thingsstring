const mongoose = require("mongoose");

let db;

async function connectMongo(retries = 5, delayMs = 3000) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("❌ MONGO_URI missing in .env");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000, // 10s to find a server
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        family: 4, // Force IPv4 — avoids ESERVFAIL on many Linux servers
      });
      db = mongoose.connection.db;
      console.log("✅ MongoDB connected");
      return;
    } catch (err) {
      console.error(`⚠️  MongoDB connection attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt < retries) {
        const wait = delayMs * attempt; // exponential-ish backoff
        console.log(`🔄 Retrying in ${wait / 1000}s...`);
        await new Promise((res) => setTimeout(res, wait));
      } else {
        throw err; // All retries exhausted
      }
    }
  }
}

function getDb() {
  if (!db) throw new Error("❌ MongoDB not ready yet");
  return db;
}

module.exports = { connectMongo, getDb };
