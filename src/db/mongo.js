const mongoose = require("mongoose");

let db;

async function connectMongo(retries = 5, delayMs = 3000) {
  if (db) return;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("❌ MONGO_URI missing in .env");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        socketTimeoutMS: 45000,
        maxIdleTimeMS: 30000, // Close idle connections after 30s to prevent ECONNRESET by network firewalls
        maxPoolSize: 10,
        minPoolSize: 2,
        heartbeatFrequencyMS: 10000, // Ping MongoDB every 10s to keep connection alive
        retryWrites: true,
        retryReads: true,
        family: 4, // Force IPv4 — avoids ESERVFAIL / EREFUSED on Linux servers
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
