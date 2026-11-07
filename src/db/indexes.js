// src/db/indexes.js
// Idempotent index setup, run at API startup. createIndex is a no-op when an
// identical index already exists. Atlas builds new indexes without blocking.

const TELEMETRY_TTL_DAYS = 7;
const AUTOMATION_LOG_TTL_DAYS = 30;

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
  const tasks = [
    // Latest telemetry per device (used everywhere) + 7-day retention
    db.collection("device_telemetry").createIndex({ deviceId: 1, _id: -1 }),
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
