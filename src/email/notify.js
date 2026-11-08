// src/email/notify.js
// Send a notification email to a user, respecting their settings.
//
// Categories:
//   deviceOffline, automation   optional: the user can turn them off (settings or the
//                               unsubscribe link), capped at MAX_ALERTS_PER_HOUR
//   account                     admin actions on the user's account/devices: always sent
//   security                    password/email changes: always sent (sent directly elsewhere)

const crypto = require("node:crypto");
const { ObjectId } = require("mongoose").mongo;
const { enqueueEmail } = require("./outbox");
const { budget } = require("./budget");

const OPTIONAL = ["deviceOffline", "automation", "weeklyReport"];
const ALWAYS = ["account", "security"];
const DEFAULT_NOTIFICATIONS = Object.freeze({ deviceOffline: true, automation: true, weeklyReport: true });
const MAX_ALERTS_PER_HOUR = 20;

function notificationsOf(user) {
  const n = user?.notifications || {};
  const out = {};
  for (const k of OPTIONAL) out[k] = typeof n[k] === "boolean" ? n[k] : DEFAULT_NOTIFICATIONS[k];
  return out;
}

/* ───────── Unsubscribe links: stateless, signed with a key derived from JWT_SECRET ───────── */

function unsubKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return crypto.createHash("sha256").update(`unsubscribe:${secret}`).digest();
}

/** `deviceId` scopes the link to one device's alerts (offline alerts are per device). */
function unsubscribeToken(userId, category, deviceId = null) {
  const body = Buffer.from(JSON.stringify(deviceId ? { u: String(userId), c: category, d: deviceId } : { u: String(userId), c: category })).toString(
    "base64url"
  );
  const sig = crypto.createHmac("sha256", unsubKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Returns { userId, category, deviceId } or null. */
function verifyUnsubscribeToken(token) {
  if (typeof token !== "string" || token.length > 600) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", unsubKey()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  if (!p || !ObjectId.isValid(p.u) || !OPTIONAL.includes(p.c)) return null;
  if (p.d !== undefined && (typeof p.d !== "string" || !p.d)) return null;
  return { userId: p.u, category: p.c, deviceId: p.d || null };
}

function appUrl(p) {
  return `${(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "")}${p}`;
}

/**
 * Queue a notification for a user. Never throws: a failed notification must not
 * break the automation/watchdog/admin action that triggered it.
 * Returns { queued, reason? }.
 */
async function notifyUser(db, { userId, category, deviceId = null, template, data = {}, dedupeKey, dedupeWindowMs, attachments = null }) {
  try {
    if (!OPTIONAL.includes(category) && !ALWAYS.includes(category)) throw new Error(`Unknown category '${category}'`);
    if (!userId || !ObjectId.isValid(String(userId))) return { queued: false, reason: "no user" };

    const user = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(String(userId)) },
        { projection: { email: 1, name: 1, isActive: 1, status: 1, notifications: 1, "preferences.timezone": 1 } }
      );
    if (!user || !user.email) return { queued: false, reason: "no user" };
    if (user.isActive === false || user.status === "disabled") return { queued: false, reason: "suspended" };

    const optional = OPTIONAL.includes(category);
    let headers;
    let unsubscribeUrl = null;
    if (optional) {
      if (!notificationsOf(user)[category]) return { queued: false, reason: "turned off" };

      const recent = await db.collection("email_outbox").countDocuments({
        userId: String(user._id),
        category: { $in: OPTIONAL },
        createdAt: { $gte: new Date(Date.now() - 3600e3) },
      });
      if (recent >= MAX_ALERTS_PER_HOUR) {
        console.warn(`📧 Alert cap reached for user ${user._id}; '${template}' not sent`);
        return { queued: false, reason: "hourly cap" };
      }
      // Free-tier protection: alerts may only use the part of the daily quota not reserved
      // for sign-up, password and invitation emails
      if (!(await budget(db)).alertsAllowed) {
        console.warn(`📧 Daily email budget for alerts used up; '${template}' not sent`);
        return { queued: false, reason: "daily budget" };
      }

      unsubscribeUrl = appUrl(`/unsubscribe?token=${unsubscribeToken(String(user._id), category, deviceId)}`);
      headers = { "List-Unsubscribe": `<${unsubscribeUrl}>` };
    }

    const r = await enqueueEmail(db, {
      to: user.email,
      template,
      data: { ...data, name: user.name, timezone: user.preferences?.timezone || null, unsubscribeUrl },
      dedupeKey,
      dedupeWindowMs,
      category,
      userId: String(user._id),
      headers,
      attachments,
    });
    return { queued: r.queued, reason: r.queued ? undefined : "duplicate" };
  } catch (e) {
    console.error(`❌ Notification '${template}' for user ${userId} failed:`, e.message);
    return { queued: false, reason: "error" };
  }
}

/**
 * How the device looks in the app (same for everyone it's shared with):
 * { name, device: { deviceId, name, icon, color } } for emails.
 */
async function deviceDisplayName(db, deviceId) {
  const ui = await db.collection("device_ui").findOne({ _id: deviceId }, { projection: { displayName: 1, icon: 1, color: 1 } });
  const name = ui?.displayName || deviceId;
  return { name, device: { deviceId, name, icon: ui?.icon || null, color: ui?.color || null } };
}

module.exports = {
  notifyUser,
  notificationsOf,
  unsubscribeToken,
  verifyUnsubscribeToken,
  deviceDisplayName,
  OPTIONAL_CATEGORIES: OPTIONAL,
  MAX_ALERTS_PER_HOUR,
};
