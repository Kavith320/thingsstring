// src/scheduler/worker.js
require("dotenv").config();

const { connectMongo } = require("../db/mongo");
const { createAgenda } = require("./agenda");
const { defineJobs } = require("./jobs");
const { startScheduleSync } = require("./scheduleSync");

async function startWorker() {
  await connectMongo();

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error("MONGO_URI missing in .env");

  const agenda = createAgenda(mongoUri);

  defineJobs(agenda);

  await agenda.start();

  // 📦 Schedule weekly DB backup & telemetry cleanup (Every Sunday at 2:00 AM)
  await agenda.every("0 2 * * 0", "weekly-backup-and-cleanup");
  console.log("📅 Scheduled automatic weekly backup (Every Sunday at 02:00 AM)");

  // ✅ less aggressive than 1s (recommended)
  await startScheduleSync(agenda, { intervalMs: 5000 });

  console.log("🧠 Scheduler worker started");
}

startWorker().catch((e) => {
  console.error("❌ Scheduler worker failed:", e);
  process.exit(1);
  
});
