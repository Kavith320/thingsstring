// src/services/controlPublisher.js
// Publishes the latest device_control document to: ts/<deviceId>/control
// Payload = exact JSON copy of the device_control document
// Uses MongoDB Change Streams (requires MongoDB replica set)

const { getDb } = require("../db/mongo");
const { getMqttClient } = require("../mqtt/client");


function publishControl(deviceId, controlDoc) {
  if (!controlDoc) return;

  try {
    const client = getMqttClient();
    if (!client || !client.connected) {
      console.log(`⚠️ MQTT client offline — skipping live publish for device ${deviceId} (reconnect auto-recovers)`);
      return;
    }

    const topic = `ts/${deviceId}/control`;

    // Strip MongoDB internal fields like _id to keep payload clean for devices
    const { _id, ...cleanDoc } = controlDoc;
    const payload = JSON.stringify(cleanDoc);

    client.publish(topic, payload, { qos: 0, retain: true }, (err) => {
      if (err) {
        console.error(`❌ MQTT [${deviceId}] publish error:`, err.message);
      } else {
        console.log(`📤 [${deviceId}] Published: ${payload}`);
      }
    });
  } catch (err) {
    console.error(`❌ [${deviceId}] publishControl error:`, err.message);
  }
}

async function publishAllControlsOnce() {
  const db = getDb();
  const col = db.collection("device_control");

  const docs = await col.find({}).toArray();
  for (const doc of docs) {
    // we assume _id is the deviceId
    publishControl(doc._id, doc);
  }
}

/**
 * Watches changes in device_control collection and publishes updates
 * - change streams require MongoDB replica set (Atlas OK)
 * - auto-restarts watcher stream on transient network errors
 */
async function watchControlChanges() {
  const db = getDb();
  const col = db.collection("device_control");

  function startStream() {
    try {
      const stream = col.watch([], { fullDocument: "updateLookup" });

      stream.on("change", (change) => {
        const doc = change.fullDocument;
        if (!doc || !doc._id) return;
        publishControl(doc._id, doc);
      });

      stream.on("error", (err) => {
        console.error("⚠️ device_control change stream error (re-subscribing in 5s):", err.message);
        setTimeout(startStream, 5000);
      });
    } catch (err) {
      console.error("⚠️ Failed to open device_control change stream (retrying in 5s):", err.message);
      setTimeout(startStream, 5000);
    }
  }

  startStream();
  console.log("👀 Watching device_control changes...");
}

module.exports = {
  publishControl,
  publishAllControlsOnce,
  watchControlChanges,
};
