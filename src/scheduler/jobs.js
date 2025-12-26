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
}

module.exports = { defineJobs };
