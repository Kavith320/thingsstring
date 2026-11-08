// src/services/deviceUi.js
// Display settings of a device (name, icon, colour, description, which sensor and
// actuator values show on the card and in what order, location). They belong to the
// DEVICE: everyone it is shared with sees the same thing; the owner and managers can
// change them. (Email alerts, groups and the dashboard layout are personal.)
// Stored in `device_ui` with _id = deviceId, separate from device_config so a device
// reboot (config re-publish) never wipes them.

const { isPlainObject, isSafeKey } = require("../utils/http");
const { fail, optString, optColor, optBool, parseIconRef } = require("../utils/validate");

const MAX_ENTRIES = 100;
// Telemetry keys may be nested paths like "data.temp"
const SENSOR_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

const EMPTY_UI = Object.freeze({
  displayName: null,
  description: null,
  icon: null,
  color: null,
  sensors: [],
  actuators: [],
  location: null,
  updatedAt: null,
});

function serializeUi(doc) {
  if (!doc) return { ...EMPTY_UI, sensors: [], actuators: [] };
  const out = {};
  for (const k of Object.keys(EMPTY_UI)) out[k] = doc[k] ?? EMPTY_UI[k];
  return out;
}

/** Load the settings of many devices: Map(deviceId -> ui). */
async function loadUiMap(db, deviceIds) {
  if (!deviceIds.length) return new Map();
  const docs = await db.collection("device_ui").find({ _id: { $in: deviceIds } }).toArray();
  return new Map(docs.map((d) => [d._id, serializeUi(d)]));
}

/** Every uploaded-icon ref currently used by a settings doc (may stay even if uploaded by someone else). */
function iconRefsIn(doc) {
  if (!doc) return new Set();
  return new Set([doc.icon, ...(doc.sensors || []).map((e) => e.icon), ...(doc.actuators || []).map((e) => e.icon)].filter(Boolean));
}

/**
 * Startup migration to one shared document per device (_id = deviceId). Handles both
 * earlier formats and is safe to run on every start:
 *  - first version: _id = deviceId without a deviceId field
 *  - short-lived per-user version: _id = "<userId>:<deviceId>"; the owner's copy is kept
 *    (or the most recently edited one if the owner had none)
 */
async function migrateDeviceUiKeys(db) {
  const col = db.collection("device_ui");
  await col.updateMany({ deviceId: { $exists: false } }, [{ $set: { deviceId: "$_id" } }]);

  const perUser = await col.find({ $expr: { $ne: ["$_id", "$deviceId"] } }).toArray();
  if (!perUser.length) return;

  const byDevice = new Map();
  for (const d of perUser) byDevice.set(d.deviceId, [...(byDevice.get(d.deviceId) || []), d]);

  const owners = new Map(
    (await db.collection("device_config").find({ _id: { $in: [...byDevice.keys()] } }, { projection: { device: 1, user_id: 1 } }).toArray()).map(
      (c) => [c._id, String(c.device?.user_id ?? c.user_id ?? "")]
    )
  );

  for (const [deviceId, docs] of byDevice) {
    const keep =
      docs.find((d) => String(d.user_id) === owners.get(deviceId)) ||
      docs.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
    const { _id, user_id, ...fields } = keep;
    await col.updateOne({ _id: deviceId }, { $setOnInsert: { ...fields, deviceId, updatedBy: user_id || null } }, { upsert: true });
    await col.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  }
  console.log(`🗂️ Merged ${perUser.length} per-user device_ui document(s) into ${byDevice.size} shared device setting(s)`);
}

/**
 * Validate a list of sensor/actuator display entries. Array order is the priority
 * order on the device page / card. Collects icon refs into `iconRefs`.
 */
function validateEntries(list, field, { isSensor, iconRefs }) {
  if (list === null) return [];
  if (!Array.isArray(list)) fail(`'${field}' must be an array`);
  if (list.length > MAX_ENTRIES) fail(`'${field}' can have at most ${MAX_ENTRIES} entries`);
  const seen = new Set();

  return list.map((e, i) => {
    const at = `${field}[${i}]`;
    if (!isPlainObject(e)) fail(`'${at}' must be an object`);
    const keyOk = isSensor ? typeof e.key === "string" && SENSOR_KEY_RE.test(e.key) : isSafeKey(e.key);
    if (!keyOk) fail(`'${at}.key' is missing or invalid`);
    if (seen.has(e.key)) fail(`'${field}' lists '${e.key}' twice`);
    seen.add(e.key);

    const icon = parseIconRef(e.icon ?? null, `${at}.icon`);
    iconRefs.push({ ...icon, field: `${at}.icon` });

    const out = {
      key: e.key,
      label: optString(e.label ?? null, `${at}.label`, { max: 40 }),
      icon: icon.value,
      color: optColor(e.color ?? null, `${at}.color`),
      visible: optBool(e.visible, `${at}.visible`, true), // shown on the device page
      pinned: optBool(e.pinned, `${at}.pinned`, false), // shown on the dashboard card
    };
    if (isSensor) out.unit = optString(e.unit ?? null, `${at}.unit`, { max: 16 });
    return out;
  });
}

function validateLocation(v) {
  if (v === null) return null;
  if (!isPlainObject(v)) fail("'location' must be an object { lat, lng, label?, address? } or null");
  const { lat, lng } = v;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) fail("'location.lat' must be -90..90");
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) fail("'location.lng' must be -180..180");
  return {
    lat,
    lng,
    label: optString(v.label ?? null, "location.label", { max: 100 }),
    address: optString(v.address ?? null, "location.address", { max: 200 }),
  };
}

/**
 * Validate a PATCH body. Each given top-level field replaces the stored one;
 * `null` clears it. Returns { $set, iconRefs }.
 */
function validateUiPatch(body) {
  if (!isPlainObject(body)) fail("Body must be a JSON object");
  const $set = {};
  const iconRefs = [];

  if (body.displayName !== undefined) $set.displayName = optString(body.displayName, "displayName", { max: 60 });
  if (body.description !== undefined) $set.description = optString(body.description, "description", { max: 300 });
  if (body.color !== undefined) $set.color = optColor(body.color, "color");
  if (body.icon !== undefined) {
    const icon = parseIconRef(body.icon, "icon");
    iconRefs.push({ ...icon, field: "icon" });
    $set.icon = icon.value;
  }
  if (body.sensors !== undefined) $set.sensors = validateEntries(body.sensors, "sensors", { isSensor: true, iconRefs });
  if (body.actuators !== undefined) $set.actuators = validateEntries(body.actuators, "actuators", { isSensor: false, iconRefs });
  if (body.location !== undefined) $set.location = validateLocation(body.location);

  if (!Object.keys($set).length) fail("Nothing to update");
  return { $set, iconRefs };
}

module.exports = { serializeUi, loadUiMap, validateUiPatch, validateLocation, iconRefsIn, migrateDeviceUiKeys };
