// src/services/weeklyReport.js
// Weekly report, sent just before the weekly backup: every user gets one email with an
// Excel workbook of the devices they own or that are shared with them:
//   "Summary" sheet  one row per device
//   one sheet per device: the week's activity (who did what) and daily reading stats
// Users can turn it off (Settings, or the email's unsubscribe link).

const moment = require("moment-timezone");
const { ObjectId } = require("mongoose").mongo;
const { accessibleDevices, atLeast } = require("./deviceAccess");
const { notifyUser, notificationsOf, deviceDisplayName } = require("../email/notify");
const { buildXlsx } = require("../utils/xlsx");

const WEEK_MS = 7 * 24 * 3600e3;
const MAX_ACTIVITY_ROWS = 5000; // per device, keeps the attachment small

const ROLE_LABEL = { owner: "Owner", manager: "Manager", operator: "Operator", viewer: "Viewer" };

/** A UTC Date whose wall-clock equals `date` in `tz` (Excel has no time zones). */
function wall(date, tz) {
  return new Date(`${moment(date).tz(tz).format("YYYY-MM-DDTHH:mm:ss")}Z`);
}

function describeActor(a, { showPeople, meId }) {
  const actor = a.actor || {};
  if (actor.type === "automation") return `Automation: ${actor.name || "rule"}`;
  if (actor.type === "schedule") return `Schedule: ${actor.name || "schedule"}`;
  if (actor.type === "admin") return "Administrator";
  if (actor.id && actor.id === meId) return "You";
  return showPeople ? actor.email || "A member" : "A member";
}

/** `showPeople`: managers/owners see who was invited; others see "someone". */
function describeAction(a, { showPeople = true } = {}) {
  const d = a.details || {};
  const who = (email) => (showPeople && email ? email : "someone");
  const acts = (o) =>
    Object.entries(o || {})
      .map(([k, v]) => `${k}: ${Object.entries(v || {}).map(([f, x]) => `${f}=${typeof x === "object" ? JSON.stringify(x) : x}`).join(", ")}`)
      .join("; ");
  switch (a.action) {
    case "control.update":
      if (d.actuators) return `Set ${acts(d.actuators)}${d.reading ? ` (reading ${Object.entries(d.reading).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`;
      if (d.set) return `${d.phase === "end" ? "Schedule end" : "Schedule start"}: ${Object.entries(d.set).map(([k, v]) => `${k.replace(/^actuators\./, "")}=${v}`).join(", ")}`;
      return "Changed controls";
    case "schedule.create": return `Created schedule "${d.name || ""}"`;
    case "schedule.update": return `Changed schedule "${d.name || ""}"`;
    case "schedule.delete": return `Deleted schedule "${d.name || ""}"`;
    case "automation.create": return `Created automation "${d.name || ""}"`;
    case "automation.update": return `Changed automation "${d.name || ""}"`;
    case "automation.delete": return `Deleted automation "${d.name || ""}"`;
    case "settings.update": return `Changed device settings (${(d.changed || []).join(", ")})`;
    case "share.invite": return `Invited ${who(d.email)} as ${d.role}`;
    case "share.accept": return `Joined as ${d.role}`;
    case "share.decline": return "Declined an invitation";
    case "share.role": return `Changed a member's role from ${d.from} to ${d.to}`;
    case "share.remove": return "Removed a member";
    case "share.leave": return "Left the device";
    case "share.invite.cancel": return `Cancelled the invitation for ${who(d.email)}`;
    case "telemetry.export": return "Downloaded data (CSV)";
    case "admin.lock": return `Locked by administrator${d.reason ? `: ${d.reason}` : ""}`;
    case "admin.unlock": return "Unlocked by administrator";
    default: return a.action;
  }
}

/** Daily min/avg/max of every top-level numeric field, days in the user's timezone. */
async function dailyStats(db, deviceId, from, to, tz) {
  return db
    .collection("device_telemetry")
    .aggregate(
      [
        { $match: { deviceId, createdAt: { $gte: from, $lt: to } } },
        {
          $project: {
            day: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: tz } },
            kv: {
              $filter: {
                input: { $objectToArray: "$$ROOT" },
                cond: { $and: [{ $isNumber: "$$this.v" }, { $not: [{ $in: ["$$this.k", ["_id", "deviceId", "createdAt"]] }] }] },
              },
            },
          },
        },
        { $unwind: "$kv" },
        { $group: { _id: { day: "$day", k: "$kv.k" }, n: { $sum: 1 }, min: { $min: "$kv.v" }, avg: { $avg: "$kv.v" }, max: { $max: "$kv.v" } } },
        { $sort: { "_id.day": 1, "_id.k": 1 } },
      ],
      { allowDiskUse: true }
    )
    .toArray();
}

const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);

/** Build one user's report. Returns null when they have no devices. */
async function buildUserReport(db, user, { now = new Date() } = {}) {
  const uid = String(user._id);
  const tz = user.preferences?.timezone && moment.tz.zone(user.preferences.timezone) ? user.preferences.timezone : "UTC";
  const to = now;
  const from = new Date(now.getTime() - WEEK_MS);

  const roles = await accessibleDevices(db, uid);
  if (!roles.size) return null;

  const devices = [];
  for (const [deviceId, role] of roles) {
    const [{ device }, activity, stats, readings, last] = await Promise.all([
      deviceDisplayName(db, deviceId),
      db.collection("device_activity").find({ deviceId, ts: { $gte: from, $lt: to } }).sort({ ts: 1 }).limit(MAX_ACTIVITY_ROWS + 1).toArray(),
      dailyStats(db, deviceId, from, to, tz),
      db.collection("device_telemetry").countDocuments({ deviceId, createdAt: { $gte: from, $lt: to } }),
      db.collection("device_telemetry").findOne({ deviceId }, { sort: { _id: -1 }, projection: { createdAt: 1 } }),
    ]);
    devices.push({ device, role, activity, stats, readings, lastSeen: last?.createdAt || null });
  }
  devices.sort((a, b) => a.device.name.localeCompare(b.device.name));

  // Workbook
  const period = `${moment(from).tz(tz).format("D MMM YYYY")} – ${moment(to).tz(tz).format("D MMM YYYY")} (${tz})`;
  const summary = {
    name: "Summary",
    headerRows: [3],
    widths: [28, 22, 12, 18, 18, 16],
    rows: [
      ["ThingsString weekly report"],
      [period],
      [],
      ["Device", "Device ID", "Your role", "Last data", "Readings this week", "Activity events"],
      ...devices.map((d) => [
        d.device.name,
        d.device.deviceId,
        ROLE_LABEL[d.role] || d.role,
        d.lastSeen ? wall(d.lastSeen, tz) : "Never",
        d.readings,
        Math.min(d.activity.length, MAX_ACTIVITY_ROWS),
      ]),
    ],
  };
  const deviceSheets = devices.map((d) => {
    const showPeople = atLeast(d.role, "manager"); // others see "A member" instead of emails
    const rows = [["Time", "Who", "What"]];
    for (const a of d.activity.slice(0, MAX_ACTIVITY_ROWS)) rows.push([wall(a.ts, tz), describeActor(a, { showPeople, meId: uid }), describeAction(a, { showPeople })]);
    if (d.activity.length > MAX_ACTIVITY_ROWS) rows.push(["", "", `… only the first ${MAX_ACTIVITY_ROWS} events are included`]);
    if (rows.length === 1) rows.push(["", "", "No activity this week"]);
    const statsHeader = rows.length + 1;
    rows.push([], ["Day", "Reading", "Readings", "Min", "Average", "Max"]);
    for (const s of d.stats) rows.push([s._id.day, s._id.k, s.n, round(s.min), round(s.avg), round(s.max)]);
    if (!d.stats.length) rows.push(["", "No readings this week"]);
    return { name: d.device.name, rows, widths: [18, 26, 60, 12, 12, 12], headerRows: [0, statsHeader] };
  });

  return { tz, from, to, period, devices, xlsx: buildXlsx([summary, ...deviceSheets]) };
}

/**
 * Queue the weekly report for every active user with at least one device.
 * Never throws per user; returns { users, queued, skipped, errors }.
 */
async function sendWeeklyReports(db, { now = new Date(), onlyUserId = null } = {}) {
  const filter = { isActive: { $ne: false }, status: { $ne: "disabled" } };
  if (onlyUserId) filter._id = new ObjectId(String(onlyUserId));
  const users = await db
    .collection("users")
    .find(filter, { projection: { name: 1, email: 1, notifications: 1, "preferences.timezone": 1 } })
    .toArray();

  const out = { users: users.length, queued: 0, skipped: 0, errors: 0 };
  const week = moment(now).utc().format("GGGG-[W]WW");
  for (const user of users) {
    try {
      if (!notificationsOf(user).weeklyReport) {
        out.skipped++;
        continue;
      }
      const report = await buildUserReport(db, user, { now });
      if (!report) {
        out.skipped++;
        continue;
      }
      const r = await notifyUser(db, {
        userId: user._id,
        category: "weeklyReport",
        template: "weeklyReport",
        data: {
          period: report.period,
          devices: report.devices.map((d) => ({
            ...d.device,
            role: ROLE_LABEL[d.role] || d.role,
            readings: d.readings,
            events: Math.min(d.activity.length, MAX_ACTIVITY_ROWS),
            lastSeen: d.lastSeen,
          })),
        },
        attachments: [
          {
            filename: `ThingsString-weekly-report-${moment(now).tz(report.tz).format("YYYY-MM-DD")}.xlsx`,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            content: report.xlsx,
          },
        ],
        dedupeKey: `weekly:${user._id}:${week}`,
        dedupeWindowMs: 6 * 24 * 3600e3,
      });
      if (r.queued) out.queued++;
      else out.skipped++;
    } catch (e) {
      out.errors++;
      console.error(`❌ Weekly report for user ${user._id} failed:`, e.message);
    }
  }
  return out;
}

/** Resolve within `ms` no matter what, so a slow report run never holds up the backup. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`⚠️ ${label} still running after ${Math.round(ms / 1000)}s; continuing without waiting`);
        resolve({ timedOut: true });
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { buildUserReport, sendWeeklyReports, withTimeout, describeAction };
