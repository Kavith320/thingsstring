// src/automation/worker.js
// Evaluates automation flows and writes desired state to device_control.
// It does NOT connect to MQTT: the API process publishes device_control changes,
// and is the only process that ingests telemetry (avoids storing it twice).
require("dotenv").config({ quiet: true });

const { connectMongo, closeMongo } = require("../db/mongo");
const Agenda = require("agenda");
const { defineFlowJobs } = require("./flowJobs");
const { startFlowSync } = require("./flowSync");

async function startWorker() {
  await connectMongo();

  const agenda = new Agenda({
    db: { address: process.env.MONGO_URI, collection: "automation_jobs" },
    processEvery: "5 seconds",
  });

  defineFlowJobs(agenda);
  await agenda.start();
  console.log("🤖 Automation worker: Agenda started");

  const syncTimer = await startFlowSync(agenda, { intervalMs: 5000 });
  console.log("🤖 Automation worker fully started");

  async function graceful() {
    console.log("🤖 Automation worker shutting down...");
    clearInterval(syncTimer);
    await agenda.stop();
    await agenda.close();
    await closeMongo();
    process.exit(0);
  }

  process.on("SIGTERM", graceful);
  process.on("SIGINT", graceful);
}

startWorker().catch((e) => {
  console.error("❌ [AUTOMATION] Worker failed:", e);
  process.exit(1);
});
