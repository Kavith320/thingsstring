const { getDb } = require("../db/mongo");

/**
 * Sync automation flows from MongoDB to Agenda jobs
 */
async function startFlowSync(agenda, { intervalMs = 5000 } = {}) {
    const db = getDb();
    const flowsCol = db.collection("automation_flows");

    async function syncOnce() {
        try {
            const enabledFlows = await flowsCol.find({ enabled: true }).toArray();
            const enabledIds = new Set(enabledFlows.map((f) => String(f._id)));

            // ✅ Upsert jobs for enabled flows
            for (const flow of enabledFlows) {
                const flowId = String(flow._id);
                const intervalSec = flow.intervalSec || 60;

                const job = agenda.create("run_automation_flow", { flowId });

                // Use uniqueness to prevent duplicate jobs for the same flow
                job.unique({ "data.flowId": flowId });

                // Schedule repetition
                job.repeatEvery(`${intervalSec} seconds`, {
                    skipImmediate: true
                });

                await job.save();
            }

            // ✅ Cancel jobs for disabled or deleted flows
            const existingJobs = await agenda.jobs({ name: "run_automation_flow" });

            for (const job of existingJobs) {
                const fid = String(job.attrs?.data?.flowId || "");
                if (fid && !enabledIds.has(fid)) {
                    await agenda.cancel({ name: "run_automation_flow", "data.flowId": fid });
                    console.log(`🧹 [AUTOMATION] canceled job for disabled/deleted flowId=${fid}`);
                }
            }
        } catch (error) {
            console.error("❌ [AUTOMATION] Flow sync error:", error.message);
        }
    }

    // Initial sync
    await syncOnce();
    console.log("🧠 Automation flow sync: initial load done");

    // Periodic sync
    const interval = setInterval(() => {
        syncOnce().catch((e) => console.error("❌ [AUTOMATION] Flow sync error:", e.message));
    }, intervalMs);

    return interval;
}

module.exports = { startFlowSync };
