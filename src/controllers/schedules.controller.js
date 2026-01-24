// src/controllers/schedules.controller.js
const { ObjectId } = require("mongodb");
const { getDb } = require("../db/mongo");

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function normalizeActions(actions) {
  // actions: [{ actuator: "fan", set: {...} }, ...]
  if (!Array.isArray(actions)) return null;
  for (const a of actions) {
    if (!isObject(a)) return null;
    if (typeof a.actuator !== "string" || !a.actuator.trim()) return null;
    if (!isObject(a.set)) return null;
  }
  return actions;
}

async function loadOwnedDeviceConfig(db, deviceId, userMongoId) {
  const configCol = db.collection("device_config");
  return await configCol.findOne({ _id: deviceId, "device.user_id": userMongoId });
}

function validateActuatorsAgainstConfig(config, actions, endActions) {
  const configActuators = config?.actuators || {};

  const all = [
    ...(actions || []),
    ...(endActions || []),
  ];

  for (const item of all) {
    const name = item.actuator;
    if (!configActuators[name]) {
      return `Unknown actuator '${name}' (not in device_config.actuators)`;
    }
  }
  return null;
}

// POST /api/schedules/devices/:deviceId/schedules
async function createDeviceSchedule(req, res) {
  try {
    const db = getDb();
    const userMongoId = req.user.id;
    const { deviceId } = req.params;

    const body = req.body || {};

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
    const enabled = body.enabled === undefined ? true : !!body.enabled;

    const actions = normalizeActions(body.actions);
    const endActions = body.end_actions ? normalizeActions(body.end_actions) : [];
    const durationSec =
      body.duration_sec === undefined || body.duration_sec === null
        ? null
        : parseInt(body.duration_sec, 10);

    if (!name) return res.status(400).json({ ok: false, error: "name is required" });
    if (!cron) return res.status(400).json({ ok: false, error: "cron is required" });
    if (!timezone) return res.status(400).json({ ok: false, error: "timezone is required" });
    if (!actions || actions.length === 0) {
      return res.status(400).json({ ok: false, error: "actions must be a non-empty array" });
    }

    if (durationSec !== null) {
      if (Number.isNaN(durationSec) || durationSec < 1) {
        return res.status(400).json({ ok: false, error: "duration_sec must be a positive number" });
      }
      if (!Array.isArray(endActions) || endActions.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "end_actions required when duration_sec is provided",
        });
      }
    }

    // 1) verify device belongs to user
    const config = await loadOwnedDeviceConfig(db, deviceId, userMongoId);
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    // 2) validate actuator names against config.actuators
    const actErr = validateActuatorsAgainstConfig(config, actions, endActions);
    if (actErr) return res.status(400).json({ ok: false, error: actErr });

    const schedulesCol = db.collection("device_schedules");
    const now = new Date();

    const doc = {
      deviceId,
      user_id: userMongoId,
      name,
      enabled,
      timezone,
      cron,
      actions,
      duration_sec: durationSec,   // null or number
      end_actions: endActions,     // [] or array
      createdAt: now,
      updatedAt: now,
    };

    const result = await schedulesCol.insertOne(doc);

    return res.status(201).json({
      ok: true,
      scheduleId: result.insertedId,
      schedule: { _id: result.insertedId, ...doc },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/schedules/devices/:deviceId/schedules
async function listDeviceSchedules(req, res) {
  try {
    const db = getDb();
    const userMongoId = req.user.id;
    const { deviceId } = req.params;

    // verify device belongs to user (so you can't list others)
    const config = await loadOwnedDeviceConfig(db, deviceId, userMongoId);
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    const schedulesCol = db.collection("device_schedules");

    const schedules = await schedulesCol
      .find({ deviceId, user_id: userMongoId })
      .sort({ _id: -1 })
      .toArray();

    return res.json({ ok: true, deviceId, count: schedules.length, schedules });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PUT /api/schedules/:scheduleId
async function updateSchedule(req, res) {
  try {
    const db = getDb();
    const userMongoId = req.user.id;
    const { scheduleId } = req.params;

    let _id;
    try {
      _id = new ObjectId(scheduleId);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid scheduleId" });
    }

    const schedulesCol = db.collection("device_schedules");

    // 1) load schedule and verify ownership
    const existing = await schedulesCol.findOne({ _id, user_id: userMongoId });
    if (!existing) return res.status(404).json({ ok: false, error: "Schedule not found" });

    const body = req.body || {};
    const $set = {};
    const now = new Date();

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return res.status(400).json({ ok: false, error: "name must be a non-empty string" });
      }
      $set.name = body.name.trim();
    }

    if (body.enabled !== undefined) {
      $set.enabled = !!body.enabled;
    }

    if (body.cron !== undefined) {
      if (typeof body.cron !== "string" || !body.cron.trim()) {
        return res.status(400).json({ ok: false, error: "cron must be a non-empty string" });
      }
      $set.cron = body.cron.trim();
    }

    if (body.timezone !== undefined) {
      if (typeof body.timezone !== "string" || !body.timezone.trim()) {
        return res.status(400).json({ ok: false, error: "timezone must be a non-empty string" });
      }
      $set.timezone = body.timezone.trim();
    }

    // actions updates (optional)
    let actions = null;
    let endActions = null;

    if (body.actions !== undefined) {
      actions = normalizeActions(body.actions);
      if (!actions || actions.length === 0) {
        return res.status(400).json({ ok: false, error: "actions must be a non-empty array" });
      }
      $set.actions = actions;
    }

    if (body.end_actions !== undefined) {
      endActions = normalizeActions(body.end_actions);
      if (!endActions) {
        return res.status(400).json({ ok: false, error: "end_actions must be an array" });
      }
      $set.end_actions = endActions;
    }

    if (body.duration_sec !== undefined) {
      const durationSec =
        body.duration_sec === null ? null : parseInt(body.duration_sec, 10);

      if (durationSec !== null) {
        if (Number.isNaN(durationSec) || durationSec < 1) {
          return res.status(400).json({ ok: false, error: "duration_sec must be a positive number or null" });
        }
        $set.duration_sec = durationSec;
      } else {
        $set.duration_sec = null;
      }
    }

    // If duration_sec will be non-null after update, ensure end_actions exists
    const nextDuration =
      $set.duration_sec !== undefined ? $set.duration_sec : existing.duration_sec;

    const nextEndActions =
      $set.end_actions !== undefined ? $set.end_actions : existing.end_actions;

    if (nextDuration !== null && (!Array.isArray(nextEndActions) || nextEndActions.length === 0)) {
      return res.status(400).json({
        ok: false,
        error: "end_actions required when duration_sec is provided",
      });
    }

    // 2) Validate actuators against current device_config
    // We validate using "next" actions arrays (existing + updates)
    const nextActions = $set.actions !== undefined ? $set.actions : existing.actions;

    const config = await loadOwnedDeviceConfig(db, existing.deviceId, userMongoId);
    if (!config) return res.status(404).json({ ok: false, error: "Device not found for this schedule" });

    const actErr = validateActuatorsAgainstConfig(config, nextActions, nextEndActions);
    if (actErr) return res.status(400).json({ ok: false, error: actErr });

    if (Object.keys($set).length === 0) {
      return res.json({ ok: true, schedule: existing }); // nothing to update
    }

    $set.updatedAt = now;

    await schedulesCol.updateOne({ _id, user_id: userMongoId }, { $set });

    const updated = await schedulesCol.findOne({ _id, user_id: userMongoId });
    return res.json({ ok: true, schedule: updated });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// DELETE /api/schedules/:scheduleId
async function deleteSchedule(req, res) {
  try {
    const db = getDb();

    if (!req.user || !req.user.id) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userMongoId = req.user.id;
    const { scheduleId } = req.params;

    let _id;
    try {
      _id = new ObjectId(scheduleId);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid scheduleId" });
    }

    const schedulesCol = db.collection("device_schedules");
    const result = await schedulesCol.deleteOne({ _id, user_id: userMongoId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: "Schedule not found" });
    }

    return res.json({ ok: true, deleted: true, scheduleId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}


module.exports = {
  createDeviceSchedule,
  listDeviceSchedules,
  updateSchedule,
  deleteSchedule,
};
