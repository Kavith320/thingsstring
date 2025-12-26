const mongoose = require("mongoose");

let db;

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("❌ MONGO_URI missing in .env");

  await mongoose.connect(uri);
  db = mongoose.connection.db;
  console.log("✅ MongoDB connected");
}

function getDb() {
  if (!db) throw new Error("❌ MongoDB not ready yet");
  return db;
}

module.exports = { connectMongo, getDb };
