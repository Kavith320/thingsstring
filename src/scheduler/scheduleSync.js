// src/scheduler/scheduleSync.js
const crypto = require("crypto");
const { getDb } = require("../db/mongo");

/** Fingerprint of everything a schedule's job depends on. */
function scheduleHash(s) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([s.deviceId, s.cron, s.timezone || "UTC", s.actions || [], s.end_actions || [], s.duration_sec ?? null])
    )
    .digest("hex");
}

/**
 * Sync enabled schedules to Agenda jobs.
 * A job is only (re)saved when the schedule is new or changed (by hash); re-saving
 * an unchanged job every few seconds can move its nextRunAt past a due run.
 */
async function startScheduleSync(agenda, { intervalMs = 5000 } = {}) {
  const schedulesCol = getDb().collection("device_schedules");

  async function syncOnce() {
    const schedules = await schedulesCol.find({ enabled: true }).toArray();
    const enabledIds = new Set(schedules.map((s) => String(s._id)));

    const existing = new Map();
    for (const j of await agenda.jobs({ name: "run-device-schedule" })) {
      const sid = String(j.attrs?.data?.scheduleId || "");
      if (sid) existing.set(sid, j);
    }

    for (const s of schedules) {
      const scheduleId = String(s._id);
      const hash = scheduleHash(s);
      const job = existing.get(scheduleId);
      if (job && job.attrs.data?.hash === hash && job.attrs.nextRunAt) continue;

      const next = agenda.create("run-device-schedule", {
        scheduleId,
        deviceId: s.deviceId,
        actions: s.actions || [],
        end_actions: s.end_actions || [],
        duration_sec: s.duration_sec ?? null,
        hash,
      });
      next.unique({ "data.scheduleId": scheduleId });
      next.repeatEvery(s.cron, { timezone: s.timezone || "UTC", skipImmediate: true });

      if (!next.attrs.nextRunAt) {
        console.error(`❌ [SCHEDULER] schedule=${scheduleId} has an invalid cron '${s.cron}' — not scheduled`);
        continue;
      }
      await next.save();
      console.log(`🧠 [SCHEDULER] (re)scheduled schedule=${scheduleId} cron='${s.cron}'`);
    }

    // Cancel jobs for deleted/disabled schedules (START + END)
    for (const sid of existing.keys()) {
      if (!enabledIds.has(sid)) {
        await agenda.cancel({ name: "run-device-schedule", "data.scheduleId": sid });
        await agenda.cancel({ name: "run-device-schedule-end", "data.scheduleId": sid });
        console.log(`🧹 [SCHEDULER] canceled jobs for deleted/disabled scheduleId=${sid}`);
      }
    }
  }

  await syncOnce();
  console.log("🧠 Schedule sync: initial load done");

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await syncOnce();
    } catch (e) {
      console.error("❌ Schedule sync error:", e.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  console.log(`🧠 Schedule sync loop started (every ${intervalMs / 1000}s)`);
  return timer;
}

module.exports = { startScheduleSync, scheduleHash };
