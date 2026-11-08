// src/services/deviceAccess.js
// Who may do what on a device. The owner is device_config.device.user_id (set by the
// device's first config, changed only by an admin transfer). Everyone else gets access
// through an accepted invitation, stored in `device_access` as { deviceId, userId, role }.
//
//   viewer    see the device, its data, graphs, map, CSV export; own alert settings
//   operator  + switch actuators
//   manager   + schedules and automations, invite/remove viewers and operators, activity log
//   owner     + invite managers, change any member
//
// Every API route and both workers go through this file, so revoking access takes
// effect everywhere at once.

const ROLE_RANK = { viewer: 1, operator: 2, manager: 3, owner: 4 };
const SHARE_ROLES = ["viewer", "operator", "manager"];

const atLeast = (role, min) => (ROLE_RANK[role] || 0) >= ROLE_RANK[min];

function ownerOf(config) {
  const id = config?.device?.user_id ?? config?.user_id;
  return id == null ? null : String(id);
}

/** { config, role } if the user can see the device, otherwise null. */
async function getDeviceAccess(db, deviceId, userId) {
  if (typeof deviceId !== "string" || !deviceId || !userId) return null;
  const config = await db.collection("device_config").findOne({ _id: deviceId });
  if (!config) return null;
  const uid = String(userId);
  if (ownerOf(config) === uid) return { config, role: "owner" };
  const share = await db.collection("device_access").findOne({ deviceId, userId: uid }, { projection: { role: 1 } });
  return share && ROLE_RANK[share.role] ? { config, role: share.role } : null;
}

/**
 * Load a device for an action that needs at least `min`.
 * Returns { config, role } or { status, error }: 404 when the user can't see the
 * device at all (so its existence isn't revealed), 403 when the role is too low.
 */
async function requireDeviceRole(db, deviceId, userId, min = "viewer") {
  const access = await getDeviceAccess(db, deviceId, userId);
  if (!access) return { status: 404, error: "Device not found" };
  if (!atLeast(access.role, min)) {
    return { status: 403, error: `This needs ${min} access to the device (you are ${access.role})`, code: "DEVICE_ROLE_TOO_LOW" };
  }
  return access;
}

/** Map(deviceId -> role) of every device the user owns or has been given access to. */
async function accessibleDevices(db, userId) {
  const uid = String(userId);
  const [owned, shared] = await Promise.all([
    db.collection("device_config").find({ "device.user_id": uid }, { projection: { _id: 1 } }).toArray(),
    db.collection("device_access").find({ userId: uid }, { projection: { deviceId: 1, role: 1 } }).toArray(),
  ]);
  const map = new Map();
  for (const s of shared) if (ROLE_RANK[s.role]) map.set(s.deviceId, s.role);
  for (const o of owned) map.set(o._id, "owner"); // ownership wins over a stale share row
  return map;
}

/** Can `actorRole` give/change/remove `targetRole`? Owners: anyone. Managers: viewers and operators. */
function canManageRole(actorRole, targetRole) {
  if (actorRole === "owner") return targetRole !== "owner";
  if (actorRole === "manager") return targetRole === "viewer" || targetRole === "operator";
  return false;
}

/**
 * Remove a user's access to devices and everything that depended on it:
 * their schedules and automation rules on those devices are disabled (not deleted,
 * so they can be restored); their alert settings and group membership are removed.
 * (Device display settings are shared by the device and stay.)
 */
async function cleanupUserDeviceAccess(db, userId, deviceIds, reason) {
  const uid = String(userId);
  if (!deviceIds.length) return;
  const now = new Date();
  await Promise.all([
    db.collection("device_access").deleteMany({ userId: uid, deviceId: { $in: deviceIds } }),
    db.collection("device_alerts").deleteMany({ userId: uid, deviceId: { $in: deviceIds } }),
    db.collection("device_groups").updateMany({ user_id: uid }, { $pull: { deviceIds: { $in: deviceIds } } }),
    db
      .collection("device_schedules")
      .updateMany({ user_id: uid, deviceId: { $in: deviceIds }, enabled: true }, { $set: { enabled: false, disabledReason: reason, updatedAt: now } }),
    db.collection("automation_flows").updateMany(
      { user_id: uid, enabled: true, $or: [{ deviceId: { $in: deviceIds } }, { "action.deviceId": { $in: deviceIds } }] },
      { $set: { enabled: false, disabledReason: reason, updatedAt: now } }
    ),
  ]);
}

module.exports = {
  ROLE_RANK,
  SHARE_ROLES,
  atLeast,
  ownerOf,
  getDeviceAccess,
  requireDeviceRole,
  accessibleDevices,
  canManageRole,
  cleanupUserDeviceAccess,
};
