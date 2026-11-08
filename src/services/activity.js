// src/services/activity.js
// Per-device activity history: who did what, when. Kept ACTIVITY_TTL_DAYS (default 90)
// and then removed automatically, to stay inside free-tier database storage.
//
// actor: { type: "user", id, email } | { type: "automation", id, name } |
//        { type: "schedule", id, name } | { type: "admin", id, email }

const ACTIVITY_TTL_DAYS = Math.max(1, parseInt(process.env.ACTIVITY_TTL_DAYS || "90", 10) || 90);
const MAX_DETAILS_BYTES = 4096;

function actorFromReq(req, type = "user") {
  return { type, id: req.user?.id || null, email: req.user?.email || null };
}

/** Record one action. Never throws: history must not break the action itself. */
async function logActivity(db, { deviceId, actor, action, details }) {
  try {
    let d = details ?? null;
    if (d && JSON.stringify(d).length > MAX_DETAILS_BYTES) d = { truncated: true };
    await db.collection("device_activity").insertOne({ deviceId, actor, action, details: d, ts: new Date() });
  } catch (e) {
    console.error(`⚠️ Activity log failed (${action} on ${deviceId}):`, e.message);
  }
}

module.exports = { logActivity, actorFromReq, ACTIVITY_TTL_DAYS };
