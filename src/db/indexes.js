// src/db/indexes.js
// Idempotent index setup, run at API startup. createIndex is a no-op when an
// identical index already exists. Atlas builds new indexes without blocking.

const TELEMETRY_TTL_DAYS = 7;
const AUTOMATION_LOG_TTL_DAYS = 30;
const { ACTIVITY_TTL_DAYS } = require("../services/activity");

/**
 * Create a TTL index, or adjust its expiry in place (collMod) when it already
 * exists with a different value. Plain createIndex would fail with
 * IndexOptionsConflict in that case.
 */
async function ensureTtlIndex(db, collection, field, expireAfterSeconds, { adjust = true } = {}) {
  const col = db.collection(collection);
  const existing = (await col.indexes().catch(() => [])).find(
    (i) => JSON.stringify(i.key) === JSON.stringify({ [field]: 1 })
  );

  if (existing && existing.expireAfterSeconds === expireAfterSeconds) return;

  if (existing && existing.expireAfterSeconds !== undefined) {
    if (!adjust) return; // keep a retention an admin chose via clean-telemetry
    await db.command({ collMod: collection, index: { keyPattern: { [field]: 1 }, expireAfterSeconds } });
    console.log(`⚡ TTL on ${collection}.${field} changed to ${expireAfterSeconds}s`);
    return;
  }

  if (existing) {
    // A plain (non-TTL) index on the same key exists; leave it rather than drop it.
    console.warn(`⚠️ ${collection}.${field} has a non-TTL index; TTL not applied`);
    return;
  }

  await col.createIndex({ [field]: 1 }, { expireAfterSeconds });
  console.log(`⚡ TTL index created on ${collection}.${field} (${expireAfterSeconds}s)`);
}

async function ensureIndexes(db) {
  // Data migrations that must run before the indexes they rely on
  try {
    await require("../services/deviceUi").migrateDeviceUiKeys(db);
  } catch (e) {
    console.error("⚠️ device_ui migration failed:", e.message);
  }

  const tasks = [
    // Latest telemetry per device (used everywhere) + 7-day retention
    db.collection("device_telemetry").createIndex({ deviceId: 1, _id: -1 }),
    // Time-range history queries (graphs)
    db.collection("device_telemetry").createIndex({ deviceId: 1, createdAt: 1 }),
    ensureTtlIndex(db, "device_telemetry", "createdAt", TELEMETRY_TTL_DAYS * 86400, { adjust: false }),

    // Device ownership lookups
    db.collection("device_config").createIndex({ "device.user_id": 1 }),

    // Automation
    db.collection("automation_flows").createIndex({ user_id: 1 }),
    db.collection("automation_flows").createIndex({ enabled: 1 }),
    db.collection("automation_flow_state").createIndex({ flowId: 1 }),
    db.collection("automation_flow_logs").createIndex({ flowId: 1, ts: -1 }),
    db.collection("automation_flow_logs").createIndex({ deviceId: 1, ts: -1 }),
    ensureTtlIndex(db, "automation_flow_logs", "ts", AUTOMATION_LOG_TTL_DAYS * 86400),

    // Schedules
    db.collection("device_schedules").createIndex({ deviceId: 1, user_id: 1 }),
    db.collection("device_schedules").createIndex({ enabled: 1 }),

    // Personalisation
    db.collection("device_ui").createIndex({ user_id: 1, deviceId: 1 }),
    db.collection("device_ui").createIndex({ deviceId: 1 }),
    db.collection("device_groups").createIndex({ user_id: 1, order: 1 }),
    db.collection("device_groups").createIndex({ deviceIds: 1 }),
    db.collection("files").createIndex({ user_id: 1, kind: 1 }),

    // Email: one-time tokens expire on their own; the outbox keeps 30 days of history
    ensureTtlIndex(db, "email_tokens", "expiresAt", 0),
    db.collection("email_tokens").createIndex({ userId: 1, purpose: 1 }),
    db.collection("email_outbox").createIndex({ status: 1, nextAttemptAt: 1 }),
    db.collection("email_outbox").createIndex({ dedupeKey: 1, createdAt: -1 }, { sparse: true }),
    db.collection("email_outbox").createIndex({ userId: 1, createdAt: -1 }),
    ensureTtlIndex(db, "email_outbox", "createdAt", 30 * 86400),

    // Sharing, invitations, alert settings, activity history
    db.collection("device_access").createIndex({ deviceId: 1, userId: 1 }, { unique: true }),
    db.collection("device_access").createIndex({ userId: 1 }),
    db.collection("device_invites").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("device_invites").createIndex({ deviceId: 1, status: 1 }),
    db.collection("device_invites").createIndex({ email: 1, status: 1 }),
    db.collection("device_invites").createIndex({ invitedBy: 1, createdAt: -1 }),
    ensureTtlIndex(db, "device_invites", "expiresAt", 30 * 86400),
    db.collection("device_alerts").createIndex({ "offline.enabled": 1 }),
    db.collection("device_alerts").createIndex({ deviceId: 1 }),
    db.collection("device_activity").createIndex({ deviceId: 1, ts: -1 }),
    ensureTtlIndex(db, "device_activity", "ts", ACTIVITY_TTL_DAYS * 86400),
    db.collection("email_outbox").createIndex({ status: 1, sentAt: -1 }),

    // Admin audit trail (kept forever)
    db.collection("admin_audit_logs").createIndex({ timestamp: -1 }),
  ];

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.error("⚠️ Index setup failed:", r.reason?.message);
  }
  console.log("🗂️ Database indexes ensured");
}

module.exports = { ensureIndexes, ensureTtlIndex, TELEMETRY_TTL_DAYS };
