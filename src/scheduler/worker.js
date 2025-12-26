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

  // ✅ less aggressive than 1s (recommended)
  await startScheduleSync(agenda, { intervalMs: 5000 });

  console.log("🧠 Scheduler worker started");
}

startWorker().catch((e) => {
  console.error("❌ Scheduler worker failed:", e);
  process.exit(1);
  
});
