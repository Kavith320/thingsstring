// src/services/invites.js
// Device invitations. The link carries a random token; only its SHA-256 hash is stored.
// Invites last 7 days, and the documents are removed 30 days after expiring.

const crypto = require("node:crypto");
const { ObjectId } = require("mongoose").mongo;
const { getDeviceAccess, canManageRole } = require("./deviceAccess");
const { logActivity } = require("./activity");
const { deviceDisplayName } = require("../email/notify");

const INVITE_TTL_MS = 7 * 24 * 3600e3;
const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

function newInviteToken() {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/** A pending, unexpired invite by its raw link token, or null. */
async function findInviteByToken(db, raw) {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 200) return null;
  return db.collection("device_invites").findOne({ tokenHash: hashToken(raw), status: "pending", expiresAt: { $gt: new Date() } });
}

/**
 * Turn an invite into access for `user` (a users-collection doc: _id, email).
 * Returns { ok, deviceId, role } or { error, status }.
 */
async function acceptInvite(db, invite, user) {
  const uid = String(user._id);
  if (!invite || invite.status !== "pending" || invite.expiresAt <= new Date()) {
    return { status: 400, error: "This invitation is invalid or has expired" };
  }
  if (String(user.email).toLowerCase() !== invite.email) {
    return { status: 403, error: `This invitation was sent to ${invite.email}. Sign in with that email to accept it.` };
  }

  const config = await db.collection("device_config").findOne({ _id: invite.deviceId }, { projection: { device: 1, user_id: 1 } });
  if (!config) return { status: 400, error: "This device no longer exists" };

  // The person who invited must still be allowed to give this role
  const inviter = await getDeviceAccess(db, invite.deviceId, invite.invitedBy);
  if (!inviter || !canManageRole(inviter.role, invite.role)) {
    await db.collection("device_invites").updateOne({ _id: invite._id }, { $set: { status: "revoked", revokedReason: "inviter lost access" } });
    return { status: 400, error: "This invitation is no longer valid" };
  }

  const existing = await getDeviceAccess(db, invite.deviceId, uid);
  if (existing?.role === "owner") return { status: 400, error: "You already own this device" };

  const now = new Date();
  await db.collection("device_access").updateOne(
    { deviceId: invite.deviceId, userId: uid },
    { $set: { role: invite.role, grantedBy: invite.invitedBy, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  await db
    .collection("device_invites")
    .updateOne({ _id: invite._id }, { $set: { status: "accepted", acceptedBy: uid, acceptedAt: now } });
  await logActivity(db, {
    deviceId: invite.deviceId,
    actor: { type: "user", id: uid, email: user.email },
    action: "share.accept",
    details: { role: invite.role, invitedBy: invite.invitedBy },
  });
  return { ok: true, deviceId: invite.deviceId, role: invite.role };
}

/** Public summary of an invite for the invite page (before the user signs in). */
async function describeInvite(db, invite) {
  const [inviter, { name: deviceName }, account] = await Promise.all([
    ObjectId.isValid(invite.invitedBy)
      ? db.collection("users").findOne({ _id: new ObjectId(invite.invitedBy) }, { projection: { name: 1 } })
      : null,
    deviceDisplayName(db, invite.deviceId),
    db.collection("users").findOne({ email: invite.email }, { projection: { _id: 1 } }),
  ]);
  return {
    email: invite.email,
    role: invite.role,
    deviceId: invite.deviceId,
    deviceName,
    invitedBy: inviter?.name || "A ThingsString user",
    expiresAt: invite.expiresAt,
    accountExists: !!account, // the page shows "Sign in" or "Create account"
  };
}

module.exports = { INVITE_TTL_MS, newInviteToken, findInviteByToken, acceptInvite, describeInvite, hashToken };
