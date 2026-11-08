// src/controllers/sharing.controller.js
// Device members and invitations, per-device alert settings, and the device activity log.

const { ObjectId } = require("mongoose").mongo;
const { getDb } = require("../db/mongo");
const { sendServerError, parseObjectId, clampInt, isPlainObject } = require("../utils/http");
const { requireDeviceRole, canManageRole, SHARE_ROLES, ownerOf, cleanupUserDeviceAccess } = require("../services/deviceAccess");
const { logActivity, actorFromReq } = require("../services/activity");
const { INVITE_TTL_MS, newInviteToken, findInviteByToken, acceptInvite, describeInvite } = require("../services/invites");
const { enqueueEmail } = require("../email/outbox");
const { budget } = require("../email/budget");
const { saveAlertSettings, serializeAlertSettings, alertId, MIN_AFTER_MIN, MAX_AFTER_MIN } = require("../services/deviceWatchdog");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MEMBERS = 25; // members + pending invites per device
const MAX_INVITES_PER_DAY = 20; // per inviter: invitation emails count against the free-tier quota

const bad = (res, error, status = 400, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
const denied = (res, a) => bad(res, a.error, a.status, a.code ? { code: a.code } : {});

async function usersById(db, ids) {
  const valid = [...new Set(ids.filter((id) => ObjectId.isValid(String(id))).map(String))];
  if (!valid.length) return new Map();
  const users = await db
    .collection("users")
    .find({ _id: { $in: valid.map((id) => new ObjectId(id)) } }, { projection: { name: 1, email: 1, avatar: 1 } })
    .toArray();
  return new Map(users.map((u) => [String(u._id), { userId: String(u._id), name: u.name, email: u.email, avatar: u.avatar || null }]));
}

/* ───────────────────────────── Members ───────────────────────────── */

// GET /api/devices/:deviceId/members   (manager+)
async function listMembers(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const a = await requireDeviceRole(db, deviceId, req.user.id, "manager");
    if (a.error) return denied(res, a);

    const [shares, invites] = await Promise.all([
      db.collection("device_access").find({ deviceId }).sort({ createdAt: 1 }).toArray(),
      db.collection("device_invites").find({ deviceId, status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray(),
    ]);
    const ownerId = ownerOf(a.config);
    const people = await usersById(db, [ownerId, ...shares.map((s) => s.userId), ...invites.map((i) => i.invitedBy)]);

    return res.json({
      ok: true,
      deviceId,
      yourRole: a.role,
      owner: people.get(ownerId) || { userId: ownerId },
      members: shares.map((s) => ({ ...(people.get(s.userId) || { userId: s.userId }), role: s.role, since: s.createdAt })),
      invites: invites.map((i) => ({
        id: i._id,
        email: i.email,
        role: i.role,
        invitedBy: people.get(i.invitedBy)?.name || null,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
      })),
    });
  } catch (e) {
    return sendServerError(res, e, "list members");
  }
}

// POST /api/devices/:deviceId/invites  { email, role }   (manager+, verified email)
async function createInvite(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const a = await requireDeviceRole(db, deviceId, req.user.id, "manager");
    if (a.error) return denied(res, a);

    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = req.body?.role;
    if (!EMAIL_RE.test(email) || email.length > 254) return bad(res, "Invalid email address");
    if (!SHARE_ROLES.includes(role)) return bad(res, `'role' must be one of: ${SHARE_ROLES.join(", ")}`);
    if (!canManageRole(a.role, role)) return bad(res, `As ${a.role} you can't invite a ${role}`, 403);
    if (email === req.user.email) return bad(res, "You can't invite yourself");

    const invitee = await db.collection("users").findOne({ email }, { projection: { _id: 1 } });
    if (invitee) {
      const uid = String(invitee._id);
      if (uid === ownerOf(a.config)) return bad(res, "That person owns this device", 409);
      if (await db.collection("device_access").findOne({ deviceId, userId: uid })) {
        return bad(res, "That person already has access. Change their role instead.", 409);
      }
    }

    const invites = db.collection("device_invites");
    const now = new Date();
    const [members, pending, sentToday] = await Promise.all([
      db.collection("device_access").countDocuments({ deviceId }),
      invites.countDocuments({ deviceId, status: "pending", expiresAt: { $gt: now }, email: { $ne: email } }),
      invites.countDocuments({ invitedBy: req.user.id, createdAt: { $gte: new Date(now - 24 * 3600e3) } }),
    ]);
    if (members + pending >= MAX_MEMBERS) return bad(res, `A device can be shared with at most ${MAX_MEMBERS} people`);
    if (sentToday >= MAX_INVITES_PER_DAY) return bad(res, `You can send at most ${MAX_INVITES_PER_DAY} invitations a day`, 429);
    const b = await budget(db);
    if (b.remaining <= 0) return bad(res, "Email sending is paused for today (daily limit reached). Try again tomorrow.", 503);

    // A new invite to the same address replaces the old one (acts as "resend")
    await invites.updateMany({ deviceId, email, status: "pending" }, { $set: { status: "revoked", revokedReason: "replaced" } });

    const { raw, hash } = newInviteToken();
    const doc = { deviceId, email, role, invitedBy: req.user.id, tokenHash: hash, status: "pending", createdAt: now, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) };
    const { insertedId } = await invites.insertOne(doc);

    const [inviter, ui] = await Promise.all([
      db.collection("users").findOne({ _id: new ObjectId(req.user.id) }, { projection: { name: 1 } }),
      db.collection("device_ui").findOne({ _id: deviceId }, { projection: { displayName: 1 } }),
    ]);
    await enqueueEmail(db, {
      to: email,
      template: "deviceInvite",
      data: { inviterName: inviter?.name || "A ThingsString user", deviceName: ui?.displayName || deviceId, role, token: raw, accountExists: !!invitee },
      category: "invite",
      userId: req.user.id,
    });
    await logActivity(db, { deviceId, actor: actorFromReq(req), action: "share.invite", details: { email, role } });

    return res.status(201).json({ ok: true, invite: { id: insertedId, email, role, status: "pending", expiresAt: doc.expiresAt } });
  } catch (e) {
    return sendServerError(res, e, "create invite");
  }
}

// DELETE /api/devices/:deviceId/invites/:inviteId   (manager+)
async function cancelInvite(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const a = await requireDeviceRole(db, deviceId, req.user.id, "manager");
    if (a.error) return denied(res, a);
    const _id = parseObjectId(req.params.inviteId);
    if (!_id) return bad(res, "Invalid invite id");

    const invite = await db.collection("device_invites").findOne({ _id, deviceId, status: "pending" });
    if (!invite) return bad(res, "Invitation not found", 404);
    if (!canManageRole(a.role, invite.role)) return bad(res, `As ${a.role} you can't cancel a ${invite.role} invitation`, 403);

    await db.collection("device_invites").updateOne({ _id }, { $set: { status: "revoked", revokedReason: "cancelled", revokedBy: req.user.id } });
    await logActivity(db, { deviceId, actor: actorFromReq(req), action: "share.invite.cancel", details: { email: invite.email, role: invite.role } });
    return res.json({ ok: true });
  } catch (e) {
    return sendServerError(res, e, "cancel invite");
  }
}

// PATCH /api/devices/:deviceId/members/:userId  { role }
async function changeMemberRole(req, res) {
  try {
    const db = getDb();
    const { deviceId, userId } = req.params;
    const a = await requireDeviceRole(db, deviceId, req.user.id, "manager");
    if (a.error) return denied(res, a);
    const role = req.body?.role;
    if (!SHARE_ROLES.includes(role)) return bad(res, `'role' must be one of: ${SHARE_ROLES.join(", ")}`);

    const share = await db.collection("device_access").findOne({ deviceId, userId: String(userId) });
    if (!share) return bad(res, "Member not found", 404);
    if (userId === req.user.id) return bad(res, "You can't change your own role", 403);
    if (!canManageRole(a.role, share.role) || !canManageRole(a.role, role)) {
      return bad(res, `As ${a.role} you can't change a ${share.role} to ${role}`, 403);
    }

    await db.collection("device_access").updateOne({ _id: share._id }, { $set: { role, updatedAt: new Date() } });
    // Lower than manager: their schedules and automation rules on this device stop
    if (role !== "manager" && share.role === "manager") {
      const now = new Date();
      await db.collection("device_schedules").updateMany({ user_id: share.userId, deviceId, enabled: true }, { $set: { enabled: false, disabledReason: "role changed", updatedAt: now } });
      await db.collection("automation_flows").updateMany(
        { user_id: share.userId, enabled: true, "action.deviceId": deviceId },
        { $set: { enabled: false, disabledReason: "role changed", updatedAt: now } }
      );
    }
    await logActivity(db, { deviceId, actor: actorFromReq(req), action: "share.role", details: { userId: share.userId, from: share.role, to: role } });
    return res.json({ ok: true, userId: share.userId, role });
  } catch (e) {
    return sendServerError(res, e, "change member role");
  }
}

// DELETE /api/devices/:deviceId/members/:userId   (remove someone, or yourself = leave)
async function removeMember(req, res) {
  try {
    const db = getDb();
    const { deviceId, userId } = req.params;
    const leaving = userId === req.user.id;
    const a = await requireDeviceRole(db, deviceId, req.user.id, leaving ? "viewer" : "manager");
    if (a.error) return denied(res, a);
    if (leaving && a.role === "owner") return bad(res, "The owner can't leave their own device");

    const share = await db.collection("device_access").findOne({ deviceId, userId: String(userId) });
    if (!share) return bad(res, "Member not found", 404);
    if (!leaving && !canManageRole(a.role, share.role)) return bad(res, `As ${a.role} you can't remove a ${share.role}`, 403);

    await cleanupUserDeviceAccess(db, share.userId, [deviceId], leaving ? "left the device" : "access removed");
    await logActivity(db, {
      deviceId,
      actor: actorFromReq(req),
      action: leaving ? "share.leave" : "share.remove",
      details: { userId: share.userId, role: share.role },
    });
    return res.json({ ok: true });
  } catch (e) {
    return sendServerError(res, e, "remove member");
  }
}

/* ───────────────────────────── Invites (invitee side) ───────────────────────────── */

// POST /api/invites/lookup  { token }   (no login: the invite page shows this before sign-in)
async function lookupInvite(req, res) {
  try {
    const invite = await findInviteByToken(getDb(), req.body?.token);
    if (!invite) return bad(res, "This invitation is invalid or has expired");
    return res.json({ ok: true, invite: await describeInvite(getDb(), invite) });
  } catch (e) {
    return sendServerError(res, e, "lookup invite");
  }
}

async function loadMe(db, userId) {
  return db.collection("users").findOne({ _id: new ObjectId(userId) }, { projection: { email: 1, emailVerified: 1 } });
}

// POST /api/invites/accept  { token }   — from the email link. Opening it proves the inbox,
// so the account's email also becomes verified.
async function acceptInviteByToken(req, res) {
  try {
    const db = getDb();
    const invite = await findInviteByToken(db, req.body?.token);
    if (!invite) return bad(res, "This invitation is invalid or has expired");
    const me = await loadMe(db, req.user.id);
    const r = await acceptInvite(db, invite, me);
    if (r.error) return bad(res, r.error, r.status);
    if (!me.emailVerified) await db.collection("users").updateOne({ _id: me._id }, { $set: { emailVerified: true } });
    return res.json({ ok: true, deviceId: r.deviceId, role: r.role });
  } catch (e) {
    return sendServerError(res, e, "accept invite");
  }
}

// GET /api/invites — invitations waiting for me (by my verified email)
async function myInvites(req, res) {
  try {
    const db = getDb();
    if (!req.user.emailVerified) return res.json({ ok: true, count: 0, invites: [], note: "Verify your email to see invitations" });
    const list = await db
      .collection("device_invites")
      .find({ email: req.user.email, status: "pending", expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .toArray();
    const invites = await Promise.all(list.map(async (i) => ({ id: i._id, ...(await describeInvite(db, i)) })));
    return res.json({ ok: true, count: invites.length, invites });
  } catch (e) {
    return sendServerError(res, e, "my invites");
  }
}

// POST /api/invites/:inviteId/accept  — in the app. Needs a verified email (otherwise anyone
// who registered with someone else's address could take their invitation).
async function acceptInviteById(req, res) {
  try {
    const db = getDb();
    if (!req.user.emailVerified) return bad(res, "Verify your email first, or use the link in the invitation email", 403, { code: "EMAIL_NOT_VERIFIED" });
    const _id = parseObjectId(req.params.inviteId);
    if (!_id) return bad(res, "Invalid invite id");
    const invite = await db.collection("device_invites").findOne({ _id, email: req.user.email, status: "pending" });
    if (!invite) return bad(res, "Invitation not found", 404);
    const r = await acceptInvite(db, invite, await loadMe(db, req.user.id));
    if (r.error) return bad(res, r.error, r.status);
    return res.json({ ok: true, deviceId: r.deviceId, role: r.role });
  } catch (e) {
    return sendServerError(res, e, "accept invite");
  }
}

// POST /api/invites/:inviteId/decline
async function declineInvite(req, res) {
  try {
    const db = getDb();
    const _id = parseObjectId(req.params.inviteId);
    if (!_id) return bad(res, "Invalid invite id");
    const r = await db
      .collection("device_invites")
      .findOneAndUpdate({ _id, email: req.user.email, status: "pending" }, { $set: { status: "declined", declinedAt: new Date() } });
    if (!r) return bad(res, "Invitation not found", 404);
    await logActivity(db, { deviceId: r.deviceId, actor: actorFromReq(req), action: "share.decline", details: { role: r.role } });
    return res.json({ ok: true });
  } catch (e) {
    return sendServerError(res, e, "decline invite");
  }
}

/* ───────────────────────────── Per-device alert settings ───────────────────────────── */

// GET /api/devices/:deviceId/alerts   (anyone with access: settings are personal)
async function getAlerts(req, res) {
  try {
    const db = getDb();
    const a = await requireDeviceRole(db, req.params.deviceId, req.user.id, "viewer");
    if (a.error) return denied(res, a);
    const doc = await db.collection("device_alerts").findOne({ _id: alertId(req.user.id, req.params.deviceId) });
    return res.json({ ok: true, deviceId: req.params.deviceId, alerts: serializeAlertSettings(doc) });
  } catch (e) {
    return sendServerError(res, e, "get alerts");
  }
}

// PUT /api/devices/:deviceId/alerts  { offline: { enabled, afterMin } }
async function updateAlerts(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const a = await requireDeviceRole(db, deviceId, req.user.id, "viewer");
    if (a.error) return denied(res, a);

    const off = req.body?.offline;
    if (!isPlainObject(off)) return bad(res, "Body must be { offline: { enabled, afterMin } }");
    const current = serializeAlertSettings(await db.collection("device_alerts").findOne({ _id: alertId(req.user.id, deviceId) }));
    const enabled = off.enabled === undefined ? current.offline.enabled : off.enabled;
    const afterMin = off.afterMin === undefined ? current.offline.afterMin : off.afterMin;
    if (typeof enabled !== "boolean") return bad(res, "'offline.enabled' must be true or false");
    if (!Number.isInteger(afterMin) || afterMin < MIN_AFTER_MIN || afterMin > MAX_AFTER_MIN) {
      return bad(res, `'offline.afterMin' must be a whole number of minutes, ${MIN_AFTER_MIN}-${MAX_AFTER_MIN}`);
    }

    const alerts = await saveAlertSettings(db, { userId: req.user.id, deviceId, offline: { enabled, afterMin } });
    return res.json({ ok: true, deviceId, alerts });
  } catch (e) {
    return sendServerError(res, e, "update alerts");
  }
}

/* ───────────────────────────── Activity log ───────────────────────────── */

// GET /api/devices/:deviceId/activity?limit=50&before=<ISO>&action=control   (manager+)
async function getActivity(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const a = await requireDeviceRole(db, deviceId, req.user.id, "manager");
    if (a.error) return denied(res, a);

    const limit = clampInt(req.query.limit, { min: 1, max: 200, fallback: 50 });
    const filter = { deviceId };
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (Number.isNaN(before.getTime())) return bad(res, "Invalid 'before' date");
      filter.ts = { $lt: before };
    }
    if (typeof req.query.action === "string" && /^[a-z.]{1,40}$/.test(req.query.action)) {
      filter.action = { $regex: `^${req.query.action.replace(/\./g, "\\.")}` };
    }

    const items = await db.collection("device_activity").find(filter).sort({ ts: -1 }).limit(limit).toArray();
    const people = await usersById(db, items.filter((i) => i.actor?.type === "user" || i.actor?.type === "admin").map((i) => i.actor.id));
    return res.json({
      ok: true,
      deviceId,
      count: items.length,
      activity: items.map((i) => ({
        id: i._id,
        ts: i.ts,
        action: i.action,
        actor: i.actor?.id && people.has(i.actor.id) ? { ...i.actor, name: people.get(i.actor.id).name } : i.actor,
        details: i.details,
      })),
      nextBefore: items.length === limit ? items[items.length - 1].ts : null,
    });
  } catch (e) {
    return sendServerError(res, e, "device activity");
  }
}

module.exports = {
  listMembers,
  createInvite,
  cancelInvite,
  changeMemberRole,
  removeMember,
  lookupInvite,
  acceptInviteByToken,
  myInvites,
  acceptInviteById,
  declineInvite,
  getAlerts,
  updateAlerts,
  getActivity,
};
