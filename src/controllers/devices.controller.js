// src/controllers/devices.controller.js
const { getDb } = require("../db/mongo");

// GET /api/devices
async function listMyDevices(req, res) {
  try {
    const db = getDb();
    const userMongoId = req.user.id;

    const configCol = db.collection("device_config");
    const telemetryCol = db.collection("device_telemetry");
    const controlCol = db.collection("device_control");

    const configs = await configCol
      .find({ "device.user_id": userMongoId })
      .toArray();

    const results = await Promise.all(
      configs.map(async (cfg) => {
        const deviceId = cfg._id;

        const lastTelemetry = await telemetryCol
          .find({ deviceId })
          .sort({ _id: -1 })
          .limit(1)
          .toArray()
          .then((arr) => (arr[0] ? arr[0] : null));

        const control = await controlCol.findOne({ _id: deviceId });

        return {
          deviceId,
          config: cfg,
          last_telemetry: lastTelemetry,
          control,
        };
      })
    );

    return res.json({ ok: true, count: results.length, devices: results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/devices/:deviceId
async function getDeviceById(req, res) {
  try {
    const db = getDb();
    const userMongoId = req.user.id;
    const { deviceId } = req.params;

    const configCol = db.collection("device_config");
    const telemetryCol = db.collection("device_telemetry");
    const controlCol = db.collection("device_control");

    const config = await configCol.findOne({
      _id: deviceId,
      "device.user_id": userMongoId,
    });

    if (!config) {
      return res.status(404).json({ ok: false, error: "Device not found" });
    }

    const lastTelemetry = await telemetryCol
      .find({ deviceId })
      .sort({ _id: -1 })
      .limit(1)
      .toArray()
      .then((arr) => (arr[0] ? arr[0] : null));

    const control = await controlCol.findOne({ _id: deviceId });

    return res.json({
      ok: true,
      device: {
        deviceId,
        config,
        last_telemetry: lastTelemetry,
        control,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/devices/:deviceId/telemetry?limit=100
async function getDeviceTelemetry(req, res) {
  try {
    const db = getDb();
    const userMongoId = req.user.id;
    const { deviceId } = req.params;

    let limit = parseInt(req.query.limit || "50", 10);
    if (Number.isNaN(limit)) limit = 50;
    if (limit > 500) limit = 500;
    if (limit < 1) limit = 1;

    const configCol = db.collection("device_config");
    const telemetryCol = db.collection("device_telemetry");

    const config = await configCol.findOne({
      _id: deviceId,
      "device.user_id": userMongoId,
    });

    if (!config) {
      return res.status(404).json({ ok: false, error: "Device not found" });
    }

    const telemetry = await telemetryCol
      .find({ deviceId })
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();

    return res.json({
      ok: true,
      deviceId,
      count: telemetry.length,
      telemetry,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
const { publishControl } = require("../services/controlPublisher");

async function updateDeviceControl(req, res) {
  try {
    const db = getDb();
    const userMongoId = req.user.id;
    const { deviceId } = req.params;

    const configCol = db.collection("device_config");
    const controlCol = db.collection("device_control");

    const body = req.body || {};
    const updates = body.actuators;

    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ ok: false, error: "Body must include actuators object" });
    }

    // 1) verify device belongs to user
    const config = await configCol.findOne({
      _id: deviceId,
      "device.user_id": userMongoId,
    });

    if (!config) {
      return res.status(404).json({ ok: false, error: "Device not found" });
    }

    const configActuators = config.actuators || {};

    // 2) validate and build $set dynamically
    const $set = {};

    for (const [actName, actPatch] of Object.entries(updates)) {
      // actuator must exist in config
      if (!configActuators[actName]) {
        return res.status(400).json({
          ok: false,
          error: `Unknown actuator '${actName}' (not in device_config)`,
        });
      }

      if (!actPatch || typeof actPatch !== "object") {
        return res.status(400).json({ ok: false, error: `Invalid patch for actuator '${actName}'` });
      }

      // set each field under actuators.<actName>.<field>
      for (const [k, v] of Object.entries(actPatch)) {
        $set[`actuators.${actName}.${k}`] = v;
      }
    }

    // 3) apply update (one doc per device)
    await controlCol.updateOne(
      { _id: deviceId },
      { $set },
      { upsert: true }
    );

    // 4) read latest control doc and publish to MQTT
    const controlDoc = await controlCol.findOne({ _id: deviceId });
    publishControl(deviceId, controlDoc);

    return res.json({ ok: true, deviceId, control: controlDoc });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}


module.exports = {
  listMyDevices,
  getDeviceById,
  getDeviceTelemetry,
  updateDeviceControl,
};
