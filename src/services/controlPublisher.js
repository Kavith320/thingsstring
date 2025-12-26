// src/services/controlPublisher.js
// Publishes the latest device_control document to: ts/<deviceId>/control
// Payload = exact JSON copy of the device_control document
// Uses MongoDB Change Streams (requires MongoDB replica set)

const { getDb } = require("../db/mongo");
const { getMqttClient } = require("../mqtt/client");


function publishControl(deviceId, controlDoc) {
  const client = getMqttClient();
  const topic = `ts/${deviceId}/control`;

  // exact copy of device_control doc
  const payload = JSON.stringify(controlDoc);

  client.publish(topic, payload, { qos: 1, retain: true }, (err) => {
    if (err) console.error(`❌ MQTT publish error (${topic}):`, err.message);
    else console.log(`📤 Published control -> ${topic}`);
  });
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
 */
async function watchControlChanges() {
  const db = getDb();
  const col = db.collection("device_control");

  const stream = col.watch([], { fullDocument: "updateLookup" });

  stream.on("change", (change) => {
    const doc = change.fullDocument;
    if (!doc || !doc._id) return;

    publishControl(doc._id, doc);
  });

  stream.on("error", (err) => {
    console.error("❌ device_control change stream error:", err.message);
    // Keep it simple: let pm2/systemd restart the process if needed.
  });

  console.log("👀 Watching device_control changes...");
}

module.exports = {
  publishControl,
  publishAllControlsOnce,
  watchControlChanges,
};
