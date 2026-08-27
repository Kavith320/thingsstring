const User = require("../models/User");
const { getDb } = require("../db/mongo");
const { publishControl } = require("../services/controlPublisher");
const { logAdminAction } = require("../services/auditLogger");
const { backupFullDatabase } = require("../../scripts/backup_full_db");
const { backupAndCleanupTelemetry } = require("../../scripts/backup_and_cleanup_telemetry");
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
            if (!actPatch || typeof actPatch !== "object") {
                return res.status(400).json({
                    ok: false,
                    error: `Invalid patch for actuator '${actName}'`,
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

// GET /api/admin/health
async function getSystemHealth(req, res) {
    try {
        const db = getDb();
        const dbStats = await db.stats(1024 * 1024);

        let mqttConnected = false;
        try {
            const client = getMqttClient();
            mqttConnected = client && client.connected;
        } catch {
            mqttConnected = false;
        }

        const memory = process.memoryUsage();

        return res.json({
            ok: true,
            health: {
                status: "healthy",
                uptimeSeconds: Math.floor(process.uptime()),
                memory: {
                    rssMB: Math.round(memory.rss / (1024 * 1024)),
                    heapUsedMB: Math.round(memory.heapUsed / (1024 * 1024)),
                    heapTotalMB: Math.round(memory.heapTotal / (1024 * 1024)),
                },
                mongo: {
                    connected: true,
                    dataSizeMB: dbStats.dataSize,
                    storageSizeMB: dbStats.storageSize,
                    collections: dbStats.collections,
                    objectsCount: dbStats.objects,
                },
                mqtt: {
                    connected: mqttConnected,
                },
            },
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// PUT /api/admin/users/:userId/role
async function updateUserRole(req, res) {
    try {
        const { userId } = req.params;
        const { role } = req.body;

        if (!["user", "admin"].includes(role)) {
            return res.status(400).json({ ok: false, error: "Invalid role. Must be 'user' or 'admin'" });
        }

        const user = await User.findByIdAndUpdate(userId, { role }, { new: true }).select("-passwordHash");
        if (!user) {
            return res.status(404).json({ ok: false, error: "User not found" });
        }

        return res.json({ ok: true, message: `User role updated to '${role}'`, user });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// POST /api/admin/users/:userId/reset-password
const bcrypt = require("bcrypt");
async function resetUserPassword(req, res) {
    try {
        const { userId } = req.params;
        const { newPassword } = req.body;

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);

        const user = await User.findByIdAndUpdate(userId, { passwordHash }, { new: true }).select("-passwordHash");
        if (!user) {
            return res.status(404).json({ ok: false, error: "User not found" });
        }

        return res.json({ ok: true, message: "User password reset successfully" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// POST /api/admin/devices/:deviceId/lockout
async function toggleDeviceLockout(req, res) {
    try {
        const { deviceId } = req.params;
        const { disabled, reason } = req.body;

        const db = getDb();
        const configCol = db.collection("device_config");

        const device = await configCol.findOne({ _id: deviceId });
        if (!device) {
            return res.status(404).json({ ok: false, error: "Device not found" });
        }

        const isDisabled = disabled !== undefined ? Boolean(disabled) : !device.isDisabled;

        await configCol.updateOne(
            { _id: deviceId },
            {
                $set: {
                    isDisabled,
                    disabledReason: reason || (isDisabled ? "Admin Lockout" : null),
                    disabledAt: isDisabled ? new Date() : null,
                },
            }
        );

        return res.json({
            ok: true,
            message: `Device ${deviceId} has been ${isDisabled ? "LOCKED OUT" : "UNLOCKED"}`,
            deviceId,
            isDisabled,
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// POST /api/admin/broadcast/control
async function broadcastDeviceControl(req, res) {
    try {
        const { actuators, filter = {} } = req.body;
        if (!actuators || typeof actuators !== "object") {
            return res.status(400).json({ ok: false, error: "Body must include 'actuators' object" });
        }

        const db = getDb();
        const configCol = db.collection("device_config");
        const controlCol = db.collection("device_control");

        // Find target devices matching filter
        const devices = await configCol.find(filter).toArray();
        if (devices.length === 0) {
            return res.json({ ok: true, message: "No matching devices found for broadcast", affectedCount: 0 });
        }

        let affectedCount = 0;
        for (const dev of devices) {
            const deviceId = dev._id;
            const $set = {};

            for (const [actName, actPatch] of Object.entries(actuators)) {
                if (dev.actuators && dev.actuators[actName]) {
                    if (actPatch && typeof actPatch === "object") {
                        for (const [k, v] of Object.entries(actPatch)) {
                            $set[`actuators.${actName}.${k}`] = v;
                        }
                    }
                }
            }

            if (Object.keys($set).length > 0) {
                await controlCol.updateOne({ _id: deviceId }, { $set }, { upsert: true });
                const controlDoc = await controlCol.findOne({ _id: deviceId });
                publishControl(deviceId, controlDoc);
                affectedCount++;
            }
        }

        return res.json({
            ok: true,
            message: `Broadcast control command sent to ${affectedCount} devices`,
            affectedCount,
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// PUT /api/admin/users/:userId/status
async function setUserStatus(req, res) {
    try {
        const { userId } = req.params;
        const { status } = req.body; // "active" or "disabled"

        if (!["active", "disabled"].includes(status)) {
            return res.status(400).json({ ok: false, error: "Status must be 'active' or 'disabled'" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ ok: false, error: "User not found" });
        }

        user.status = status;
        user.isActive = (status === "active");
        await user.save();

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.email,
            action: "USER_STATUS_UPDATE",
            targetId: userId,
            details: { newStatus: status, userEmail: user.email },
            req,
        });

        return res.json({ ok: true, message: `User status set to ${status}`, user: { id: user._id, email: user.email, status: user.status } });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// PUT /api/admin/devices/:deviceId/transfer
async function transferDeviceOwnership(req, res) {
    try {
        const { deviceId } = req.params;
        const { targetUserId } = req.body;

        if (!targetUserId) {
            return res.status(400).json({ ok: false, error: "Missing required parameter 'targetUserId'" });
        }

        // Find target user (by MongoDB _id or userId8)
        let targetUser = await User.findById(targetUserId).catch(() => null);
        if (!targetUser) {
            targetUser = await User.findOne({ userId8: targetUserId });
        }

        if (!targetUser) {
            return res.status(404).json({ ok: false, error: "Target user not found" });
        }

        const db = getDb();
        const configCol = db.collection("device_config");

        const device = await configCol.findOne({ _id: deviceId });
        if (!device) {
            return res.status(404).json({ ok: false, error: "Device not found" });
        }

        const previousOwnerId = device.device?.user_id || null;

        await configCol.updateOne(
            { _id: deviceId },
            { $set: { "device.user_id": String(targetUser._id), updatedAt: new Date() } }
        );

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.email,
            action: "DEVICE_TRANSFER",
            targetId: deviceId,
            details: { previousOwnerId, newOwnerId: String(targetUser._id), newOwnerEmail: targetUser.email },
            req,
        });

        return res.json({
            ok: true,
            message: `Device ${deviceId} transferred to user ${targetUser.email}`,
            deviceId,
            newOwner: { id: targetUser._id, email: targetUser.email },
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/automation/flows
async function getAllAutomationFlows(req, res) {
    try {
        const db = getDb();
        const flowsCol = db.collection("automation_flows");
        const flows = await flowsCol.find({}).toArray();

        // Populate user details for each flow owner
        const userIds = [...new Set(flows.map(f => f.user_id).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } }, "name email");
        const userMap = {};
        users.forEach(u => { userMap[String(u._id)] = { name: u.name, email: u.email }; });

        const enrichedFlows = flows.map(f => ({
            ...f,
            owner: userMap[String(f.user_id)] || { name: "Unknown", email: "N/A" }
        }));

        return res.json({ ok: true, count: enrichedFlows.length, flows: enrichedFlows });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// PUT /api/admin/automation/flows/:flowId/toggle
async function toggleAutomationFlow(req, res) {
    try {
        const { flowId } = req.params;
        const { enabled } = req.body;

        const db = getDb();
        const flowsCol = db.collection("automation_flows");

        let filter = { _id: flowId };
        if (ObjectId.isValid(flowId)) {
            filter = { $or: [{ _id: flowId }, { _id: new ObjectId(flowId) }] };
        }

        const flow = await flowsCol.findOne(filter);
        if (!flow) {
            return res.status(404).json({ ok: false, error: "Automation flow not found" });
        }

        const newEnabled = enabled !== undefined ? Boolean(enabled) : !flow.enabled;
        await flowsCol.updateOne(filter, { $set: { enabled: newEnabled, updatedAt: new Date() } });

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.email,
            action: "AUTOMATION_FLOW_TOGGLE",
            targetId: String(flow._id),
            details: { enabled: newEnabled, flowName: flow.name },
            req,
        });

        return res.json({ ok: true, message: `Flow ${flow.name} ${newEnabled ? "ENABLED" : "DISABLED"}`, enabled: newEnabled });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// DELETE /api/admin/automation/flows/:flowId
async function deleteAutomationFlow(req, res) {
    try {
        const { flowId } = req.params;
        const db = getDb();
        const flowsCol = db.collection("automation_flows");

        let filter = { _id: flowId };
        if (ObjectId.isValid(flowId)) {
            filter = { $or: [{ _id: flowId }, { _id: new ObjectId(flowId) }] };
        }

        const flow = await flowsCol.findOne(filter);
        if (!flow) {
            return res.status(404).json({ ok: false, error: "Automation flow not found" });
        }

        await flowsCol.deleteOne(filter);

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.email,
            action: "AUTOMATION_FLOW_DELETE",
            targetId: String(flow._id),
            details: { flowName: flow.name, deviceId: flow.deviceId },
            req,
        });

        return res.json({ ok: true, message: `Automation flow '${flow.name}' deleted successfully` });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/automation/logs
async function getGlobalAutomationLogs(req, res) {
    try {
        const { flowId, deviceId, status, limit = 100 } = req.query;
        const query = {};

        if (flowId) query.flowId = flowId;
        if (deviceId) query.deviceId = deviceId;
        if (status) query.status = status.toUpperCase();

        const db = getDb();
        const logsCol = db.collection("automation_flow_logs");

        const parsedLimit = Math.min(parseInt(limit, 10) || 100, 1000);
        const logs = await logsCol.find(query).sort({ timestamp: -1 }).limit(parsedLimit).toArray();

        return res.json({ ok: true, count: logs.length, logs });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// POST /api/admin/maintenance/backup
async function triggerDatabaseBackup(req, res) {
    try {
        const backupDir = await backupFullDatabase();
        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.email,
            action: "MAINTENANCE_BACKUP",
            targetId: null,
            details: { backupDir },
            req,
        });

        return res.json({ ok: true, message: "On-demand full database backup completed", backupDir });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// POST /api/admin/maintenance/clean-telemetry
async function triggerTelemetryCleanup(req, res) {
    try {
        const daysToKeep = parseInt(req.body.daysToKeep, 10) || 7;
        await backupAndCleanupTelemetry(daysToKeep);

        await logAdminAction({
            adminId: req.user.id,
            adminEmail: req.user.email,
            action: "MAINTENANCE_TELEMETRY_CLEANUP",
            targetId: null,
            details: { daysToKeep },
            req,
        });

        return res.json({ ok: true, message: `Telemetry cleanup triggered (retained ${daysToKeep} days)` });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
}

// GET /api/admin/audit-logs
async function getAuditLogs(req, res) {
    try {
        const { action, adminEmail, targetId, limit = 100 } = req.query;
        const query = {};

        if (action) query.action = action;
        if (adminEmail) query.adminEmail = adminEmail;
        if (targetId) query.targetId = targetId;

        const db = getDb();
        const auditCol = db.collection("admin_audit_logs");

        const parsedLimit = Math.min(parseInt(limit, 10) || 100, 1000);
        const logs = await auditCol.find(query).sort({ timestamp: -1 }).limit(parsedLimit).toArray();

        return res.json({ ok: true, count: logs.length, logs });
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
    getSystemHealth,
    updateUserRole,
    resetUserPassword,
    toggleDeviceLockout,
    broadcastDeviceControl,
    setUserStatus,
    transferDeviceOwnership,
    getAllAutomationFlows,
    toggleAutomationFlow,
    deleteAutomationFlow,
    getGlobalAutomationLogs,
    triggerDatabaseBackup,
    triggerTelemetryCleanup,
    getAuditLogs,
};

