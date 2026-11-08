const bcrypt = require("bcrypt");
const User = require("../models/User");
const { getDb, isMongoConnected } = require("../db/mongo");
const { getMqttClient } = require("../mqtt/client");
const { publishControl } = require("../services/controlPublisher");
const { deleteFiles } = require("../services/fileStore");
const { notifyUser, deviceDisplayName } = require("../email/notify");
const { cleanupUserDeviceAccess } = require("../services/deviceAccess");
const { logActivity, actorFromReq } = require("../services/activity");
const { budget } = require("../email/budget");
const { logAdminAction } = require("../services/auditLogger");
const { buildControlSet } = require("./devices.controller");
const { backupFullDatabase } = require("../../scripts/backup_full_db");
const { backupAndCleanupTelemetry } = require("../../scripts/backup_and_cleanup_telemetry");
const { sendServerError, parseObjectId, isPlainObject, isSafeKey, clampInt } = require("../utils/http");

const MIN_PASSWORD_LENGTH = 8;

function audit(req, action, targetId, details) {
  return logAdminAction({ adminId: req.user.id, adminEmail: req.user.email, action, targetId, details, req });
}

function badUserId(res) {
  return res.status(400).json({ ok: false, error: "Invalid userId" });
}

/** Would this change leave the system without any active admin? */
async function wouldRemoveLastAdmin(userId) {
  const user = await User.findById(userId).select("role status isActive").lean();
  if (!user || user.role !== "admin") return false;
  const otherAdmins = await User.countDocuments({
    _id: { $ne: user._id },
    role: "admin",
    status: { $ne: "disabled" },
    isActive: { $ne: false },
  });
  return otherAdmins === 0;
}

/** Flows that read from or act on any of these devices. */
function flowsTouching(deviceIds) {
  return { $or: [{ deviceId: { $in: deviceIds } }, { "action.deviceId": { $in: deviceIds } }] };
}

async function deleteFlowsTouching(db, deviceIds) {
  const flows = await db.collection("automation_flows").find(flowsTouching(deviceIds), { projection: { _id: 1 } }).toArray();
  const ids = flows.map((f) => f._id);
  if (ids.length) {
    await db.collection("automation_flows").deleteMany({ _id: { $in: ids } });
    await db.collection("automation_flow_state").deleteMany({ flowId: { $in: ids } });
  }
  return ids.length;
}

/**
 * Remove dashboard personalisation for devices (display settings, group membership)
 * and, with `userId`, everything the user owns (groups, layout, uploaded files).
 */
async function removePersonalisation(db, { userId, deviceIds = [] }) {
  if (deviceIds.length) {
    // Everyone's settings for these devices, and all sharing: a deleted or transferred
    // device starts clean for its (new) owner
    await db.collection("device_ui").deleteMany({ deviceId: { $in: deviceIds } });
    await db.collection("device_groups").updateMany({ deviceIds: { $in: deviceIds } }, { $pull: { deviceIds: { $in: deviceIds } } });
    await db.collection("device_access").deleteMany({ deviceId: { $in: deviceIds } });
    await db.collection("device_alerts").deleteMany({ deviceId: { $in: deviceIds } });
    await db.collection("device_activity").deleteMany({ deviceId: { $in: deviceIds } });
    await db
      .collection("device_invites")
      .updateMany({ deviceId: { $in: deviceIds }, status: "pending" }, { $set: { status: "revoked", revokedReason: "device removed or transferred" } });
  }
  if (userId) {
    // Devices other people shared with this user
    const shared = await db.collection("device_access").find({ userId }, { projection: { deviceId: 1 } }).toArray();
    await cleanupUserDeviceAccess(db, userId, shared.map((s) => s.deviceId), "user deleted");
    await db.collection("device_alerts").deleteMany({ userId });
    await db.collection("device_invites").updateMany({ invitedBy: userId, status: "pending" }, { $set: { status: "revoked", revokedReason: "inviter deleted" } });
    await db.collection("device_ui").deleteMany({ user_id: userId });
    await db.collection("device_groups").deleteMany({ user_id: userId });
    await db.collection("dashboards").deleteOne({ _id: userId });
    await deleteFiles(db, { user_id: userId });
  }
}

// GET /api/admin/email/stats — free-tier quota usage
async function getEmailStats(req, res) {
  try {
    const db = getDb();
    const since = new Date(Date.now() - 24 * 3600e3);
    const col = db.collection("email_outbox");
    const [b, failed24h, byCategory] = await Promise.all([
      budget(db),
      col.countDocuments({ status: "failed", createdAt: { $gte: since } }),
      col.aggregate([{ $match: { status: "sent", sentAt: { $gte: since } } }, { $group: { _id: "$category", n: { $sum: 1 } } }]).toArray(),
    ]);
    return res.json({
      ok: true,
      window: "last 24 hours",
      ...b,
      failed24h,
      sentByCategory: Object.fromEntries(byCategory.map((c) => [c._id || "other", c.n])),
    });
  } catch (e) {
    return sendServerError(res, e, "admin email stats");
  }
}

// GET /api/admin/stats
async function getSystemStats(req, res) {
  try {
    const db = getDb();
    const [users, devices, telemetry, schedules, flows] = await Promise.all([
      User.estimatedDocumentCount(),
      db.collection("device_config").estimatedDocumentCount(),
      db.collection("device_telemetry").estimatedDocumentCount(),
      db.collection("device_schedules").estimatedDocumentCount(),
      db.collection("automation_flows").estimatedDocumentCount(),
    ]);
    return res.json({
      ok: true,
      stats: { users, devices, telemetry_records: telemetry, schedules, automation_flows: flows },
    });
  } catch (e) {
    return sendServerError(res, e, "admin stats");
  }
}

// GET /api/admin/users
async function getAllUsers(req, res) {
  try {
    const users = await User.find({}, "-passwordHash -tokenVersion");
    return res.json({ ok: true, count: users.length, users });
  } catch (e) {
    return sendServerError(res, e, "admin list users");
  }
}

// DELETE /api/admin/users/:userId — also deletes the user's devices, their data, schedules and flows
async function deleteUser(req, res) {
  try {
    const { userId } = req.params;
    if (!parseObjectId(userId)) return badUserId(res);
    if (userId === req.user.id) {
      return res.status(400).json({ ok: false, error: "You cannot delete your own account" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });
    if (await wouldRemoveLastAdmin(userId)) {
      return res.status(400).json({ ok: false, error: "Cannot delete the last active admin" });
    }

    const db = getDb();
    const deviceIds = (await db.collection("device_config").find({ "device.user_id": userId }, { projection: { _id: 1 } }).toArray()).map(
      (d) => d._id
    );

    if (deviceIds.length > 0) {
      await db.collection("device_config").deleteMany({ _id: { $in: deviceIds } });
      await db.collection("device_telemetry").deleteMany({ deviceId: { $in: deviceIds } });
      await db.collection("device_control").deleteMany({ _id: { $in: deviceIds } });
      await db.collection("device_schedules").deleteMany({ deviceId: { $in: deviceIds } });
      await deleteFlowsTouching(db, deviceIds);
    }
    await db.collection("device_schedules").deleteMany({ user_id: userId });
    const userFlows = await db.collection("automation_flows").find({ user_id: userId }, { projection: { _id: 1 } }).toArray();
    if (userFlows.length) {
      await db.collection("automation_flows").deleteMany({ user_id: userId });
      await db.collection("automation_flow_state").deleteMany({ flowId: { $in: userFlows.map((f) => f._id) } });
    }

    await removePersonalisation(db, { userId, deviceIds });

    await User.findByIdAndDelete(userId);
    await audit(req, "USER_DELETE", userId, { userEmail: user.email, devicesDeleted: deviceIds });

    return res.json({ ok: true, message: "User, devices, schedules and automation flows deleted" });
  } catch (e) {
    return sendServerError(res, e, "admin delete user");
  }
}

// GET /api/admin/devices
async function getAllDevices(req, res) {
  try {
    const devices = await getDb().collection("device_config").find({}).toArray();
    return res.json({ ok: true, count: devices.length, devices });
  } catch (e) {
    return sendServerError(res, e, "admin list devices");
  }
}

// DELETE /api/admin/devices/:deviceId
async function deleteDevice(req, res) {
  try {
    const { deviceId } = req.params;
    const db = getDb();

    const device = await db.collection("device_config").findOne({ _id: deviceId }, { projection: { device: 1 } });
    if (!device) return res.status(404).json({ ok: false, error: "Device not found" });

    await db.collection("device_config").deleteOne({ _id: deviceId });
    await db.collection("device_telemetry").deleteMany({ deviceId });
    await db.collection("device_control").deleteOne({ _id: deviceId });
    await db.collection("device_schedules").deleteMany({ deviceId });
    const flowsDeleted = await deleteFlowsTouching(db, [deviceId]);
    await removePersonalisation(db, { deviceIds: [deviceId] });

    await audit(req, "DEVICE_DELETE", deviceId, { ownerId: device.device?.user_id || null, flowsDeleted });
    return res.json({ ok: true, message: "Device and associated data deleted" });
  } catch (e) {
    return sendServerError(res, e, "admin delete device");
  }
}

// GET /api/admin/schedules
async function getAllSchedules(req, res) {
  try {
    const schedules = await getDb().collection("device_schedules").find({}).toArray();
    return res.json({ ok: true, count: schedules.length, schedules });
  } catch (e) {
    return sendServerError(res, e, "admin list schedules");
  }
}

// DELETE /api/admin/schedules/:scheduleId
async function deleteSchedule(req, res) {
  try {
    const _id = parseObjectId(req.params.scheduleId);
    if (!_id) return res.status(400).json({ ok: false, error: "Invalid scheduleId" });

    const schedule = await getDb().collection("device_schedules").findOneAndDelete({ _id });
    if (!schedule) return res.status(404).json({ ok: false, error: "Schedule not found" });

    await audit(req, "SCHEDULE_DELETE", String(_id), { name: schedule.name, deviceId: schedule.deviceId });
    return res.json({ ok: true, message: "Schedule deleted successfully" });
  } catch (e) {
    return sendServerError(res, e, "admin delete schedule");
  }
}

// GET /api/admin/devices/:deviceId
async function getDeviceDetails(req, res) {
  try {
    const { deviceId } = req.params;
    const db = getDb();

    const config = await db.collection("device_config").findOne({ _id: deviceId });
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    const [telemetryHistory, control] = await Promise.all([
      db.collection("device_telemetry").find({ deviceId }).sort({ _id: -1 }).limit(50).toArray(),
      db.collection("device_control").findOne({ _id: deviceId }),
    ]);

    return res.json({ ok: true, device: { config, control, telemetry_history: telemetryHistory } });
  } catch (e) {
    return sendServerError(res, e, "admin device details");
  }
}

// POST /api/admin/devices/:deviceId/control  (admin override: works on locked devices)
async function controlDevice(req, res) {
  try {
    const { deviceId } = req.params;
    const db = getDb();

    const config = await db.collection("device_config").findOne({ _id: deviceId });
    if (!config) return res.status(404).json({ ok: false, error: "Device not found" });

    const { error, $set } = buildControlSet(config, (req.body || {}).actuators);
    if (error) return res.status(400).json({ ok: false, error });

    const controlDoc = await db
      .collection("device_control")
      .findOneAndUpdate({ _id: deviceId }, { $set }, { upsert: true, returnDocument: "after" });
    publishControl(deviceId, controlDoc);

    await audit(req, "DEVICE_CONTROL", deviceId, { actuators: req.body.actuators });
    return res.json({ ok: true, control: controlDoc });
  } catch (e) {
    return sendServerError(res, e, "admin device control");
  }
}

// GET /api/admin/devices/:deviceId/telemetry?start=...&end=...&limit=...
async function getDeviceTelemetryHistory(req, res) {
  try {
    const { deviceId } = req.params;
    const { start, end } = req.query;
    const limit = clampInt(req.query.limit, { min: 1, max: 5000, fallback: 100 });

    const query = { deviceId };
    const dateQuery = {};
    if (typeof start === "string") {
      const d = new Date(start);
      if (!isNaN(d.getTime())) dateQuery.$gte = d;
    }
    if (typeof end === "string") {
      const d = new Date(end);
      if (!isNaN(d.getTime())) dateQuery.$lte = d;
    }
    if (Object.keys(dateQuery).length > 0) query.createdAt = dateQuery;

    const telemetry = await getDb().collection("device_telemetry").find(query).sort({ _id: -1 }).limit(limit).toArray();
    return res.json({ ok: true, deviceId, count: telemetry.length, telemetry });
  } catch (e) {
    return sendServerError(res, e, "admin telemetry");
  }
}

// GET /api/admin/health
async function getSystemHealth(req, res) {
  try {
    const mongoConnected = isMongoConnected();
    const dbStats = mongoConnected ? await getDb().stats({ scale: 1024 * 1024 }) : {};

    let mqttConnected = false;
    try {
      mqttConnected = !!getMqttClient().connected;
    } catch {
      mqttConnected = false;
    }

    const memory = process.memoryUsage();
    return res.json({
      ok: true,
      health: {
        status: mongoConnected && mqttConnected ? "healthy" : "degraded",
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
          rssMB: Math.round(memory.rss / (1024 * 1024)),
          heapUsedMB: Math.round(memory.heapUsed / (1024 * 1024)),
          heapTotalMB: Math.round(memory.heapTotal / (1024 * 1024)),
        },
        mongo: {
          connected: mongoConnected,
          dataSizeMB: dbStats.dataSize,
          storageSizeMB: dbStats.storageSize,
          collections: dbStats.collections,
          objectsCount: dbStats.objects,
        },
        mqtt: { connected: mqttConnected },
      },
    });
  } catch (e) {
    return sendServerError(res, e, "admin health");
  }
}

// PUT /api/admin/users/:userId/role
async function updateUserRole(req, res) {
  try {
    const { userId } = req.params;
    const { role } = req.body || {};
    if (!parseObjectId(userId)) return badUserId(res);
    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ ok: false, error: "Invalid role. Must be 'user' or 'admin'" });
    }
    if (role !== "admin" && userId === req.user.id) {
      return res.status(400).json({ ok: false, error: "You cannot remove your own admin role" });
    }
    if (role !== "admin" && (await wouldRemoveLastAdmin(userId))) {
      return res.status(400).json({ ok: false, error: "Cannot demote the last active admin" });
    }

    const before = await User.findById(userId).select("role").lean();
    if (!before) return res.status(404).json({ ok: false, error: "User not found" });

    // Changing the role revokes the user's existing tokens (they carry the old role)
    const update = { $set: { role } };
    if (before.role !== role) update.$inc = { tokenVersion: 1 };
    const user = await User.findByIdAndUpdate(userId, update, { new: true }).select("-passwordHash -tokenVersion");

    await audit(req, "USER_ROLE_UPDATE", userId, { from: before.role, to: role, userEmail: user.email });
    return res.json({ ok: true, message: `User role updated to '${role}'`, user });
  } catch (e) {
    return sendServerError(res, e, "admin update role");
  }
}

// POST /api/admin/users/:userId/reset-password
async function resetUserPassword(req, res) {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body || {};
    if (!parseObjectId(userId)) return badUserId(res);
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 128) {
      return res.status(400).json({ ok: false, error: `Password must be ${MIN_PASSWORD_LENGTH}-128 characters` });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    // Revokes every existing session of that user
    const user = await User.findByIdAndUpdate(userId, { $set: { passwordHash }, $inc: { tokenVersion: 1 } }, { new: true }).select(
      "email"
    );
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    await audit(req, "USER_PASSWORD_RESET", userId, { userEmail: user.email });
    await notifyUser(getDb(), { userId, category: "account", template: "adminPasswordReset" });
    return res.json({ ok: true, message: "User password reset successfully" });
  } catch (e) {
    return sendServerError(res, e, "admin reset password");
  }
}

// POST /api/admin/devices/:deviceId/lockout
async function toggleDeviceLockout(req, res) {
  try {
    const { deviceId } = req.params;
    const { disabled, reason } = req.body || {};
    const configCol = getDb().collection("device_config");

    const device = await configCol.findOne({ _id: deviceId }, { projection: { isDisabled: 1, device: 1, user_id: 1 } });
    if (!device) return res.status(404).json({ ok: false, error: "Device not found" });

    const isDisabled = disabled !== undefined ? Boolean(disabled) : !device.isDisabled;
    const disabledReason = isDisabled ? (typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 300) : "Admin Lockout") : null;

    await configCol.updateOne(
      { _id: deviceId },
      { $set: { isDisabled, disabledReason, disabledAt: isDisabled ? new Date() : null } }
    );

    await audit(req, isDisabled ? "DEVICE_LOCKOUT" : "DEVICE_UNLOCK", deviceId, { reason: disabledReason });
    await logActivity(getDb(), { deviceId, actor: actorFromReq(req, "admin"), action: isDisabled ? "admin.lock" : "admin.unlock", details: { reason: disabledReason } });
    if (!!device.isDisabled !== isDisabled) {
      const ownerId = device.device?.user_id || device.user_id;
      const { name } = await deviceDisplayName(getDb(), deviceId, ownerId);
      await notifyUser(getDb(), {
        userId: ownerId,
        category: "account",
        template: isDisabled ? "deviceLocked" : "deviceUnlocked",
        data: { deviceId, deviceName: name, reason: disabledReason },
      });
    }
    return res.json({
      ok: true,
      message: `Device ${deviceId} has been ${isDisabled ? "LOCKED OUT" : "UNLOCKED"}`,
      deviceId,
      isDisabled,
    });
  } catch (e) {
    return sendServerError(res, e, "admin lockout");
  }
}

// Operators that run server-side JavaScript or can be abused for heavy scans
const FORBIDDEN_FILTER_OPS = new Set(["$where", "$function", "$accumulator", "$expr"]);

function isSafeFilter(v, depth = 0) {
  if (depth > 10) return false;
  if (Array.isArray(v)) return v.every((x) => isSafeFilter(x, depth + 1));
  if (!isPlainObject(v)) return true;
  return Object.entries(v).every(([k, x]) => !FORBIDDEN_FILTER_OPS.has(k) && isSafeFilter(x, depth + 1));
}

// POST /api/admin/broadcast/control
async function broadcastDeviceControl(req, res) {
  try {
    const { actuators, filter = {} } = req.body || {};
    if (!isPlainObject(actuators) || Object.keys(actuators).length === 0) {
      return res.status(400).json({ ok: false, error: "Body must include 'actuators' object" });
    }
    for (const [name, patch] of Object.entries(actuators)) {
      if (!isSafeKey(name) || !isPlainObject(patch) || !Object.keys(patch).every(isSafeKey)) {
        return res.status(400).json({ ok: false, error: `Invalid patch for actuator '${name}'` });
      }
    }
    if (!isPlainObject(filter) || !isSafeFilter(filter)) {
      return res.status(400).json({ ok: false, error: "Invalid filter" });
    }

    const db = getDb();
    const controlCol = db.collection("device_control");
    const devices = await db.collection("device_config").find(filter, { projection: { actuators: 1 } }).toArray();

    const affected = [];
    for (const dev of devices) {
      const $set = {};
      for (const [actName, actPatch] of Object.entries(actuators)) {
        if (isPlainObject(dev.actuators) && Object.prototype.hasOwnProperty.call(dev.actuators, actName)) {
          for (const [k, v] of Object.entries(actPatch)) $set[`actuators.${actName}.${k}`] = v;
        }
      }
      if (Object.keys($set).length === 0) continue;

      const controlDoc = await controlCol.findOneAndUpdate(
        { _id: dev._id },
        { $set },
        { upsert: true, returnDocument: "after" }
      );
      publishControl(dev._id, controlDoc);
      affected.push(dev._id);
    }

    await audit(req, "BROADCAST_CONTROL", null, { actuators, filter, affected });
    return res.json({
      ok: true,
      message: `Broadcast control command sent to ${affected.length} devices`,
      affectedCount: affected.length,
    });
  } catch (e) {
    return sendServerError(res, e, "admin broadcast");
  }
}

// PUT /api/admin/users/:userId/status
async function setUserStatus(req, res) {
  try {
    const { userId } = req.params;
    const { status } = req.body || {};
    if (!parseObjectId(userId)) return badUserId(res);
    if (!["active", "disabled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Status must be 'active' or 'disabled'" });
    }
    if (status === "disabled" && userId === req.user.id) {
      return res.status(400).json({ ok: false, error: "You cannot disable your own account" });
    }
    if (status === "disabled" && (await wouldRemoveLastAdmin(userId))) {
      return res.status(400).json({ ok: false, error: "Cannot disable the last active admin" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const wasActive = user.status !== "disabled" && user.isActive !== false;
    // Email before suspending: notifyUser skips suspended accounts
    if (wasActive && status === "disabled") {
      await notifyUser(getDb(), { userId, category: "account", template: "accountSuspended" });
    }
    user.status = status;
    user.isActive = status === "active";
    await user.save();
    if (!wasActive && status === "active") {
      await notifyUser(getDb(), { userId, category: "account", template: "accountReactivated" });
    }

    await audit(req, "USER_STATUS_UPDATE", userId, { newStatus: status, userEmail: user.email });
    return res.json({
      ok: true,
      message: `User status set to ${status}`,
      user: { id: user._id, email: user.email, status: user.status },
    });
  } catch (e) {
    return sendServerError(res, e, "admin user status");
  }
}

// PUT /api/admin/devices/:deviceId/transfer
async function transferDeviceOwnership(req, res) {
  try {
    const { deviceId } = req.params;
    const { targetUserId } = req.body || {};
    if (typeof targetUserId !== "string" || !targetUserId) {
      return res.status(400).json({ ok: false, error: "Missing required parameter 'targetUserId'" });
    }

    // Find target user (by MongoDB _id or userId8)
    let targetUser = parseObjectId(targetUserId) ? await User.findById(targetUserId) : null;
    if (!targetUser) targetUser = await User.findOne({ userId8: targetUserId });
    if (!targetUser) return res.status(404).json({ ok: false, error: "Target user not found" });

    const db = getDb();
    const configCol = db.collection("device_config");
    const device = await configCol.findOne({ _id: deviceId });
    if (!device) return res.status(404).json({ ok: false, error: "Device not found" });

    const previousOwnerId = device.device?.user_id || null;
    const newOwnerId = String(targetUser._id);
    const oldName = previousOwnerId ? (await deviceDisplayName(db, deviceId, previousOwnerId)).name : deviceId;

    // Both owner fields are set; the MQTT ingest keeps them even when the device reboots
    await configCol.updateOne(
      { _id: deviceId },
      { $set: { "device.user_id": newOwnerId, user_id: newOwnerId, ownerAssignedAt: new Date(), updatedAt: new Date() } }
    );

    // The old owner's flows/schedules must not keep driving a device they no longer own
    const flowsDeleted = previousOwnerId !== newOwnerId ? await deleteFlowsTouching(db, [deviceId]) : 0;
    const schedules = previousOwnerId !== newOwnerId ? await db.collection("device_schedules").deleteMany({ deviceId }) : { deletedCount: 0 };
    // The old owner's names, location and groups for this device go too (privacy)
    if (previousOwnerId !== newOwnerId) await removePersonalisation(db, { deviceIds: [deviceId] });

    if (previousOwnerId !== newOwnerId) {
      if (previousOwnerId) {
        await notifyUser(db, { userId: previousOwnerId, category: "account", template: "deviceTransferredAway", data: { deviceId, deviceName: oldName } });
      }
      await notifyUser(db, { userId: newOwnerId, category: "account", template: "deviceTransferredIn", data: { deviceId } });
    }

    await audit(req, "DEVICE_TRANSFER", deviceId, {
      previousOwnerId,
      newOwnerId,
      newOwnerEmail: targetUser.email,
      flowsDeleted,
      schedulesDeleted: schedules.deletedCount,
    });

    return res.json({
      ok: true,
      message: `Device ${deviceId} transferred to user ${targetUser.email}`,
      deviceId,
      newOwner: { id: targetUser._id, email: targetUser.email },
    });
  } catch (e) {
    return sendServerError(res, e, "admin transfer device");
  }
}

// GET /api/admin/automation/flows
async function getAllAutomationFlows(req, res) {
  try {
    const flows = await getDb().collection("automation_flows").find({}).toArray();

    const userIds = [...new Set(flows.map((f) => f.user_id).filter((id) => parseObjectId(String(id))))];
    const users = await User.find({ _id: { $in: userIds } }, "name email");
    const userMap = {};
    users.forEach((u) => {
      userMap[String(u._id)] = { name: u.name, email: u.email };
    });

    const enrichedFlows = flows.map((f) => ({
      ...f,
      owner: userMap[String(f.user_id)] || { name: "Unknown", email: "N/A" },
    }));
    return res.json({ ok: true, count: enrichedFlows.length, flows: enrichedFlows });
  } catch (e) {
    return sendServerError(res, e, "admin list flows");
  }
}

function flowFilter(flowId) {
  const oid = parseObjectId(flowId);
  return oid ? { $or: [{ _id: flowId }, { _id: oid }] } : { _id: flowId };
}

// PUT /api/admin/automation/flows/:flowId/toggle
async function toggleAutomationFlow(req, res) {
  try {
    const { flowId } = req.params;
    const { enabled } = req.body || {};
    const flowsCol = getDb().collection("automation_flows");
    const filter = flowFilter(flowId);

    const flow = await flowsCol.findOne(filter);
    if (!flow) return res.status(404).json({ ok: false, error: "Automation flow not found" });

    const newEnabled = enabled !== undefined ? Boolean(enabled) : !flow.enabled;
    await flowsCol.updateOne(filter, { $set: { enabled: newEnabled, updatedAt: new Date() } });

    await audit(req, "AUTOMATION_FLOW_TOGGLE", String(flow._id), { enabled: newEnabled, flowName: flow.name });
    return res.json({ ok: true, message: `Flow ${flow.name} ${newEnabled ? "ENABLED" : "DISABLED"}`, enabled: newEnabled });
  } catch (e) {
    return sendServerError(res, e, "admin toggle flow");
  }
}

// DELETE /api/admin/automation/flows/:flowId
async function deleteAutomationFlow(req, res) {
  try {
    const { flowId } = req.params;
    const db = getDb();
    const filter = flowFilter(flowId);

    const flow = await db.collection("automation_flows").findOne(filter);
    if (!flow) return res.status(404).json({ ok: false, error: "Automation flow not found" });

    await db.collection("automation_flows").deleteOne(filter);
    await db.collection("automation_flow_state").deleteMany({ flowId: flow._id });

    await audit(req, "AUTOMATION_FLOW_DELETE", String(flow._id), { flowName: flow.name, deviceId: flow.deviceId });
    return res.json({ ok: true, message: `Automation flow '${flow.name}' deleted successfully` });
  } catch (e) {
    return sendServerError(res, e, "admin delete flow");
  }
}

// GET /api/admin/automation/logs?flowId=&deviceId=&status=RAN|SKIPPED|ERROR&limit=
async function getGlobalAutomationLogs(req, res) {
  try {
    const { flowId, deviceId, status } = req.query;
    const query = {};

    if (typeof flowId === "string" && flowId) {
      const oid = parseObjectId(flowId);
      if (!oid) return res.status(400).json({ ok: false, error: "Invalid flowId" });
      query.flowId = oid; // logs store flowId as an ObjectId
    }
    if (typeof deviceId === "string" && deviceId) {
      // sensor device or target device
      query.$or = [{ deviceId }, { actuatorDeviceId: deviceId }];
    }
    if (typeof status === "string" && status) query.status = status.toLowerCase(); // stored lowercase

    const limit = clampInt(req.query.limit, { min: 1, max: 1000, fallback: 100 });
    const logs = await getDb().collection("automation_flow_logs").find(query).sort({ ts: -1 }).limit(limit).toArray();

    return res.json({ ok: true, count: logs.length, logs });
  } catch (e) {
    return sendServerError(res, e, "admin automation logs");
  }
}

// POST /api/admin/maintenance/backup
async function triggerDatabaseBackup(req, res) {
  try {
    const backupDir = await backupFullDatabase();
    await audit(req, "MAINTENANCE_BACKUP", null, { backupDir });
    return res.json({ ok: true, message: "On-demand full database backup completed", backupDir });
  } catch (e) {
    return sendServerError(res, e, "admin backup");
  }
}

// POST /api/admin/maintenance/clean-telemetry
async function triggerTelemetryCleanup(req, res) {
  try {
    const daysToKeep = clampInt((req.body || {}).daysToKeep, { min: 1, max: 365, fallback: 7 });
    const result = await backupAndCleanupTelemetry(daysToKeep);

    await audit(req, "MAINTENANCE_TELEMETRY_CLEANUP", null, { daysToKeep, deleted: result.deletedCount });
    return res.json({
      ok: true,
      message: `Telemetry cleanup done (retained ${daysToKeep} days)`,
      deletedCount: result.deletedCount,
    });
  } catch (e) {
    return sendServerError(res, e, "admin telemetry cleanup");
  }
}

// GET /api/admin/audit-logs
async function getAuditLogs(req, res) {
  try {
    const { action, adminEmail, targetId } = req.query;
    const query = {};
    if (typeof action === "string" && action) query.action = action;
    if (typeof adminEmail === "string" && adminEmail) query.adminEmail = adminEmail;
    if (typeof targetId === "string" && targetId) query.targetId = targetId;

    const limit = clampInt(req.query.limit, { min: 1, max: 1000, fallback: 100 });
    const logs = await getDb().collection("admin_audit_logs").find(query).sort({ timestamp: -1 }).limit(limit).toArray();

    return res.json({ ok: true, count: logs.length, logs });
  } catch (e) {
    return sendServerError(res, e, "admin audit logs");
  }
}

module.exports = {
  getEmailStats,
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
