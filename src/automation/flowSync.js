const { getDb } = require("../db/mongo");

/**
 * Sync automation flows from MongoDB to Agenda jobs.
 *
 * A job is (re)saved ONLY when the flow is new or its interval changed.
 * Re-saving every sync recomputed nextRunAt = now + interval, so any flow whose
 * interval was longer than the sync period was pushed back forever and never ran.
 */
async function startFlowSync(agenda, { intervalMs = 5000 } = {}) {
  const flowsCol = getDb().collection("automation_flows");

  async function syncOnce() {
    const enabledFlows = await flowsCol.find({ enabled: true }, { projection: { intervalSec: 1 } }).toArray();
    const wanted = new Map(enabledFlows.map((f) => [String(f._id), `${f.intervalSec || 60} seconds`]));

    const existingJobs = await agenda.jobs({ name: "run_automation_flow" });
    const existing = new Map();
    for (const job of existingJobs) {
      const fid = String(job.attrs?.data?.flowId || "");
      if (!fid) continue;
      if (existing.has(fid)) {
        // Duplicate job for one flow (from older versions): drop the extra
        await job.remove();
        continue;
      }
      existing.set(fid, job);
    }

    // Create / update jobs whose interval changed
    for (const [flowId, interval] of wanted) {
      const job = existing.get(flowId);
      if (job && job.attrs.repeatInterval === interval && job.attrs.nextRunAt) continue;

      const next = agenda.create("run_automation_flow", { flowId });
      next.unique({ "data.flowId": flowId });
      next.repeatEvery(interval, { skipImmediate: true });
      await next.save();
      console.log(`🧠 [AUTOMATION] scheduled flowId=${flowId} every ${interval}`);
    }

    // Cancel jobs for disabled or deleted flows
    for (const fid of existing.keys()) {
      if (!wanted.has(fid)) {
        await agenda.cancel({ name: "run_automation_flow", "data.flowId": fid });
        console.log(`🧹 [AUTOMATION] canceled job for disabled/deleted flowId=${fid}`);
      }
    }
  }

  await syncOnce();
  console.log("🧠 Automation flow sync: initial load done");

  let running = false;
  const interval = setInterval(async () => {
    if (running) return; // never overlap syncs
    running = true;
    try {
      await syncOnce();
    } catch (e) {
      console.error("❌ [AUTOMATION] Flow sync error:", e.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  return interval;
}

module.exports = { startFlowSync };
