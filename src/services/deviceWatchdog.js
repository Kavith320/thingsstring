// src/services/deviceWatchdog.js
// Per-device offline alerts. Every member of a device can turn them on for themselves
// (off by default) and choose after how many minutes without data to be told.
// Settings + per-user alert state live in `device_alerts`, _id "<userId>:<deviceId>".
// Runs in the scheduler worker once a minute; only devices someone subscribed to are checked.
//
// Spam / email-budget rules:
//  - One "offline" email per outage, one "back online" email only if "offline" was sent.
//  - At most one offline email per device per user per 30 minutes (flapping Wi-Fi).
//  - Turning alerts on while the device is already offline doesn't send an alert for that outage.
//  - If every recently active device is silent at once, the platform (API/MQTT/broker) is down,
//    not the devices: nothing is sent until data flows again.
//  - Locked devices and suspended users get nothing; notifyUser applies the user's
//    master switch, the hourly cap and the daily email budget.

const { notifyUser, deviceDisplayName } = require("../email/notify");

const FLAP_WINDOW_MS = 30 * 60e3;
const ACTIVE_WINDOW_MS = 24 * 3600e3;
const PLATFORM_SILENT_MS = 5 * 60e3;
const DEFAULT_AFTER_MIN = 10;
const MIN_AFTER_MIN = 2;
const MAX_AFTER_MIN = 24 * 60;

const alertId = (userId, deviceId) => `${userId}:${deviceId}`;

function lastSeenMs(doc) {
  if (!doc) return null;
  if (doc.createdAt) {
    const t = new Date(doc.createdAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return doc._id?.getTimestamp ? doc._id.getTimestamp().getTime() : null;
}

async function latestSeen(db, deviceId) {
  const last = await db
    .collection("device_telemetry")
    .findOne({ deviceId }, { sort: { _id: -1 }, projection: { _id: 1, createdAt: 1 } });
  return lastSeenMs(last);
}

/**
 * Is the platform itself not receiving data? True when at least 2 devices were active in the
 * last 24 h and none of them has reported in the last 5 minutes.
 */
async function platformSilent(db, now) {
  const newest = await db
    .collection("device_telemetry")
    .find({ createdAt: { $gte: new Date(now - ACTIVE_WINDOW_MS) } }, { projection: { deviceId: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  if (!newest) return false; // nothing at all in 24h: nothing to compare against
  if (now - new Date(newest.createdAt).getTime() <= PLATFORM_SILENT_MS) return false; // data is flowing
  const active = await db.collection("device_telemetry").distinct("deviceId", { createdAt: { $gte: new Date(now - ACTIVE_WINDOW_MS) } });
  return active.length >= 2;
}

/** Default settings returned for a device the user never configured. */
function defaultAlertSettings() {
  return { offline: { enabled: false, afterMin: DEFAULT_AFTER_MIN } };
}

function serializeAlertSettings(doc) {
  return {
    offline: {
      enabled: doc?.offline?.enabled === true,
      afterMin: doc?.offline?.afterMin || DEFAULT_AFTER_MIN,
    },
    updatedAt: doc?.updatedAt || null,
  };
}

/** One pass. Returns a summary (for logs and tests). */
async function checkDevices(db, { now = Date.now() } = {}) {
  const summary = { checked: 0, offlineAlerts: 0, onlineAlerts: 0, platformSilent: false };
  const subs = await db.collection("device_alerts").find({ "offline.enabled": true }).toArray();
  if (!subs.length) return summary;

  const deviceIds = [...new Set(subs.map((s) => s.deviceId))];
  const configs = new Map(
    (await db.collection("device_config").find({ _id: { $in: deviceIds } }, { projection: { isDisabled: 1 } }).toArray()).map((c) => [c._id, c])
  );
  const seen = new Map(await Promise.all(deviceIds.map(async (id) => [id, await latestSeen(db, id)])));
  summary.checked = deviceIds.length;
  summary.platformSilent = await platformSilent(db, now);
  if (summary.platformSilent) console.warn("⚠️ [WATCHDOG] No device has reported for 5+ minutes: platform outage? Offline alerts paused.");

  const col = db.collection("device_alerts");
  const nowDate = new Date(now);

  for (const sub of subs) {
    const cfg = configs.get(sub.deviceId);
    const lastSeen = seen.get(sub.deviceId);
    if (!cfg || cfg.isDisabled || lastSeen === null) continue;

    const afterMs = (sub.offline.afterMin || DEFAULT_AFTER_MIN) * 60e3;
    const offline = now - lastSeen > afterMs;

    if (offline && !sub.state) {
      if (summary.platformSilent) continue; // decide again once data flows
      let state = "suppressed";
      const set = {};
      const recently = sub.lastOfflineAlertAt && now - new Date(sub.lastOfflineAlertAt).getTime() < FLAP_WINDOW_MS;
      if (!recently) {
        const { name } = await deviceDisplayName(db, sub.deviceId, sub.userId);
        const r = await notifyUser(db, {
          userId: sub.userId,
          category: "deviceOffline",
          deviceId: sub.deviceId,
          template: "deviceOffline",
          data: { deviceId: sub.deviceId, deviceName: name, lastSeen: new Date(lastSeen), afterMin: sub.offline.afterMin },
          dedupeKey: `offline:${sub._id}`,
          dedupeWindowMs: FLAP_WINDOW_MS,
        });
        if (r.queued) {
          state = "alerted";
          set.lastOfflineAlertAt = nowDate;
          summary.offlineAlerts++;
        }
      }
      await col.updateOne({ _id: sub._id }, { $set: { state, stateSince: nowDate, ...set } });
    } else if (!offline && sub.state) {
      if (sub.state === "alerted") {
        const { name } = await deviceDisplayName(db, sub.deviceId, sub.userId);
        const r = await notifyUser(db, {
          userId: sub.userId,
          category: "deviceOffline",
          deviceId: sub.deviceId,
          template: "deviceOnline",
          data: { deviceId: sub.deviceId, deviceName: name, offlineSince: sub.stateSince },
          dedupeKey: `online:${sub._id}:${new Date(sub.stateSince).getTime()}`,
        });
        if (r.queued) summary.onlineAlerts++;
      }
      await col.updateOne({ _id: sub._id }, { $set: { state: null, stateSince: nowDate } });
    }
  }
  return summary;
}

/**
 * Save a user's alert settings for a device. Turning alerts on while the device is
 * already offline marks that outage as handled, so no alert is sent for it.
 */
async function saveAlertSettings(db, { userId, deviceId, offline }) {
  const col = db.collection("device_alerts");
  const _id = alertId(userId, deviceId);
  const prev = await col.findOne({ _id });
  const next = { enabled: offline.enabled, afterMin: offline.afterMin };
  const set = { userId: String(userId), deviceId, offline: next, updatedAt: new Date() };

  const turningOn = next.enabled && !prev?.offline?.enabled;
  if (turningOn) {
    const seen = await latestSeen(db, deviceId);
    const isOffline = seen !== null && Date.now() - seen > next.afterMin * 60e3;
    set.state = isOffline ? "suppressed" : null;
    set.stateSince = new Date();
  }
  if (!next.enabled) set.state = null;

  await col.updateOne({ _id }, { $set: set }, { upsert: true });
  return serializeAlertSettings(await col.findOne({ _id }));
}

/** Run checkDevices every `intervalMs`, never overlapping. Returns a stop function. */
function startWatchdog(db, { intervalMs = 60e3 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await checkDevices(db);
      if (s.offlineAlerts || s.onlineAlerts) {
        console.log(`🐶 [WATCHDOG] ${s.offlineAlerts} offline / ${s.onlineAlerts} back-online alert(s) queued`);
      }
    } catch (e) {
      console.error("❌ [WATCHDOG] check failed:", e.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}

module.exports = {
  checkDevices,
  startWatchdog,
  saveAlertSettings,
  serializeAlertSettings,
  defaultAlertSettings,
  alertId,
  DEFAULT_AFTER_MIN,
  MIN_AFTER_MIN,
  MAX_AFTER_MIN,
};
