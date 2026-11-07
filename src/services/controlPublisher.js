// src/services/controlPublisher.js
// Publishes the latest device_control document to: ts/<deviceId>/control (retained).
//
// The API process is the ONLY MQTT publisher. The scheduler and automation workers
// just write device_control; the change stream below picks those writes up.
// Delivery guarantees:
//   - every (re)connect republishes the full desired state of every device, so
//     commands made while MQTT was down are delivered once it is back;
//   - the change stream resumes from its last token after an error, and falls
//     back to a full republish if it can't resume.

const { getDb } = require("../db/mongo");
const { getMqttClient } = require("../mqtt/client");

// Same payload for the same device within this window is sent only once
// (the API publishes directly AND the change stream sees the same write).
const DEDUPE_WINDOW_MS = 3000;
const lastPublished = new Map(); // deviceId -> { payload, at }

let stream = null;
let stopped = false;

function controlPayload(controlDoc) {
  // Strip MongoDB internal fields like _id to keep the payload clean for devices
  const { _id, ...cleanDoc } = controlDoc;
  return JSON.stringify(cleanDoc);
}

function publishControl(deviceId, controlDoc, { force = false } = {}) {
  if (!controlDoc) return false;

  let client;
  try {
    client = getMqttClient();
  } catch {
    return false;
  }
  if (!client.connected) {
    console.log(`⚠️ MQTT offline — device ${deviceId} will get its state when MQTT reconnects`);
    return false;
  }

  const topic = `ts/${deviceId}/control`;
  const payload = controlPayload(controlDoc);

  const prev = lastPublished.get(deviceId);
  if (!force && prev && prev.payload === payload && Date.now() - prev.at < DEDUPE_WINDOW_MS) {
    return true;
  }
  lastPublished.set(deviceId, { payload, at: Date.now() });

  client.publish(topic, payload, { qos: 1, retain: true }, (err) => {
    if (err) {
      lastPublished.delete(deviceId);
      console.error(`❌ MQTT [${deviceId}] publish error:`, err.message);
    } else {
      console.log(`📤 [${deviceId}] Published: ${payload}`);
    }
  });
  return true;
}

async function publishAllControlsOnce() {
  const docs = await getDb().collection("device_control").find({}).toArray();
  let sent = 0;
  for (const doc of docs) {
    if (publishControl(doc._id, doc, { force: true })) sent++;
  }
  console.log(`📤 Republished desired state for ${sent}/${docs.length} devices`);
}

/**
 * Watches device_control and publishes every change.
 * Requires a MongoDB replica set (Atlas is one).
 */
async function watchControlChanges() {
  const col = getDb().collection("device_control");
  let resumeToken = null;
  stopped = false;

  function restart(reason) {
    if (stopped) return;
    console.error(`⚠️ device_control change stream ${reason} — restarting in 5s`);
    try {
      stream?.close();
    } catch {}
    stream = null;
    setTimeout(start, 5000);
  }

  function start() {
    if (stopped) return;
    const options = { fullDocument: "updateLookup" };
    if (resumeToken) options.resumeAfter = resumeToken;

    try {
      stream = col.watch([], options);
    } catch (err) {
      return restart(`failed to open (${err.message})`);
    }

    stream.on("change", (change) => {
      resumeToken = change._id;
      const doc = change.fullDocument;
      if (doc && doc._id) publishControl(doc._id, doc);
    });

    stream.on("error", (err) => {
      // A token that fell off the oplog can't be resumed: start fresh and
      // republish everything so nothing missed in the gap is lost.
      if (resumeToken && /resume|ChangeStreamHistoryLost|oplog/i.test(err.message)) {
        resumeToken = null;
        publishAllControlsOnce().catch((e) => console.error("❌ republish failed:", e.message));
      }
      restart(`error (${err.message})`);
    });
  }

  start();
  console.log("👀 Watching device_control changes...");
}

async function stopWatching() {
  stopped = true;
  try {
    await stream?.close();
  } catch {}
  stream = null;
}

module.exports = {
  publishControl,
  publishAllControlsOnce,
  watchControlChanges,
  stopWatching,
};
