// src/scheduler/jobs.js
const { getDb } = require("../db/mongo");

/**
 * Apply actions to device_control
 * - Only updates actuators where auto === true
 * - Does NOT publish MQTT (publisher handles that)
 */
async function applyActions(deviceId, actions) {
  const db = getDb();
  const controlCol = db.collection("device_control");
  const telemetryCol = db.collection("device_telemetry");

  // Check if device is OFFLINE (telemetry recency threshold: default 5 minutes / 300 seconds)
  const lastTelemetry = await telemetryCol.findOne(
    { deviceId },
    { sort: { _id: -1 } }
  );

  if (lastTelemetry) {
    const telemetryTime = lastTelemetry.createdAt
      ? new Date(lastTelemetry.createdAt).getTime()
      : (lastTelemetry._id?.getTimestamp ? lastTelemetry._id.getTimestamp().getTime() : 0);

    const maxAgeSec = parseInt(process.env.DEVICE_OFFLINE_THRESHOLD_SEC || "300", 10);
    const ageSec = Math.floor((Date.now() - telemetryTime) / 1000);

    if (ageSec > maxAgeSec) {
      console.log(`⏭️ [SCHEDULER] Device ${deviceId} is OFFLINE (last telemetry was ${ageSec}s ago). Skipping schedule actions.`);
      return;
    }
  }

  const control = (await controlCol.findOne({ _id: deviceId })) || {};
  const actuators = control.actuators || {};

  const $set = {};

  for (const action of actions || []) {
    const actuatorName = action.actuator;
    const patch = action.set || {};

    if (!actuators[actuatorName]) {
      console.log(`⚠️ [SCHEDULER] actuator '${actuatorName}' not found on device ${deviceId}`);
      continue;
    }

    if (actuators[actuatorName].default?.auto !== true) {
      console.log(`⏭️ [SCHEDULER] actuator '${actuatorName}' skipped (manual mode)`);
      continue;
    }

    for (const [key, value] of Object.entries(patch)) {
      $set[`actuators.${actuatorName}.${key}`] = value;
    }
  }

  if (Object.keys($set).length === 0) {
    console.log(`⚠️ [SCHEDULER] No actions applied for device ${deviceId}`);
    return;
  }

  await controlCol.updateOne({ _id: deviceId }, { $set }, { upsert: true });
  console.log(`✅ [SCHEDULER] device_control updated for device ${deviceId}`);
}

/**
 * Define Agenda jobs
 */
function defineJobs(agenda) {
  // 🔹 START actions
  agenda.define("run-device-schedule", async (job) => {
    const { scheduleId, deviceId, actions, end_actions, duration_sec } = job.attrs.data || {};

    console.log(`⏰ [SCHEDULER] START schedule=${scheduleId} device=${deviceId} at ${new Date().toISOString()}`);

    await applyActions(deviceId, actions);

    // Handle duration → schedule END job
    if (duration_sec && Array.isArray(end_actions) && end_actions.length > 0) {
      // ✅ IMPORTANT: prevent multiple queued end jobs for same schedule
      await agenda.cancel({ name: "run-device-schedule-end", "data.scheduleId": String(scheduleId) });

      console.log(`⏳ [SCHEDULER] scheduling END in ${duration_sec}s for schedule=${scheduleId} device=${deviceId}`);

      await agenda.schedule(`${duration_sec} seconds`, "run-device-schedule-end", {
        scheduleId: String(scheduleId),
        deviceId,
        end_actions,
      });
    }
  });

  // 🔹 END actions
  agenda.define("run-device-schedule-end", async (job) => {
    const { scheduleId, deviceId, end_actions } = job.attrs.data || {};

    console.log(`⏰ [SCHEDULER] END schedule=${scheduleId} device=${deviceId} at ${new Date().toISOString()}`);

    await applyActions(deviceId, end_actions);
  });

  // 📦 WEEKLY BACKUP & TELEMETRY CLEANUP
  agenda.define("weekly-backup-and-cleanup", async () => {
    console.log(`📦 [SCHEDULER] Starting scheduled weekly backup & telemetry cleanup at ${new Date().toISOString()}...`);
    const { backupAndCleanupTelemetry } = require("../../scripts/backup_and_cleanup_telemetry");
    try {
      await backupAndCleanupTelemetry(7);
      console.log(`✅ [SCHEDULER] Weekly backup & telemetry cleanup finished successfully.`);
    } catch (err) {
      console.error(`❌ [SCHEDULER] Weekly backup failed:`, err.message);
    }
  });
}

module.exports = { defineJobs };

