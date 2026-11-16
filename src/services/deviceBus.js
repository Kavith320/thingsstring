// src/services/deviceBus.js
// In-process notifications about device data, for live views (wall displays):
//   "telemetry" (deviceId, telemetryDoc)  a reading was stored (MQTT ingest)
//   "control"   (deviceId, controlDoc)    desired actuator state changed (any process,
//                                         via the device_control change stream)
// Listeners must not throw; emit() is synchronous.

const { EventEmitter } = require("node:events");

const deviceBus = new EventEmitter();
deviceBus.setMaxListeners(0);

function emitSafe(event, ...args) {
  try {
    deviceBus.emit(event, ...args);
  } catch (e) {
    console.error(`⚠️ deviceBus ${event} listener failed:`, e.message);
  }
}

module.exports = { deviceBus, emitSafe };
