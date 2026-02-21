const User = require("../models/User");
const { getDb } = require("../db/mongo");
const { publishControl } = require("../services/controlPublisher");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

// GET /api/admin/system/stats
async function getSystemStats(req, res) {
    try {
        const userCount = await User.countDocuments();

        const db = getDb();
        const configCol = db.collection("device_config");
        const telemetryCol = db.collection("device_telemetry");

        const deviceCount = await configCol.countDocuments();
        const telemetryCount = await telemetryCol.countDocuments();

        // Add schedule count
        const schedulesCol = db.collection("device_schedules");
        const scheduleCount = await schedulesCol.countDocuments();

        return res.json({
            ok: true,
            stats: {
                users: userCount,
                devices: deviceCount,
                telemetry_records: telemetryCount,
                schedules: scheduleCount,
            },
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/users
async function getAllUsers(req, res) {
    try {
        const users = await User.find({}, "-passwordHash"); // Exclude password hash
        return res.json({ ok: true, count: users.length, users });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// DELETE /api/admin/users/:userId
// This should also ideally delete devices owned by the user
async function deleteUser(req, res) {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ ok: false, error: "User not found" });
        }

        // Delete user's devices
        const db = getDb();
        const configCol = db.collection("device_config");
        const telemetryCol = db.collection("device_telemetry");
        const controlCol = db.collection("device_control");
        const schedulesCol = db.collection("device_schedules");

        // Find devices owned by user. According to devices.controller, we look for "device.user_id": userMongoId
        // Config documents look like { _id: deviceId, device: { user_id: mongoId }, ... }
        const userDevices = await configCol.find({ "device.user_id": userId }).toArray();
        const deviceIds = userDevices.map(d => d._id);

        if (deviceIds.length > 0) {
            await configCol.deleteMany({ _id: { $in: deviceIds } });
            await telemetryCol.deleteMany({ deviceId: { $in: deviceIds } });
            await controlCol.deleteMany({ _id: { $in: deviceIds } });
        }

        // Delete user schedules
        await schedulesCol.deleteMany({ user_id: userId });

        await User.findByIdAndDelete(userId);

        return res.json({ ok: true, message: "User, devices, and schedules deleted" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/devices
async function getAllDevices(req, res) {
    try {
        const db = getDb();
        const configCol = db.collection("device_config");

        // Fetch all devices
        const devices = await configCol.find({}).toArray();

        return res.json({ ok: true, count: devices.length, devices });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// DELETE /api/admin/devices/:deviceId
async function deleteDevice(req, res) {
    try {
        const { deviceId } = req.params;
        const db = getDb();
        const configCol = db.collection("device_config");
        const telemetryCol = db.collection("device_telemetry");
        const controlCol = db.collection("device_control");
        const schedulesCol = db.collection("device_schedules");

        const result = await configCol.deleteOne({ _id: deviceId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ ok: false, error: "Device not found" });
        }

        // Clean up related collections
        await telemetryCol.deleteMany({ deviceId });
        await controlCol.deleteOne({ _id: deviceId });
        await schedulesCol.deleteMany({ deviceId });

        return res.json({ ok: true, message: "Device and associated data deleted" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/schedules
async function getAllSchedules(req, res) {
    try {
        const db = getDb();
        const schedulesCol = db.collection("device_schedules");
        const schedules = await schedulesCol.find({}).toArray();
        return res.json({ ok: true, count: schedules.length, schedules });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// DELETE /api/admin/schedules/:scheduleId
async function deleteSchedule(req, res) {
    try {
        const { scheduleId } = req.params;
        const db = getDb();
        const schedulesCol = db.collection("device_schedules");

        let _id;
        try {
            _id = new ObjectId(scheduleId);
        } catch {
            return res.status(400).json({ ok: false, error: "Invalid scheduleId" });
        }

        const result = await schedulesCol.deleteOne({ _id });

        if (result.deletedCount === 0) {
            return res.status(404).json({ ok: false, error: "Schedule not found" });
        }

        return res.json({ ok: true, message: "Schedule deleted successfully" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/devices/:deviceId
async function getDeviceDetails(req, res) {
    try {
        const { deviceId } = req.params;
        const db = getDb();

        const configCol = db.collection("device_config");
        const telemetryCol = db.collection("device_telemetry");
        const controlCol = db.collection("device_control");

        const config = await configCol.findOne({ _id: deviceId });
        if (!config) {
            return res.status(404).json({ ok: false, error: "Device not found" });
        }

        const lastTelemetry = await telemetryCol
            .find({ deviceId })
            .sort({ _id: -1 })
            .limit(50) // Return last 50 readings
            .toArray();

        const control = await controlCol.findOne({ _id: deviceId });

        return res.json({
            ok: true,
            device: {
                config,
                control,
                telemetry_history: lastTelemetry,
            },
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// POST /api/admin/devices/:deviceId/control
const { getMqttClient } = require("../mqtt/client");

async function controlDevice(req, res) {
    try {
        const { deviceId } = req.params;
        const db = getDb();
        const configCol = db.collection("device_config");
        const controlCol = db.collection("device_control");

        const body = req.body || {};
        const updates = body.actuators;

        if (!updates || typeof updates !== "object") {
            return res.status(400).json({ ok: false, error: "Body must include actuators object" });
        }

        const config = await configCol.findOne({ _id: deviceId });
        if (!config) {
            return res.status(404).json({ ok: false, error: "Device not found" });
        }

        // Since this is admin force control, we might optionally skip strict validation
        // But it's generally good to keep it to ensure validity.
        // For "Manual Control" override, strict validation of actuator existence is good.

        const configActuators = config.actuators || {};
        const $set = {};

        for (const [actName, actPatch] of Object.entries(updates)) {
            if (!configActuators[actName]) {
                return res.status(400).json({
                    ok: false,
                    error: `Unknown actuator '${actName}'`,
                });
            }
            for (const [k, v] of Object.entries(actPatch)) {
                $set[`actuators.${actName}.${k}`] = v;
            }
        }

        await controlCol.updateOne({ _id: deviceId }, { $set }, { upsert: true });

        const controlDoc = await controlCol.findOne({ _id: deviceId });
        publishControl(deviceId, controlDoc);

        return res.json({ ok: true, control: controlDoc });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/devices/:deviceId/telemetry?start=...&end=...&limit=...
async function getDeviceTelemetryHistory(req, res) {
    try {
        const { deviceId } = req.params;
        const { start, end } = req.query;
        let limit = parseInt(req.query.limit || "100", 10);

        // Safety caps
        if (Number.isNaN(limit) || limit < 1) limit = 100;
        if (limit > 5000) limit = 5000;

        const db = getDb();
        const telemetryCol = db.collection("device_telemetry");

        // Build query
        const query = { deviceId };

        // Use 'createdAt' if available, otherwise we assume _id sort is enough for basic pagination.
        // However, for explicit time range, we need a time field.
        // Assuming 'createdAt' is the standard field name for ingestion time.

        const dateQuery = {};
        if (start) {
            const d = new Date(start);
            if (!isNaN(d.getTime())) dateQuery.$gte = d;
        }
        if (end) {
            const d = new Date(end);
            if (!isNaN(d.getTime())) dateQuery.$lte = d;
        }

        if (Object.keys(dateQuery).length > 0) {
            query.createdAt = dateQuery;
        }

        const telemetry = await telemetryCol
            .find(query)
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

module.exports = {
    getSystemStats,
    getAllUsers,
    deleteUser,
    getAllDevices,
    deleteDevice,
    getAllSchedules,
    deleteSchedule,
    getDeviceDetails,
    controlDevice,
    getDeviceTelemetryHistory,
};
