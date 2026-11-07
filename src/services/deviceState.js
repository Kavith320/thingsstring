// src/services/deviceState.js
// Shared device rules used by the API, the scheduler and the automation engine,
// so they all agree on "online", "auto mode" and "who owns this device".

function offlineThresholdSec() {
  const n = parseInt(process.env.DEVICE_OFFLINE_THRESHOLD_SEC || "300", 10);
  return Number.isNaN(n) || n <= 0 ? 300 : n;
}

function telemetryTimeMs(doc) {
  if (!doc) return null;
  if (doc.createdAt) {
    const t = new Date(doc.createdAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (doc._id && typeof doc._id.getTimestamp === "function") return doc._id.getTimestamp().getTime();
  return null;
}

/**
 * Returns { online, ageSec } for a device based on its latest telemetry.
 * A device that has never sent telemetry (or whose telemetry expired) is OFFLINE.
 */
async function getDeviceOnlineState(db, deviceId, maxAgeSec = offlineThresholdSec()) {
  const last = await db
    .collection("device_telemetry")
    .findOne({ deviceId }, { sort: { _id: -1 }, projection: { _id: 1, createdAt: 1 } });
  const t = telemetryTimeMs(last);
  if (t === null) return { online: false, ageSec: null };
  const ageSec = Math.floor((Date.now() - t) / 1000);
  return { online: ageSec <= maxAgeSec, ageSec };
}

/** An actuator is in AUTO mode if either the live `auto` flag or the config default says so. */
function isAutoMode(actuator) {
  if (!actuator || typeof actuator !== "object") return false;
  if (typeof actuator.auto === "boolean") return actuator.auto;
  return actuator.default?.auto === true;
}

/** Owner id of a device config document (the user's MongoDB _id as a string). */
function deviceOwnerId(config) {
  const id = config?.device?.user_id ?? config?.user_id;
  return id == null ? null : String(id);
}

/** Load a device config only if it belongs to the given user. */
async function findOwnedDevice(db, deviceId, userId) {
  if (typeof deviceId !== "string" || !deviceId) return null;
  return db.collection("device_config").findOne({ _id: deviceId, "device.user_id": String(userId) });
}

module.exports = {
  offlineThresholdSec,
  getDeviceOnlineState,
  isAutoMode,
  deviceOwnerId,
  findOwnedDevice,
};
