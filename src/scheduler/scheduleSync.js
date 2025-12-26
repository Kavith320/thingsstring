// src/scheduler/scheduleSync.js
const { getDb } = require("../db/mongo");

async function startScheduleSync(agenda, { intervalMs = 5000 } = {}) {
  const db = getDb();
  const schedulesCol = db.collection("device_schedules");

  async function syncOnce() {
    const schedules = await schedulesCol.find({ enabled: true }).toArray();
    const enabledIds = new Set(schedules.map((s) => String(s._id)));

    // ✅ Upsert jobs for enabled schedules (UNIQUE prevents duplicates)
    for (const s of schedules) {
      const scheduleId = String(s._id);

      const job = agenda.create("run-device-schedule", {
        scheduleId,
        deviceId: s.deviceId,
        actions: s.actions || [],
        end_actions: s.end_actions || [],
        duration_sec: s.duration_sec ?? null,
      });

      job.unique({ "data.scheduleId": scheduleId }); // ✅ CRITICAL
      job.repeatEvery(s.cron, {
        timezone: s.timezone || "UTC",
        skipImmediate: true,
      });

      await job.save();
    }

    // ✅ Cancel jobs for deleted/disabled schedules (START + END)
    const existing = await agenda.jobs({ name: "run-device-schedule" });

    for (const j of existing) {
      const sid = String(j.attrs?.data?.scheduleId || "");
      if (sid && !enabledIds.has(sid)) {
        await agenda.cancel({ name: "run-device-schedule", "data.scheduleId": sid });
        await agenda.cancel({ name: "run-device-schedule-end", "data.scheduleId": sid });

        console.log(`🧹 [SCHEDULER] canceled jobs for deleted/disabled scheduleId=${sid}`);
      }
    }
  }

  await syncOnce();
  console.log("🧠 Schedule sync: initial load done");

  setInterval(() => {
    syncOnce().catch((e) => console.error("❌ Schedule sync error:", e.message));
  }, intervalMs);

  console.log(`🧠 Schedule sync loop started (every ${intervalMs / 1000}s)`);
}

module.exports = { startScheduleSync };
