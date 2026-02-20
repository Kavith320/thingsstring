// src/automation/worker.js
require("dotenv").config();

const { connectMongo } = require("../db/mongo");
const Agenda = require("agenda");
const { defineFlowJobs } = require("./flowJobs");
const { startFlowSync } = require("./flowSync");

async function startWorker() {
    await connectMongo();

    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error("MONGO_URI missing in .env");

    // Create a separate agenda instance for automation
    const agenda = new Agenda({
        db: {
            address: mongoUri,
            collection: "automation_jobs", // Separate collection for automation
        },
        processEvery: "5 seconds",
    });

    // Define jobs
    defineFlowJobs(agenda);

    // Start agenda
    await agenda.start();
    console.log("🤖 Automation worker: Agenda started");

    // Start sync loop
    await startFlowSync(agenda, { intervalMs: 5000 });

    console.log("🤖 Automation worker fully started");

    // Graceful shutdown
    async function graceful() {
        console.log("🤖 Automation worker shutting down...");
        await agenda.stop();
        process.exit(0);
    }

    process.on("SIGTERM", graceful);
    process.on("SIGINT", graceful);
}

startWorker().catch((e) => {
    console.error("❌ [AUTOMATION] Worker failed:", e);
    process.exit(1);
});
