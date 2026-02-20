// src/mqtt/client.js
const mqtt = require("mqtt");
const { getDb } = require("../db/mongo");

let mqttClient = null;

/**
 * Create/extend device_control document based on actuators defined in config.
 * - Collection: device_control
 * - One doc per device (_id = deviceId)
 * - Only adds missing actuator keys, does NOT overwrite existing user commands
 */
async function ensureDeviceControlFromConfig(db, deviceId, configPayload) {
  // ✅ Adjust this path if your config keeps actuators somewhere else
  const actuators = configPayload?.actuators;
  if (!actuators || typeof actuators !== "object") return;

  const controlCol = db.collection("device_control");

  // Merge: existing actuators + new actuators from config (new keys added)
  await controlCol.updateOne(
    { _id: deviceId },
    [
      {
        $set: {
          actuators: {
            $mergeObjects: [{ $ifNull: ["$actuators", {}] }, actuators],
          },
        },
      },
    ],
    { upsert: true }
  );
}

function startMqtt(customClientId = null) {
  const url = process.env.MQTT_URL;
  const subTopic = process.env.MQTT_TOPIC || "ts/#";

  if (!url) throw new Error("❌ MQTT_URL missing in .env");

  // Use provided ID, or env ID, or a default. 
  // Append a unique suffix if multiple processes use the same ID from env.
  const baseId = customClientId || process.env.MQTT_CLIENT_ID || "thingsstring-backend";
  const clientId = customClientId ? baseId : `${baseId}-${Math.random().toString(16).slice(2, 6)}`;

  // ✅ store globally so other modules can publish
  mqttClient = mqtt.connect(url, {
    clientId,
    reconnectPeriod: 2000,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  });

  mqttClient.on("connect", () => {
    console.log(`✅ MQTT connected: ${url} (ID: ${clientId})`);
    mqttClient.subscribe(subTopic, (err) => {
      if (err) console.error("❌ MQTT subscribe error:", err.message);
      else console.log(`📡 Subscribed to: ${subTopic}`);
    });
  });

  mqttClient.on("message", async (topic, payloadBuf) => {
    // Expect:
    // ts/<deviceId>/config
    // ts/<deviceId>/telemetry
    const parts = topic.split("/");
    if (parts.length !== 3) return;

    const [root, deviceId, type] = parts;
    if (root !== "ts") return;

    // Only process config and telemetry
    if (type !== "config" && type !== "telemetry") return;

    let payload;
    try {
      payload = JSON.parse(payloadBuf.toString("utf8"));
    } catch {
      console.error(`❌ Invalid JSON from ${deviceId} on ${topic}`);
      return;
    }

    try {
      const db = getDb();

      // -------------------------
      // CONFIG: one doc per device
      // + ensure device_control structure from actuators
      // -------------------------
      if (type === "config") {
        const configCol = db.collection("device_config");

        await configCol.replaceOne(
          { _id: deviceId },
          { _id: deviceId, ...payload }, // raw config + required _id
          { upsert: true }
        );

        // ✅ Create/extend device_control based on config actuators
        await ensureDeviceControlFromConfig(db, deviceId, payload);

        console.log(
          `✅ device_config updated (+ device_control ensured): ${deviceId}`
        );
        return;
      }

      // -------------------------
      // TELEMETRY: time-series in ONE collection
      // -------------------------
      if (type === "telemetry") {
        const telCol = db.collection("device_telemetry");

        // insert each telemetry message as a new doc (history)
        await telCol.insertOne({
          deviceId,
          ...payload, // raw telemetry fields
        });

        return;
      }
    } catch (err) {
      console.error("❌ MongoDB write failed:", err.message);
    }
  });

  mqttClient.on("reconnect", () => console.log("🔁 MQTT reconnecting..."));
  mqttClient.on("close", () => console.log("⚠️ MQTT closed"));
  mqttClient.on("offline", () => console.log("⚠️ MQTT offline"));
  mqttClient.on("error", (err) => console.error("❌ MQTT error:", err.message));

  return mqttClient;
}

function getMqttClient() {
  if (!mqttClient) {
    throw new Error("MQTT client not started yet (call startMqtt first)");
  }
  return mqttClient;
}

module.exports = { startMqtt, getMqttClient };
