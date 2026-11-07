// src/scheduler/jobs.js
const { getDb } = require("../db/mongo");
const { getDeviceOnlineState, isAutoMode } = require("../services/deviceState");

/**
 * Apply schedule actions to device_control.
 * - Only updates actuators in AUTO mode, never on admin-locked devices.
 * - START actions are skipped while the device is offline (no ghost triggers).
 * - END actions are ALWAYS written, even if the device is offline: the control
 *   message is retained, so the device receives "off" as soon as it reconnects.
 *   Skipping them used to leave e.g. a pump running indefinitely.
 * - Does NOT publish MQTT (the API's change stream publishes device_control).
 *
 * Returns a short result string (used by tests and logs).
 */
async function applyActions(deviceId, actions, { phase = "start" } = {}) {
  const db = getDb();
  const controlCol = db.collection("device_control");
  const tag = phase === "end" ? "END" : "START";

  const config = await db.collection("device_config").findOne({ _id: deviceId }, { projection: { isDisabled: 1 } });
  if (!config) {
    console.log(`⚠️ [SCHEDULER] ${tag}: device ${deviceId} not found`);
    return "device-missing";
  }
  if (config.isDisabled) {
    console.log(`🔒 [SCHEDULER] ${tag}: device ${deviceId} is locked out by admin. Skipping.`);
    return "locked";
  }

  if (phase === "start") {
    const { online, ageSec } = await getDeviceOnlineState(db, deviceId);
    if (!online) {
      console.log(
        `⏭️ [SCHEDULER] Device ${deviceId} is OFFLINE (${ageSec === null ? "no telemetry" : `last telemetry ${ageSec}s ago`}). Skipping START actions.`
      );
      return "offline";
    }
  }

  const control = (await controlCol.findOne({ _id: deviceId })) || {};
  const actuators = control.actuators || {};
  const $set = {};

  for (const action of actions || []) {
    const actuatorName = action.actuator;
    const patch = action.set || {};

    if (!actuators[actuatorName] || typeof actuators[actuatorName] !== "object") {
      console.log(`⚠️ [SCHEDULER] actuator '${actuatorName}' not found on device ${deviceId}`);
      continue;
    }
    if (!isAutoMode(actuators[actuatorName])) {
      console.log(`⏭️ [SCHEDULER] actuator '${actuatorName}' skipped (manual mode)`);
      continue;
    }
    for (const [key, value] of Object.entries(patch)) {
      $set[`actuators.${actuatorName}.${key}`] = value;
    }
  }

  if (Object.keys($set).length === 0) {
    console.log(`⚠️ [SCHEDULER] No ${tag} actions applied for device ${deviceId}`);
    return "nothing";
  }

  await controlCol.updateOne({ _id: deviceId }, { $set }, { upsert: true });
  console.log(`✅ [SCHEDULER] ${tag}: device_control updated for device ${deviceId}`);
  return "applied";
}

/**
 * Define Agenda jobs
 */
function defineJobs(agenda) {
  // 🔹 START actions
  agenda.define("run-device-schedule", async (job) => {
    const { scheduleId, deviceId, actions, end_actions, duration_sec } = job.attrs.data || {};
    console.log(`⏰ [SCHEDULER] START schedule=${scheduleId} device=${deviceId} at ${new Date().toISOString()}`);

    const result = await applyActions(deviceId, actions, { phase: "start" });

    // Only schedule an END if the START actually changed something
    if (result === "applied" && duration_sec && Array.isArray(end_actions) && end_actions.length > 0) {
      // prevent multiple queued end jobs for the same schedule
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
    await applyActions(deviceId, end_actions, { phase: "end" });
    // One-off job: remove it once done so finished END jobs don't pile up
    await job.remove().catch(() => {});
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

module.exports = { defineJobs, applyActions };
