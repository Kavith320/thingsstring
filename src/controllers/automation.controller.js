const { getDb } = require("../db/mongo");
const { findOwnedDevice } = require("../services/deviceState");
const { sendServerError, parseObjectId, isPlainObject, isSafeKey, clampInt } = require("../utils/http");

/**
 * Automation Flow CRUD Controller
 */

const OPERATORS = new Set([">", "<", ">=", "<=", "==", "!="]);
const MIN_INTERVAL_SEC = 5;
const MAX_INTERVAL_SEC = 24 * 3600;
const MAX_UI_METADATA_BYTES = 256 * 1024;

/**
 * Validate a full flow definition (create, or existing+patch on update)
 * and check the user owns BOTH the sensor device and the actuator device.
 * Returns { error, status } or { flow } with normalised values.
 */
async function validateFlow(db, userId, input) {
  const { name, deviceId, enabled, intervalSec, metricPath, deltaThreshold, condition, action, cooldownSec, ui_metadata } =
    input;

  if (typeof deviceId !== "string" || !deviceId) return { error: "deviceId is required" };
  if (typeof metricPath !== "string" || !metricPath || metricPath.length > 200 || !metricPath.split(".").every(isSafeKey)) {
    return { error: "metricPath must be a dot path like 'data.temp'" };
  }
  if (!isPlainObject(action) || typeof action.actuatorKey !== "string" || !isSafeKey(action.actuatorKey)) {
    return { error: "action.actuatorKey is required" };
  }
  if (action.setValue === undefined) return { error: "action.setValue is required" };
  if (action.deviceId !== undefined && action.deviceId !== null && typeof action.deviceId !== "string") {
    return { error: "action.deviceId must be a string" };
  }

  let normCondition = null;
  if (condition !== undefined && condition !== null) {
    if (!isPlainObject(condition) || !OPERATORS.has(condition.operator)) {
      return { error: `condition.operator must be one of ${[...OPERATORS].join(" ")}` };
    }
    if (condition.value === undefined) return { error: "condition.value is required" };
    normCondition = { operator: condition.operator, value: condition.value };
  }

  if (ui_metadata !== undefined && ui_metadata !== null) {
    if (!isPlainObject(ui_metadata)) return { error: "ui_metadata must be an object" };
    if (JSON.stringify(ui_metadata).length > MAX_UI_METADATA_BYTES) return { error: "ui_metadata is too large" };
  }

  const actionDeviceId = action.deviceId || deviceId;
  const [sensor, actuator] = await Promise.all([
    findOwnedDevice(db, deviceId, userId),
    findOwnedDevice(db, actionDeviceId, userId),
  ]);
  if (!sensor) return { status: 404, error: `Device '${deviceId}' not found` };
  if (!actuator) return { status: 404, error: `Device '${actionDeviceId}' not found` };
  if (!isPlainObject(actuator.actuators) || !Object.prototype.hasOwnProperty.call(actuator.actuators, action.actuatorKey)) {
    return { error: `Unknown actuator '${action.actuatorKey}' on device '${actionDeviceId}'` };
  }

  const threshold = parseFloat(deltaThreshold);
  return {
    flow: {
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : "Untitled Flow",
      deviceId,
      enabled: enabled === undefined ? true : !!enabled,
      intervalSec: clampInt(intervalSec, { min: MIN_INTERVAL_SEC, max: MAX_INTERVAL_SEC, fallback: 60 }),
      metricPath,
      deltaThreshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : 0,
      condition: normCondition,
      action: { deviceId: actionDeviceId, actuatorKey: action.actuatorKey, setValue: action.setValue },
      cooldownSec: clampInt(cooldownSec, { min: 0, max: 7 * 86400, fallback: 60 }),
      ui_metadata: ui_metadata || {},
    },
  };
}

// Create flow
exports.createFlow = async (req, res) => {
  try {
    const db = getDb();
    const result = await validateFlow(db, req.user.id, req.body || {});
    if (result.error) return res.status(result.status || 400).json({ ok: false, error: result.error });

    const now = new Date();
    const newFlow = { user_id: req.user.id, ...result.flow, createdAt: now, updatedAt: now };
    const inserted = await db.collection("automation_flows").insertOne(newFlow);

    return res.status(201).json({ ok: true, flow: { ...newFlow, _id: inserted.insertedId } });
  } catch (error) {
    return sendServerError(res, error, "create flow");
  }
};

// List flows by user
exports.listFlows = async (req, res) => {
  try {
    const flows = await getDb().collection("automation_flows").find({ user_id: req.user.id }).toArray();
    return res.json({ ok: true, flows });
  } catch (error) {
    return sendServerError(res, error, "list flows");
  }
};

// Get one flow
exports.getFlow = async (req, res) => {
  try {
    const _id = parseObjectId(req.params.id);
    if (!_id) return res.status(400).json({ ok: false, error: "Invalid flow id" });

    const flow = await getDb().collection("automation_flows").findOne({ _id, user_id: req.user.id });
    if (!flow) return res.status(404).json({ ok: false, error: "Flow not found" });

    return res.json({ ok: true, flow });
  } catch (error) {
    return sendServerError(res, error, "get flow");
  }
};

// Update flow (partial). The merged result is re-validated, including device ownership.
const UPDATABLE = [
  "name",
  "deviceId",
  "enabled",
  "intervalSec",
  "metricPath",
  "deltaThreshold",
  "condition",
  "action",
  "cooldownSec",
  "ui_metadata",
];

exports.updateFlow = async (req, res) => {
  try {
    const _id = parseObjectId(req.params.id);
    if (!_id) return res.status(400).json({ ok: false, error: "Invalid flow id" });

    const db = getDb();
    const flowsCol = db.collection("automation_flows");
    const existing = await flowsCol.findOne({ _id, user_id: req.user.id });
    if (!existing) return res.status(404).json({ ok: false, error: "Flow not found" });

    const body = req.body || {};
    const merged = {};
    for (const k of UPDATABLE) merged[k] = body[k] !== undefined ? body[k] : existing[k];
    // A patch that only changes the actuator keeps the existing target device unless given
    if (isPlainObject(body.action) && body.action.deviceId === undefined && isPlainObject(existing.action)) {
      merged.action = { ...body.action, deviceId: existing.action.deviceId };
    }

    const result = await validateFlow(db, req.user.id, merged);
    if (result.error) return res.status(result.status || 400).json({ ok: false, error: result.error });

    const flow = await flowsCol.findOneAndUpdate(
      { _id, user_id: req.user.id },
      { $set: { ...result.flow, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!flow) return res.status(404).json({ ok: false, error: "Flow not found" });

    return res.json({ ok: true, flow });
  } catch (error) {
    return sendServerError(res, error, "update flow");
  }
};

// Delete flow
exports.deleteFlow = async (req, res) => {
  try {
    const _id = parseObjectId(req.params.id);
    if (!_id) return res.status(400).json({ ok: false, error: "Invalid flow id" });

    const db = getDb();
    const result = await db.collection("automation_flows").deleteOne({ _id, user_id: req.user.id });
    if (result.deletedCount === 0) return res.status(404).json({ ok: false, error: "Flow not found" });

    await db.collection("automation_flow_state").deleteMany({ flowId: _id });
    return res.json({ ok: true });
  } catch (error) {
    return sendServerError(res, error, "delete flow");
  }
};

// Get flow logs (owner only)
exports.getFlowLogs = async (req, res) => {
  try {
    const _id = parseObjectId(req.params.id);
    if (!_id) return res.status(400).json({ ok: false, error: "Invalid flow id" });

    const db = getDb();
    const flow = await db.collection("automation_flows").findOne({ _id, user_id: req.user.id }, { projection: { _id: 1 } });
    if (!flow) return res.status(404).json({ ok: false, error: "Flow not found" });

    const limit = clampInt(req.query.limit, { min: 1, max: 500, fallback: 20 });
    const logs = await db
      .collection("automation_flow_logs")
      .find({ flowId: _id })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();

    return res.json({ ok: true, logs });
  } catch (error) {
    return sendServerError(res, error, "flow logs");
  }
};

exports.validateFlow = validateFlow;
