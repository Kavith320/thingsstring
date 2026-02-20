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

            // 4) Load flow state
            const flowState = (await flowStateCol.findOne({ flowId: new ObjectId(flowId) })) || {};
            const { lastValue, lastActionTs } = flowState;
            const delta = lastValue !== undefined ? Math.abs(currentValue - lastValue) : null;

            // 5) Evaluate Conditions
            let conditionMet = false;

            // Supporting new 'operator' logic
            if (flow.condition && flow.condition.operator) {
                const { operator, value: targetValue } = flow.condition;

                switch (operator) {
                    case ">": conditionMet = currentValue > targetValue; break;
                    case "<": conditionMet = currentValue < targetValue; break;
                    case ">=": conditionMet = currentValue >= targetValue; break;
                    case "<=": conditionMet = currentValue <= targetValue; break;
                    case "==": conditionMet = currentValue == targetValue; break;
                    case "!=": conditionMet = currentValue != targetValue; break;
                    default: conditionMet = false;
                }
            } else {
                // Fallback to legacy Delta Threshold logic
                if (lastValue !== undefined) {
                    conditionMet = delta > (flow.deltaThreshold || 0);
                } else {
                    // First run: save value and skip
                    await flowStateCol.updateOne(
                        { flowId: new ObjectId(flowId) },
                        { $set: { lastValue: currentValue, lastValueTs: new Date() } },
                        { upsert: true }
                    );
                    return;
                }
            }

            // 6) If condition isn't met, just update lastValue and exit
            if (!conditionMet) {
                await flowStateCol.updateOne(
                    { flowId: new ObjectId(flowId) },
                    { $set: { lastValue: currentValue, lastValueTs: new Date() } },
                    { upsert: true }
                );
                return;
            }

            // 7) Cooldown check
            const now = new Date();

            if (lastActionTs && (now - new Date(lastActionTs)) < (flow.cooldownSec * 1000)) {
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: now,
                    status: "skipped",
                    reason: "cooldown active",
                    currentValue,
                    operator: flow.condition?.operator || "delta"
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
