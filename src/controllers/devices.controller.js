// src/controllers/devices.controller.js
const { getDb } = require("../db/mongo");
const { publishControl } = require("../services/controlPublisher");
const { findOwnedDevice } = require("../services/deviceState");
const { sendServerError, isPlainObject, isSafeKey, clampInt } = require("../utils/http");

async function latestTelemetry(db, deviceId) {
  return db.collection("device_telemetry").findOne({ deviceId }, { sort: { _id: -1 } });
}

// GET /api/devices
async function listMyDevices(req, res) {
  try {
    const db = getDb();
    const configs = await db.collection("device_config").find({ "device.user_id": req.user.id }).toArray();
    const ids = configs.map((c) => c._id);

    const [controls, telemetry] = await Promise.all([
      db.collection("device_control").find({ _id: { $in: ids } }).toArray(),
      Promise.all(ids.map((id) => latestTelemetry(db, id))),
    ]);
    const controlById = new Map(controls.map((c) => [c._id, c]));

    const devices = configs.map((cfg, i) => ({
      deviceId: cfg._id,
      config: cfg,
      last_telemetry: telemetry[i] || null,
      control: controlById.get(cfg._id) || null,
    }));

    return res.json({ ok: true, count: devices.length, devices });
  } catch (e) {
    return sendServerError(res, e, "list devices");
  }
}

// GET /api/devices/:deviceId
async function getDeviceById(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;

    const config = await findOwnedDevice(db, deviceId, req.user.id);
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    const [lastTelemetry, control] = await Promise.all([
      latestTelemetry(db, deviceId),
      db.collection("device_control").findOne({ _id: deviceId }),
    ]);

    return res.json({
      ok: true,
      device: { deviceId, config, last_telemetry: lastTelemetry, control },
    });
  } catch (e) {
    return sendServerError(res, e, "get device");
  }
}

// GET /api/devices/:deviceId/telemetry?limit=100
async function getDeviceTelemetry(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const limit = clampInt(req.query.limit, { min: 1, max: 500, fallback: 50 });

    const config = await findOwnedDevice(db, deviceId, req.user.id);
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    const telemetry = await db
      .collection("device_telemetry")
      .find({ deviceId })
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();

    return res.json({ ok: true, deviceId, count: telemetry.length, telemetry });
  } catch (e) {
    return sendServerError(res, e, "get telemetry");
  }
}

/**
 * Validate an `actuators` patch against a device config and build the $set.
 * Returns { error } or { $set }. Shared by the user and admin control endpoints.
 */
function buildControlSet(config, updates) {
  if (!isPlainObject(updates) || Object.keys(updates).length === 0) {
    return { error: "Body must include a non-empty actuators object" };
  }
  const configActuators = isPlainObject(config.actuators) ? config.actuators : {};
  const $set = {};

  for (const [actName, actPatch] of Object.entries(updates)) {
    if (!isSafeKey(actName) || !Object.prototype.hasOwnProperty.call(configActuators, actName)) {
      return { error: `Unknown actuator '${actName}' (not in device_config)` };
    }
    if (!isPlainObject(actPatch) || Object.keys(actPatch).length === 0) {
      return { error: `Invalid patch for actuator '${actName}'` };
    }
    for (const [k, v] of Object.entries(actPatch)) {
      if (!isSafeKey(k)) return { error: `Invalid field '${k}' for actuator '${actName}'` };
      $set[`actuators.${actName}.${k}`] = v;
    }
  }
  return { $set };
}

// POST /api/devices/:deviceId/control
async function updateDeviceControl(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const controlCol = db.collection("device_control");

    const config = await findOwnedDevice(db, deviceId, req.user.id);
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    if (config.isDisabled) {
      return res.status(403).json({
        ok: false,
        error: `Device is locked out by admin. Reason: ${config.disabledReason || "Admin Lockout"}`,
      });
    }

    const { error, $set } = buildControlSet(config, (req.body || {}).actuators);
    if (error) return res.status(400).json({ ok: false, error });

    const controlDoc = await controlCol.findOneAndUpdate(
      { _id: deviceId },
      { $set },
      { upsert: true, returnDocument: "after" }
    );
    publishControl(deviceId, controlDoc);

    return res.json({ ok: true, deviceId, control: controlDoc });
  } catch (e) {
    return sendServerError(res, e, "device control");
  }
}

module.exports = {
  listMyDevices,
  getDeviceById,
  getDeviceTelemetry,
  updateDeviceControl,
  buildControlSet,
};
