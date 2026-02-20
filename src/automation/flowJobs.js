const { getDb } = require("../db/mongo");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

/**
 * Helper to get nested value from object using dot notation
 */
function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

/**
 * Automation Flow Job Implementation
 */
function defineFlowJobs(agenda) {
    agenda.define("run_automation_flow", async (job) => {
        const { flowId } = job.attrs.data || {};
        if (!flowId) return;

        const db = getDb();
        const flowsCol = db.collection("automation_flows");
        const flowStateCol = db.collection("automation_flow_state");
        const telemetryCol = db.collection("device_telemetry");
        const controlCol = db.collection("device_control");
        const logsCol = db.collection("automation_flow_logs");

        try {
            // 1) Load flow
            const flow = await flowsCol.findOne({ _id: new ObjectId(flowId) });
            if (!flow || !flow.enabled) {
                console.log(`[AUTOMATION] Flow ${flowId} not found or disabled. Skipping.`);
                return;
            }

            // 2) Fetch latest telemetry
            const latestTelemetry = await telemetryCol.findOne(
                { deviceId: flow.deviceId },
                { sort: { _id: -1 } }
            );

            if (!latestTelemetry) {
                // console.log(`[AUTOMATION] No telemetry for device ${flow.deviceId}. Skipping.`);
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: new Date(),
                    status: "skipped",
                    reason: "no telemetry"
                });
                return;
            }

            // 3) Extract currentValue
            const currentValue = getNestedValue(latestTelemetry, flow.metricPath);
            if (currentValue === undefined || typeof currentValue !== 'number') {
                console.log(`[AUTOMATION] Invalid metric '${flow.metricPath}' for device ${flow.deviceId}. Value:`, currentValue);
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: new Date(),
                    status: "skipped",
                    reason: "invalid metric",
                    metricPath: flow.metricPath
                });
                return;
            }

            // 4) Load flow state
            const flowState = (await flowStateCol.findOne({ flowId: new ObjectId(flowId) })) || {};
            const { lastValue, lastActionTs } = flowState;

            // If no previous lastValue, store and exit
            if (lastValue === undefined) {
                await flowStateCol.updateOne(
                    { flowId: new ObjectId(flowId) },
                    { $set: { lastValue: currentValue, lastValueTs: new Date() } },
                    { upsert: true }
                );
                return;
            }

            // 5) Compute delta
            const delta = Math.abs(currentValue - lastValue);

            // 6) Threshold check
            if (delta <= flow.deltaThreshold) {
                // Just update lastValue to keep it fresh
                await flowStateCol.updateOne(
                    { flowId: new ObjectId(flowId) },
                    { $set: { lastValue: currentValue, lastValueTs: new Date() } }
                );
                return;
            }

            // 7) Cooldown check
            const now = new Date();
            if (lastActionTs && (now - new Date(lastActionTs)) < (flow.cooldownSec * 1000)) {
                // Cooldown active, update lastValue and exit
                await flowStateCol.updateOne(
                    { flowId: new ObjectId(flowId) },
                    { $set: { lastValue: currentValue, lastValueTs: now } }
                );
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: now,
                    status: "skipped",
                    reason: "cooldown active",
                    currentValue,
                    previousValue: lastValue,
                    delta
                });
                return;
            }

            // 8) Update device_control
            // Requirement: Use action.deviceId for the command, NOT the top-level sensor deviceId
            const actuatorDeviceId = flow.action.deviceId || flow.deviceId;
            const control = (await controlCol.findOne({ _id: actuatorDeviceId })) || {};
            const actuators = control.actuators || {};
            const actuatorKey = flow.action.actuatorKey;

            if (!actuators[actuatorKey]) {
                console.log(`[AUTOMATION] Actuator '${actuatorKey}' not found on device ${flow.deviceId}`);
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: now,
                    status: "error",
                    reason: `actuator '${actuatorKey}' not found`
                });
                return;
            }

            // Check if in auto mode
            // Following src/scheduler/jobs.js: actuators[actuatorName].default?.auto !== true
            if (actuators[actuatorKey].default?.auto !== true) {
                console.log(`[AUTOMATION] Actuator '${actuatorKey}' skipped (manual mode) for device ${flow.deviceId}`);
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: now,
                    status: "skipped",
                    reason: "manual mode",
                    currentValue,
                    previousValue: lastValue,
                    delta
                });
                // Update lastValue anyway so we don't trigger immediately when switched to auto
                await flowStateCol.updateOne(
                    { flowId: new ObjectId(flowId) },
                    { $set: { lastValue: currentValue, lastValueTs: now } }
                );
                return;
            }

            // Apply action: Standardized on setValue
            const updateKey = `actuators.${actuatorKey}.value`;
            await controlCol.updateOne(
                { _id: actuatorDeviceId },
                { $set: { [updateKey]: flow.action.setValue } },
                { upsert: true }
            );

            console.log(`✅ [AUTOMATION] Flow ${flow.name} triggered. Set ${actuatorKey} to ${flow.action.setValue} on device ${actuatorDeviceId}`);

            // 9) Update flow state
            await flowStateCol.updateOne(
                { flowId: new ObjectId(flowId) },
                {
                    $set: {
                        lastValue: currentValue,
                        lastValueTs: now,
                        lastActionTs: now
                    }
                },
                { upsert: true }
            );

            // 10) Log record
            await logsCol.insertOne({
                flowId: new ObjectId(flowId),
                ts: now,
                status: "ran",
                currentValue,
                previousValue: lastValue,
                delta,
                action: flow.action
            });

        } catch (error) {
            console.error(`❌ [AUTOMATION] Error in flow ${flowId}:`, error);
        }
    });
}

module.exports = { defineFlowJobs };
