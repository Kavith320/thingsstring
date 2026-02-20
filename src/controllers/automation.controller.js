const { getDb } = require("../db/mongo");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

/**
 * Automation Flow CRUD Controller
 */

// Create flow
exports.createFlow = async (req, res) => {
    try {
        const db = getDb();
        const flowsCol = db.collection("automation_flows");

        const {
            name,
            deviceId,
            enabled,
            intervalSec,
            metricPath,
            deltaThreshold,
            action,
            cooldownSec,
            ui_metadata // Added for persistence
        } = req.body;

        // Validation - Enhanced Guard
        if (!deviceId || !metricPath || !action?.actuatorKey || action?.setValue === undefined) {
            return res.status(400).json({
                ok: false,
                error: "Missing required fields: deviceId, metricPath, or action details"
            });
        }

        const newFlow = {
            user_id: req.user.id,
            name: name || "Untitled Flow",
            deviceId, // Sensor Hub ID
            enabled: enabled ?? true,
            intervalSec: parseInt(intervalSec) || 60,
            metricPath,
            deltaThreshold: parseFloat(deltaThreshold) || 0,
            action: {
                deviceId: action.deviceId || deviceId, // Actuator Hub ID (fallback to sensor ID)
                actuatorKey: action.actuatorKey,
                setValue: action.setValue
            },
            cooldownSec: parseInt(cooldownSec) || 60,
            ui_metadata: ui_metadata || {}, // Persist canvas coordinates
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await flowsCol.insertOne(newFlow);

        // Return the full created object as requested
        res.status(201).json({
            ok: true,
            flow: { ...newFlow, _id: result.insertedId }
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message || "Internal Server Error" });
    }
};

// List flows by user
exports.listFlows = async (req, res) => {
    try {
        const db = getDb();
        const flowsCol = db.collection("automation_flows");

        const flows = await flowsCol.find({ user_id: req.user.id }).toArray();
        res.json({ ok: true, flows });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
};

// Get one flow
exports.getFlow = async (req, res) => {
    try {
        const db = getDb();
        const flowsCol = db.collection("automation_flows");

        const flow = await flowsCol.findOne({
            _id: new ObjectId(req.params.id),
            user_id: req.user.id
        });

        if (!flow) {
            return res.status(404).json({ ok: false, error: "Flow not found" });
        }

        res.json({ ok: true, flow });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
};

// Update flow
exports.updateFlow = async (req, res) => {
    try {
        const db = getDb();
        const flowsCol = db.collection("automation_flows");

        const updates = { ...req.body, updatedAt: new Date() };

        // Robustness: Ignore/Strip immutable fields manually
        delete updates._id;
        delete updates.user_id;

        const result = await flowsCol.findOneAndUpdate(
            { _id: new ObjectId(req.params.id), user_id: req.user.id },
            { $set: updates },
            { returnDocument: "after" }
        );

        if (!result.value) {
            // In newer mongodb driver result maybe different, let's check
            const updated = await flowsCol.findOne({ _id: new ObjectId(req.params.id), user_id: req.user.id });
            if (!updated) return res.status(404).json({ ok: false, error: "Flow not found" });
            return res.json({ ok: true, flow: updated });
        }

        res.json({ ok: true, flow: result.value });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
};

// Delete flow
exports.deleteFlow = async (req, res) => {
    try {
        const db = getDb();
        const flowsCol = db.collection("automation_flows");

        const result = await flowsCol.deleteOne({
            _id: new ObjectId(req.params.id),
            user_id: req.user.id
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ ok: false, error: "Flow not found" });
        }

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
};

// Get flow logs
exports.getFlowLogs = async (req, res) => {
    try {
        const db = getDb();
        const logsCol = db.collection("automation_flow_logs");

        const limit = parseInt(req.query.limit) || 20;
        const logs = await logsCol
            .find({ flowId: new ObjectId(req.params.id) })
            .sort({ ts: -1 })
            .limit(limit)
            .toArray();

        res.json({ ok: true, logs });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
};
