const { getDb } = require("../db/mongo");
const { publishControl } = require("../services/controlPublisher");
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

            // 2b) Check if sensor device is OFFLINE (telemetry recency threshold)
            const telemetryTime = latestTelemetry.createdAt
                ? new Date(latestTelemetry.createdAt).getTime()
                : (latestTelemetry._id?.getTimestamp ? latestTelemetry._id.getTimestamp().getTime() : 0);

            const maxAgeSec = flow.maxTelemetryAgeSec || parseInt(process.env.DEVICE_OFFLINE_THRESHOLD_SEC || "300", 10);
            const ageSec = Math.floor((Date.now() - telemetryTime) / 1000);

            if (ageSec > maxAgeSec) {
                console.log(`⏭️ [AUTOMATION] Device ${flow.deviceId} is OFFLINE (last telemetry was ${ageSec}s ago). Skipping flow "${flow.name}".`);
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: new Date(),
                    status: "skipped",
                    reason: "device offline (stale telemetry)",
                    telemetryAgeSec: ageSec
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
            const actuatorDeviceId = flow.action.deviceId || flow.deviceId;

            // Check if target actuator device is OFFLINE
            if (actuatorDeviceId !== flow.deviceId) {
                const actuatorTelemetry = await telemetryCol.findOne(
                    { deviceId: actuatorDeviceId },
                    { sort: { _id: -1 } }
                );
                const actTime = actuatorTelemetry?.createdAt
                    ? new Date(actuatorTelemetry.createdAt).getTime()
                    : (actuatorTelemetry?._id?.getTimestamp ? actuatorTelemetry._id.getTimestamp().getTime() : 0);
                const actAgeSec = Math.floor((Date.now() - actTime) / 1000);

                if (actAgeSec > maxAgeSec) {
                    console.log(`⏭️ [AUTOMATION] Actuator device ${actuatorDeviceId} is OFFLINE (last telemetry ${actAgeSec}s ago). Skipping command.`);
                    await logsCol.insertOne({
                        flowId: new ObjectId(flowId),
                        ts: now,
                        status: "skipped",
                        reason: "actuator device offline",
                        actuatorDeviceId,
                        telemetryAgeSec: actAgeSec
                    });
                    return;
                }
            }

            const control = (await controlCol.findOne({ _id: actuatorDeviceId })) || {};
            const actuators = control.actuators || {};
            const actuatorKey = flow.action.actuatorKey;

            if (!actuators[actuatorKey]) {
                console.log(`[AUTOMATION] Actuator '${actuatorKey}' not found on device ${actuatorDeviceId}`);
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: now,
                    status: "error",
                    reason: `actuator '${actuatorKey}' not found`
                });
                return;
            }

            const actuatorObj = actuators[actuatorKey];

            // Check if in auto mode
            if (actuatorObj.default?.auto !== true && actuatorObj.auto !== true) {
                console.log(`[AUTOMATION] Actuator '${actuatorKey}' skipped (manual mode) for device ${actuatorDeviceId}`);
                await logsCol.insertOne({
                    flowId: new ObjectId(flowId),
                    ts: now,
                    status: "skipped",
                    reason: "manual mode",
                    currentValue
                });
                return;
            }

            // --- SMART VALUE MAPPING ---
            const flowVal = flow.action.setValue;
            const $set = {};

            // Determine if the device likely uses string states (ON/OFF)
            // We check the top level OR the default object for clues
            const hasStateKey = actuatorObj.hasOwnProperty('state');
            const hasStatusKey = actuatorObj.hasOwnProperty('status');
            const defaultState = actuatorObj.default?.state;
            const defaultStatus = actuatorObj.default?.status;

            const isStringState = (typeof actuatorObj.state === 'string') ||
                (typeof defaultState === 'string');
            const isStringStatus = (typeof actuatorObj.status === 'string') ||
                (typeof defaultStatus === 'string');

            // 1. Handle 'state'
            if (hasStateKey || defaultState !== undefined || isStringState) {
                let mappedVal = flowVal;
                // If it looks like it wants ON/OFF, give it ON/OFF
                if (isStringState || (defaultState && (defaultState === 'ON' || defaultState === 'OFF'))) {
                    mappedVal = flowVal ? 'ON' : 'OFF';
                }
                $set[`actuators.${actuatorKey}.state`] = mappedVal;
            }

            // 2. Handle 'status'
            if (hasStatusKey || defaultStatus !== undefined || isStringStatus) {
                let mappedVal = flowVal;
                if (isStringStatus || (defaultStatus && (defaultStatus === 'ON' || defaultStatus === 'OFF'))) {
                    mappedVal = flowVal ? 'ON' : 'OFF';
                }
                $set[`actuators.${actuatorKey}.status`] = mappedVal;
            }

            // 3. Always update 'value' as well
            $set[`actuators.${actuatorKey}.value`] = flowVal;

            // Apply updates to DB
            await controlCol.updateOne(
                { _id: actuatorDeviceId },
                { $set },
                { upsert: true }
            );

            // Fetch latest and publish
            const controlDoc = await controlCol.findOne({ _id: actuatorDeviceId });
            publishControl(actuatorDeviceId, controlDoc);

            console.log(`🚀 [AUTOMATION] Flow "${flow.name}" logic met (${currentValue} ${flow.condition?.operator} ${flow.condition?.value}). Command sent to ${actuatorDeviceId}.`);

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
