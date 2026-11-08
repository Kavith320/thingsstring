// src/automation/flowJobs.js
// The automation worker only WRITES desired state to device_control.
// The API process's change stream publishes it to the device over MQTT.

const { getDb } = require("../db/mongo");
const { notifyUser, deviceDisplayName } = require("../email/notify");

const AUTOMATION_EMAIL_WINDOW_MS = 15 * 60e3; // at most one email per rule per 15 min
const { parseObjectId } = require("../utils/http");
const { offlineThresholdSec, getDeviceOnlineState, isAutoMode } = require("../services/deviceState");
const { getDeviceAccess, atLeast } = require("../services/deviceAccess");
const { logActivity } = require("../services/activity");

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

  // 1) The rule's creator must still have access (devices can be transferred, deleted or unshared):
  //    viewer on the sensor, manager on the actuator device
  const [sensorAccess, actuatorAccess] = await Promise.all([
    getDeviceAccess(db, flow.deviceId, flow.user_id),
    flow.action ? getDeviceAccess(db, actuatorDeviceId, flow.user_id) : null,
  ]);
  const sensorExists = sensorAccess || (await configCol.countDocuments({ _id: flow.deviceId }, { limit: 1 }));
  if (!sensorExists) return log({ status: "error", reason: "device not found" });
  if (!sensorAccess || (flow.action && (!actuatorAccess || !atLeast(actuatorAccess.role, "manager")))) {
    console.log(`🔒 [AUTOMATION] Flow "${flow.name}" skipped: its creator no longer has access to the device(s)`);
    return log({ status: "error", reason: "flow owner has no access to the device" });
  }
  const actuatorCfg = actuatorAccess?.config || sensorAccess.config;

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

  // 5b) Alert-only rule: no actuator, just the email
  if (!flow.action) {
    const r = await sendFlowEmail(db, flow, { currentValue, actionText: null });
    await saveValue(currentValue, { lastActionTs: now });
    return log({ status: "ran", currentValue, previousValue: lastValue, delta, action: null, emailed: r.queued });
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
  await logActivity(db, {
    deviceId: actuatorDeviceId,
    actor: { type: "automation", id: String(_id), name: flow.name },
    action: "control.update",
    details: { actuators: { [actuatorKey]: { value: flow.action.setValue } }, reading: { [flow.metricPath]: currentValue } },
  });
  let emailed;
  if (flow.notify?.email) {
    const on = flow.action.setValue === true ? "ON" : flow.action.setValue === false ? "OFF" : JSON.stringify(flow.action.setValue);
    const target = actuatorDeviceId !== flow.deviceId ? ` on ${actuatorDeviceId}` : "";
    emailed = (await sendFlowEmail(db, flow, { currentValue, actionText: `Set ${actuatorKey} to ${on}${target}` })).queued;
  }
  await log({ status: "ran", currentValue, previousValue: lastValue, delta, action: flow.action, ...(emailed !== undefined ? { emailed } : {}) });
}

/** Email the flow owner that the rule fired (respects their settings and the hourly cap). */
async function sendFlowEmail(db, flow, { currentValue, actionText }) {
  if (!flow.notify?.email) return { queued: false };
  const { name, device } = await deviceDisplayName(db, flow.deviceId);
  return notifyUser(db, {
    userId: flow.user_id,
    category: "automation",
    template: "automationTriggered",
    data: {
      flowName: flow.name,
      deviceId: flow.deviceId,
      deviceName: name,
      device,
      metricPath: flow.metricPath,
      value: currentValue,
      operator: flow.condition?.operator || "changed by >",
      target: flow.condition ? flow.condition.value : flow.deltaThreshold,
      actionText,
    },
    dedupeKey: `flow:${flow._id}`,
    dedupeWindowMs: Math.max((flow.cooldownSec || 0) * 1000, AUTOMATION_EMAIL_WINDOW_MS),
  });
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
