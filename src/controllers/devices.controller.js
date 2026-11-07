// src/controllers/devices.controller.js
const { getDb } = require("../db/mongo");
const { publishControl } = require("../services/controlPublisher");
const { findOwnedDevice } = require("../services/deviceState");
const { sendServerError, isPlainObject, isSafeKey, clampInt } = require("../utils/http");
const { TELEMETRY_TTL_DAYS } = require("../db/indexes");

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

/** Parse an ISO date string or epoch milliseconds. Returns a Date, or null if invalid. */
function parseTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const d = /^-?\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Current telemetry retention in days, read from the TTL index (falls back to the default). */
async function telemetryRetentionDays(db) {
  try {
    const ttl = (await db.collection("device_telemetry").indexes()).find(
      (i) => i.expireAfterSeconds !== undefined && JSON.stringify(i.key) === JSON.stringify({ createdAt: 1 })
    );
    if (ttl) return ttl.expireAfterSeconds / 86400;
  } catch {
    // fall through to the default
  }
  return TELEMETRY_TTL_DAYS;
}

const RANGE_EXCLUDED_KEYS = ["_id", "deviceId", "createdAt"];

/**
 * Average every top-level numeric field per time bucket.
 * Buckets are aligned to `from`, so there are at most `maxPoints` of them.
 */
async function downsampleTelemetry(col, deviceId, from, to, maxPoints, bucketMs) {
  const fromMs = from.getTime();
  const [result] = await col
    .aggregate(
      [
        { $match: { deviceId, createdAt: { $gte: from, $lte: to } } },
        {
          $project: {
            _id: 0,
            b: {
              $min: [
                { $floor: { $divide: [{ $subtract: [{ $toLong: "$createdAt" }, fromMs] }, bucketMs] } },
                maxPoints - 1, // a doc exactly at `to` belongs to the last bucket
              ],
            },
            kv: {
              $filter: {
                input: { $objectToArray: "$$ROOT" },
                cond: {
                  $and: [{ $isNumber: "$$this.v" }, { $not: [{ $in: ["$$this.k", RANGE_EXCLUDED_KEYS] }] }],
                },
              },
            },
          },
        },
        {
          $facet: {
            counts: [{ $group: { _id: "$b", count: { $sum: 1 } } }],
            averages: [
              { $unwind: "$kv" },
              { $group: { _id: { b: "$b", k: "$kv.k" }, v: { $avg: "$kv.v" } } },
              { $group: { _id: "$_id.b", fields: { $push: { k: "$_id.k", v: "$v" } } } },
              { $project: { fields: { $arrayToObject: "$fields" } } },
            ],
          },
        },
      ],
      { allowDiskUse: true }
    )
    .toArray();

  const fieldsByBucket = new Map(result.averages.map((a) => [a._id, a.fields]));
  return result.counts
    .sort((a, b) => a._id - b._id)
    .map(({ _id: b, count }) => ({
      ...(fieldsByBucket.get(b) || {}),
      createdAt: new Date(fromMs + b * bucketMs),
      count,
    }));
}

// GET /api/devices/:deviceId/telemetry
//   ?limit=N                          newest N raw docs, newest first (live polling)
//   ?from=<date>[&to=<date>][&maxPoints=N]   a time range, oldest first, downsampled if large
async function getDeviceTelemetry(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const { from: fromParam, to: toParam } = req.query;

    let from = null;
    let to = null;
    if (fromParam !== undefined || toParam !== undefined) {
      if (fromParam === undefined) {
        return res.status(400).json({ ok: false, error: "'from' is required when 'to' is given" });
      }
      from = parseTime(fromParam);
      if (!from) return res.status(400).json({ ok: false, error: "Invalid 'from' date (use ISO 8601 or epoch ms)" });
      to = toParam === undefined ? new Date() : parseTime(toParam);
      if (!to) return res.status(400).json({ ok: false, error: "Invalid 'to' date (use ISO 8601 or epoch ms)" });
      if (from > to) return res.status(400).json({ ok: false, error: "'from' must be before 'to'" });
    }

    const config = await findOwnedDevice(db, deviceId, req.user.id);
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    const col = db.collection("device_telemetry");

    // Live polling: unchanged behaviour
    if (!from) {
      const limit = clampInt(req.query.limit, { min: 1, max: 500, fallback: 50 });
      const telemetry = await col.find({ deviceId }).sort({ _id: -1 }).limit(limit).toArray();
      return res.json({ ok: true, deviceId, count: telemetry.length, telemetry });
    }

    // Range mode
    const maxPoints = clampInt(req.query.maxPoints, { min: 10, max: 5000, fallback: 1000 });
    const range = { deviceId, createdAt: { $gte: from, $lte: to } };
    const [total, retentionDays] = await Promise.all([col.countDocuments(range), telemetryRetentionDays(db)]);

    let telemetry;
    let bucketMs = null;
    if (total <= maxPoints) {
      telemetry = await col.find(range).sort({ createdAt: 1 }).toArray();
    } else {
      bucketMs = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / maxPoints));
      telemetry = await downsampleTelemetry(col, deviceId, from, to, maxPoints, bucketMs);
    }

    return res.json({
      ok: true,
      deviceId,
      count: telemetry.length,
      telemetry,
      downsampled: bucketMs !== null,
      bucketMs,
      from: from.toISOString(),
      to: to.toISOString(),
      retentionDays,
    });
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
