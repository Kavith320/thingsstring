// src/automation/flowJobs.js
// The automation worker only WRITES desired state to device_control.
// The API process's change stream publishes it to the device over MQTT.

const { getDb } = require("../db/mongo");
const { parseObjectId } = require("../utils/http");
const {
  offlineThresholdSec,
  getDeviceOnlineState,
  isAutoMode,
  deviceOwnerId,
} = require("../services/deviceState");

/** Get a nested value using dot notation, own properties only. */
function getNestedValue(obj, path) {
  return path.split(".").reduce((acc, part) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined;
  }, obj);
}

function compare(operator, current, target) {
  switch (operator) {
    case ">": return current > target;
    case "<": return current < target;
    case ">=": return current >= target;
    case "<=": return current <= target;
    case "==": return current == target; // eslint-disable-line eqeqeq
    case "!=": return current != target; // eslint-disable-line eqeqeq
    default: return false;
  }
}

/**
 * Work out the $set for the actuator, matching the shape the device already uses:
 * string 'state'/'status' fields get "ON"/"OFF", others get the raw value.
 */
function buildActuatorSet(actuatorKey, actuatorObj, flowVal) {
  const $set = {};
  for (const field of ["state", "status"]) {
    const current = actuatorObj[field];
    const def = actuatorObj.default?.[field];
    if (current === undefined && def === undefined) continue;

    const isStringish = typeof current === "string" || typeof def === "string";
    $set[`actuators.${actuatorKey}.${field}`] = isStringish ? (flowVal ? "ON" : "OFF") : flowVal;
  }
  $set[`actuators.${actuatorKey}.value`] = flowVal;
  return $set;
}

/**
 * Run one evaluation of an automation flow. Exported for tests.
 */
async function runFlow(db, flowId) {
  const _id = parseObjectId(String(flowId));
  if (!_id) return;

  const flowsCol = db.collection("automation_flows");
  const flowStateCol = db.collection("automation_flow_state");
  const configCol = db.collection("device_config");
  const telemetryCol = db.collection("device_telemetry");
  const controlCol = db.collection("device_control");
  const logsCol = db.collection("automation_flow_logs");

  const flow = await flowsCol.findOne({ _id });
  if (!flow || !flow.enabled) return;

  const actuatorDeviceId = flow.action?.deviceId || flow.deviceId;
  const log = (entry) =>
    logsCol.insertOne({ flowId: _id, deviceId: flow.deviceId, actuatorDeviceId, ts: new Date(), ...entry });
  const saveValue = (value, extra = {}) =>
    flowStateCol.updateOne(
      { flowId: _id },
      { $set: { lastValue: value, lastValueTs: new Date(), ...extra } },
      { upsert: true }
    );

  // 1) The flow owner must still own both devices (devices can be transferred or deleted)
  const [sensorCfg, actuatorCfg] = await Promise.all([
    configCol.findOne({ _id: flow.deviceId }),
    configCol.findOne({ _id: actuatorDeviceId }),
  ]);
  if (!sensorCfg || !actuatorCfg) {
    return log({ status: "error", reason: "device not found" });
  }
  if (deviceOwnerId(sensorCfg) !== String(flow.user_id) || deviceOwnerId(actuatorCfg) !== String(flow.user_id)) {
    console.log(`🔒 [AUTOMATION] Flow "${flow.name}" skipped: owner no longer owns the device(s)`);
    return log({ status: "error", reason: "flow owner does not own device" });
  }

  // 2) Latest telemetry + offline check on the sensor
  const maxAgeSec = flow.maxTelemetryAgeSec || offlineThresholdSec();
  const latestTelemetry = await telemetryCol.findOne({ deviceId: flow.deviceId }, { sort: { _id: -1 } });
  if (!latestTelemetry) return log({ status: "skipped", reason: "no telemetry" });

  const sensorState = await getDeviceOnlineState(db, flow.deviceId, maxAgeSec);
  if (!sensorState.online) {
    console.log(`⏭️ [AUTOMATION] Device ${flow.deviceId} is OFFLINE (last telemetry ${sensorState.ageSec}s ago). Skipping flow "${flow.name}".`);
    return log({ status: "skipped", reason: "device offline (stale telemetry)", telemetryAgeSec: sensorState.ageSec });
  }

  // 3) Read the metric. A missing metric never triggers (previously `!=` fired on it).
  const currentValue = getNestedValue(latestTelemetry, flow.metricPath);
  if (currentValue === undefined || currentValue === null) {
    return log({ status: "skipped", reason: `metric '${flow.metricPath}' not in telemetry` });
  }

  // 4) Evaluate
  const flowState = (await flowStateCol.findOne({ flowId: _id })) || {};
  const { lastValue, lastActionTs } = flowState;
  const numeric = typeof currentValue === "number" && typeof lastValue === "number";
  const delta = lastValue !== undefined && numeric ? Math.abs(currentValue - lastValue) : null;

  let conditionMet;
  if (flow.condition && flow.condition.operator) {
    conditionMet = compare(flow.condition.operator, currentValue, flow.condition.value);
  } else if (lastValue === undefined) {
    // Delta mode, first run: remember the value and wait for a change
    return saveValue(currentValue);
  } else {
    conditionMet = delta !== null && delta > (flow.deltaThreshold || 0);
  }

  if (!conditionMet) return saveValue(currentValue);

  // 5) Cooldown
  const now = new Date();
  if (lastActionTs && now - new Date(lastActionTs) < (flow.cooldownSec || 0) * 1000) {
    return log({ status: "skipped", reason: "cooldown active", currentValue, operator: flow.condition?.operator || "delta" });
  }

  // 6) Target device checks: online (if it's a different hub) and not locked out
  if (actuatorDeviceId !== flow.deviceId) {
    const actState = await getDeviceOnlineState(db, actuatorDeviceId, maxAgeSec);
    if (!actState.online) {
      console.log(`⏭️ [AUTOMATION] Actuator device ${actuatorDeviceId} is OFFLINE. Skipping command.`);
      return log({ status: "skipped", reason: "actuator device offline", telemetryAgeSec: actState.ageSec });
    }
  }
  if (actuatorCfg.isDisabled) {
    console.log(`🔒 [AUTOMATION] Device ${actuatorDeviceId} is locked out by admin. Skipping automation command.`);
    return log({ status: "skipped", reason: "device locked out by admin" });
  }

  const control = (await controlCol.findOne({ _id: actuatorDeviceId })) || {};
  const actuatorKey = flow.action.actuatorKey;
  const actuatorObj = control.actuators?.[actuatorKey];

  if (!actuatorObj || typeof actuatorObj !== "object") {
    console.log(`[AUTOMATION] Actuator '${actuatorKey}' not found on device ${actuatorDeviceId}`);
    return log({ status: "error", reason: `actuator '${actuatorKey}' not found` });
  }
  if (!isAutoMode(actuatorObj)) {
    return log({ status: "skipped", reason: "manual mode", currentValue });
  }

  // 7) Write desired state (the API publishes it over MQTT)
  await controlCol.updateOne(
    { _id: actuatorDeviceId },
    { $set: buildActuatorSet(actuatorKey, actuatorObj, flow.action.setValue) }
  );

  console.log(
    `🚀 [AUTOMATION] Flow "${flow.name}" met (${currentValue} ${flow.condition?.operator || "Δ"} ${flow.condition?.value ?? flow.deltaThreshold}). Command written for ${actuatorDeviceId}.`
  );

  await saveValue(currentValue, { lastActionTs: now });
  await log({ status: "ran", currentValue, previousValue: lastValue, delta, action: flow.action });
}

function defineFlowJobs(agenda) {
  agenda.define("run_automation_flow", async (job) => {
    const { flowId } = job.attrs.data || {};
    if (!flowId) return;
    try {
      await runFlow(getDb(), flowId);
    } catch (error) {
      console.error(`❌ [AUTOMATION] Error in flow ${flowId}:`, error);
    }
  });
}

module.exports = { defineFlowJobs, runFlow, getNestedValue, buildActuatorSet };
