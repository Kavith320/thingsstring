// src/scheduler/worker.js
// Runs schedules and the weekly backup. Writes device_control only; the API
// process publishes those changes to devices over MQTT.
require("dotenv").config({ quiet: true });

const { connectMongo, closeMongo } = require("../db/mongo");
const { createAgenda } = require("./agenda");
const { defineJobs } = require("./jobs");
const { startScheduleSync } = require("./scheduleSync");

async function startWorker() {
  await connectMongo();

  const agenda = createAgenda(process.env.MONGO_URI);
  defineJobs(agenda);
  await agenda.start();

  // 📦 Weekly DB backup & telemetry cleanup (Every Sunday at 02:00 server time, or BACKUP_TIMEZONE if set)
  const tz = process.env.BACKUP_TIMEZONE ? { timezone: process.env.BACKUP_TIMEZONE } : {};
  await agenda.every("0 2 * * 0", "weekly-backup-and-cleanup", {}, tz);
  console.log("📅 Scheduled automatic weekly backup (Every Sunday at 02:00)");

  const timer = await startScheduleSync(agenda, { intervalMs: 5000 });
  console.log("🧠 Scheduler worker started");

  async function graceful() {
    console.log("🧠 Scheduler worker shutting down...");
    clearInterval(timer);
    await agenda.stop();
    await agenda.close();
    await closeMongo();
    process.exit(0);
  }
  process.on("SIGTERM", graceful);
  process.on("SIGINT", graceful);
}

startWorker().catch((e) => {
  console.error("❌ Scheduler worker failed:", e);
  process.exit(1);
});
