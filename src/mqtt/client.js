// src/mqtt/client.js
const mqtt = require("mqtt");
const { getDb } = require("../db/mongo");
const { isPlainObject } = require("../utils/http");
const { logActivity } = require("../services/activity");
const { emitSafe } = require("../services/deviceBus");

let mqttClient = null;

const MAX_PAYLOAD_BYTES = 64 * 1024;

// Fields on device_config that belong to the server, not to the device.
// A device re-publishing its config must never be able to change these.
const SERVER_OWNED_CONFIG_FIELDS = ["isDisabled", "disabledReason", "disabledAt", "ownerAssignedAt"];

// Device events (ts/<deviceId>/event) go into the device's activity history.
// A device may send its backlog after an outage, so the time it gives is kept when it is
// plausible; a flood (a fault or a loop on the device) is cut off per device and minute.
const EVENT_TYPES = new Set(["SYSTEM", "SD", "SENSOR", "RELAY", "WIFI", "CLOUD", "USER", "SETTING"]);
const EVENT_MSG_MAX = 200;
const EVENT_PER_MINUTE = parseInt(process.env.DEVICE_EVENTS_PER_MINUTE || "60", 10) || 60;
const EVENT_MAX_AGE_MS = 7 * 86400e3;
const EVENT_MAX_AHEAD_MS = 120e3;
const eventWindows = new Map(); // deviceId -> { start, count, dropped }

function eventTime(t, now) {
  if (typeof t === "number" && t > 0) {
    const ms = t * 1000;
    if (ms >= now - EVENT_MAX_AGE_MS && ms <= now + EVENT_MAX_AHEAD_MS) return new Date(ms);
  }
  return new Date(now); // no clock on the device yet, or a wrong one
}

/** True if this device may store another event this minute. */
function eventAllowed(deviceId, now) {
  let w = eventWindows.get(deviceId);
  if (!w || now - w.start >= 60e3) {
    if (w?.dropped) console.warn(`⚠️ [MQTT] ${deviceId} sent too many events: ${w.dropped} dropped`);
    w = { start: now, count: 0, dropped: 0 };
    eventWindows.set(deviceId, w);
  }
  if (w.count >= EVENT_PER_MINUTE) {
    w.dropped++;
    return false;
  }
  w.count++;
  return true;
}

async function handleDeviceEvent(db, deviceId, payload, now = Date.now()) {
  const msg = typeof payload.msg === "string" ? payload.msg.trim().slice(0, EVENT_MSG_MAX) : "";
  if (!msg) return;
  // Only devices the platform knows: a random id must not fill the database
  const known = await db.collection("device_config").findOne({ _id: deviceId }, { projection: { _id: 1 } });
  if (!known || !eventAllowed(deviceId, now)) return;
  const type = EVENT_TYPES.has(payload.type) ? payload.type : "OTHER";
  await logActivity(db, {
    deviceId,
    actor: { type: "device" },
    action: `device.${type.toLowerCase()}`,
    details: { type, msg },
    ts: eventTime(payload.t, now),
  });
}

/**
 * Create/extend the device_control document from the actuators in a config.
 * - Collection: device_control, one doc per device (_id = deviceId)
 * - Each actuator listed in the config is RESET to its config definition
 *   (so after a device reboots, its actuators return to firmware defaults).
 * - Actuators that exist in device_control but not in the config are kept.
 */
async function ensureDeviceControlFromConfig(db, deviceId, configPayload) {
  const actuators = configPayload?.actuators;
  if (!isPlainObject(actuators)) return;

  await db.collection("device_control").updateOne(
    { _id: deviceId },
    [{ $set: { actuators: { $mergeObjects: [{ $ifNull: ["$actuators", {}] }, actuators] } } }],
    { upsert: true }
  );
}

/**
 * Build the device_config document to store for an incoming config payload.
 * - Ownership is locked after the first claim: once a device has an owner, only an
 *   admin transfer (or deleting the device) changes it. A different user_id sent by
 *   the device is ignored and logged.
 * - Admin lockout fields survive config re-publishes.
 */
function buildConfigDoc(deviceId, payload, existing) {
  const doc = { ...payload, _id: deviceId };
  doc.device = isPlainObject(payload.device) ? { ...payload.device } : {};

  if (existing) {
    for (const f of SERVER_OWNED_CONFIG_FIELDS) {
      if (existing[f] !== undefined) doc[f] = existing[f];
      else delete doc[f];
    }

    const currentOwner = existing.device?.user_id ?? existing.user_id;
    if (currentOwner != null && currentOwner !== "") {
      const claimed = doc.device.user_id ?? doc.user_id;
      if (claimed != null && String(claimed) !== String(currentOwner)) {
        console.warn(
          `⚠️ [MQTT] Device ${deviceId} sent user_id=${claimed} but is owned by ${currentOwner}. Ownership change ignored (use admin transfer).`
        );
      }
      doc.device.user_id = String(currentOwner);
      if ("user_id" in payload || "user_id" in existing) doc.user_id = String(currentOwner);
    }
  } else {
    for (const f of SERVER_OWNED_CONFIG_FIELDS) delete doc[f];
    if (doc.device.user_id != null) doc.ownerAssignedAt = new Date();
  }

  return doc;
}

/**
 * Handle one incoming MQTT message. Exported for tests.
 * Topics: ts/<deviceId>/config, ts/<deviceId>/telemetry and ts/<deviceId>/event
 */
async function handleDeviceMessage(db, topic, payloadBuf) {
  const parts = topic.split("/");
  if (parts.length !== 3) return;

  const [root, deviceId, type] = parts;
  if (root !== "ts" || !deviceId) return;
  if (type !== "config" && type !== "telemetry" && type !== "event") return;

  if (payloadBuf.length > MAX_PAYLOAD_BYTES) {
    console.error(`❌ [MQTT] Payload too large from ${deviceId} on ${topic} (${payloadBuf.length} bytes) — dropped`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    console.error(`❌ [MQTT] Invalid JSON from ${deviceId} on ${topic}`);
    return;
  }
  if (!isPlainObject(payload)) {
    console.error(`❌ [MQTT] Payload from ${deviceId} on ${topic} is not a JSON object — dropped`);
    return;
  }

  if (type === "event") {
    await handleDeviceEvent(db, deviceId, payload);
    return;
  }

  if (type === "config") {
    const configCol = db.collection("device_config");
    const existing = await configCol.findOne({ _id: deviceId });
    await configCol.replaceOne({ _id: deviceId }, buildConfigDoc(deviceId, payload, existing), { upsert: true });
    await ensureDeviceControlFromConfig(db, deviceId, payload);
    console.log(`✅ device_config updated (+ device_control ensured): ${deviceId}`);
    return;
  }

  // TELEMETRY: server-controlled fields are applied LAST so a payload can't
  // write into another device's history or break the TTL expiry.
  const { _id, ...fields } = payload;
  const doc = { ...fields, deviceId, createdAt: new Date() };
  await db.collection("device_telemetry").insertOne(doc);
  emitSafe("telemetry", deviceId, doc); // live wall displays
}

/**
 * Start the MQTT client.
 * @param {object} opts
 * @param {string} opts.role       Suffix for the client id (e.g. "api"). Client id is
 *                                 `${MQTT_CLIENT_ID}-${role}` so a local/dev copy with a
 *                                 different MQTT_CLIENT_ID never kicks production off.
 * @param {boolean} opts.subscribe Ingest device config/telemetry. Only ONE process should
 *                                 do this, otherwise every message is stored twice.
 * @param {Function} opts.onConnect Called on every (re)connect.
 */
function startMqtt({ role = "api", subscribe = true, onConnect } = {}) {
  const url = process.env.MQTT_URL;
  const subTopic = process.env.MQTT_TOPIC || "ts/#";
  if (!url) throw new Error("❌ MQTT_URL missing in .env");

  const clientId = `${process.env.MQTT_CLIENT_ID || "thingsstring-backend"}-${role}`;

  mqttClient = mqtt.connect(url, {
    clientId,
    clean: true,
    keepalive: 30, // PINGREQ every 30s to prevent HiveMQ / firewall ECONNRESET drops
    connectTimeout: 10000,
    reconnectPeriod: 2000,
    resubscribe: true,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  });

  mqttClient.on("connect", () => {
    console.log(`✅ MQTT connected: ${url} (ID: ${clientId})`);
    if (subscribe) {
      mqttClient.subscribe(subTopic, { qos: 1 }, (err) => {
        if (err) console.error("❌ MQTT subscribe error:", err.message);
        else console.log(`📡 Subscribed to: ${subTopic}`);
      });
    }
    if (onConnect) {
      Promise.resolve()
        .then(onConnect)
        .catch((e) => console.error("❌ MQTT onConnect handler failed:", e.message));
    }
  });

  if (subscribe) {
    mqttClient.on("message", async (topic, payloadBuf) => {
      try {
        await handleDeviceMessage(getDb(), topic, payloadBuf);
      } catch (err) {
        console.error(`❌ [MQTT] Failed to store message on ${topic}:`, err.message);
      }
    });
  }

  mqttClient.on("reconnect", () => console.log("🔁 MQTT reconnecting..."));
  mqttClient.on("close", () => console.log("⚠️ MQTT connection closed"));
  mqttClient.on("offline", () => console.log("⚠️ MQTT offline"));
  mqttClient.on("error", (err) => {
    if (err.code === "ECONNRESET" || (err.message && err.message.includes("ECONNRESET"))) {
      console.log("⚠️ MQTT network socket reset (reconnecting automatically...)");
    } else {
      console.error("❌ MQTT error:", err.message);
    }
  });

  return mqttClient;
}

function getMqttClient() {
  if (!mqttClient) throw new Error("MQTT client not started yet (call startMqtt first)");
  return mqttClient;
}

async function stopMqtt() {
  if (!mqttClient) return;
  await new Promise((resolve) => mqttClient.end(false, {}, resolve));
  mqttClient = null;
}

module.exports = { startMqtt, getMqttClient, stopMqtt, handleDeviceMessage, handleDeviceEvent, buildConfigDoc };
