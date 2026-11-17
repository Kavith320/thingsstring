// src/services/wallHub.js
// Live wall displays over Server-Sent Events.
//
// One "room" per wall with at least one open screen. A room keeps the current values
// of its tiles, listens on the device bus and sends each screen only what changed:
//   event: snapshot  the whole wall (on connect, and after the owner edits it)
//   event: update    { values, devices, points, at }   changed tiles / device status
//   event: revoked   { reason }  the link was turned off or regenerated, the PIN changed,
//                                or the account was disabled; the screen must stop
// A comment line is sent every 20 s so proxies keep the connection open.
//
// The room re-reads the wall from the database every minute (and right after the owner
// saves it), which is when lost device access, a new PIN or a turned-off link is noticed.

const { deviceBus } = require("./deviceBus");
const { COLLECTION, buildSnapshot, sensorValue, actuatorValue, sessionMatches, ownerActive } = require("./wall");
const { offlineThresholdSec } = require("./deviceState");

const HEARTBEAT_MS = 20_000;
const RELOAD_MS = 60_000;
const STATUS_CHECK_MS = 10_000;
const MAX_STREAMS_PER_WALL = parseInt(process.env.WALL_MAX_SCREENS || "20", 10) || 20;
const MAX_STREAMS_PER_IP = parseInt(process.env.WALL_MAX_SCREENS_PER_IP || "10", 10) || 10;
const MAX_STREAMS_TOTAL = parseInt(process.env.WALL_MAX_STREAMS || "500", 10) || 500;

let getDbFn = () => require("../db/mongo").getDb();
const rooms = new Map(); // wallId -> Room
const perIp = new Map(); // ip -> open stream count
let total = 0;

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

class Room {
  constructor(wallId) {
    this.wallId = wallId;
    this.clients = new Set(); // { res, session, ip }
    this.wall = null;
    this.snapshot = null;
    this.values = {};
    this.devices = {};
    this.byDevice = new Map(); // deviceId -> [tile]
    this.loading = null;
    this.closed = false;
    this.timers = [];
  }

  start() {
    this.onTelemetry = (deviceId, doc) => this.telemetry(deviceId, doc);
    this.onControl = (deviceId, doc) => this.control(deviceId, doc);
    deviceBus.on("telemetry", this.onTelemetry);
    deviceBus.on("control", this.onControl);
    this.timers.push(setInterval(() => this.broadcastRaw(": ping\n\n"), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.reload().catch((e) => console.error("⚠️ wall reload failed:", e.message)), RELOAD_MS));
    this.timers.push(setInterval(() => this.checkStatus(), STATUS_CHECK_MS));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    this.closed = true;
    deviceBus.off("telemetry", this.onTelemetry);
    deviceBus.off("control", this.onControl);
    for (const t of this.timers) clearInterval(t);
    rooms.delete(this.wallId);
  }

  /** Re-read the wall; closes screens whose session is no longer valid. Returns false if the wall is gone. */
  async reload({ force = false } = {}) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const db = getDbFn();
      const wall = await db.collection(COLLECTION).findOne({ _id: this.wallId });
      const active = wall ? await ownerActive(db, wall.userId) : false;
      if (!wall || !wall.link || !active) {
        this.closeAll({ reason: !active && wall ? "account" : "link" });
        return false;
      }
      for (const c of [...this.clients]) {
        if (!sessionMatches(c.session, wall) || c.session.exp * 1000 < Date.now()) {
          const reason = c.session.lv !== wall.link.version ? "link" : c.session.pv !== (wall.pin?.version || 0) ? "pin" : "expired";
          this.dropClient(c, { reason });
        }
      }
      const snap = await buildSnapshot(db, wall);
      const first = !this.snapshot; // openStream sends the first snapshot itself
      const changed =
        force ||
        new Date(wall.updatedAt).getTime() !== new Date(this.wall?.updatedAt).getTime() ||
        snap.private.deviceIds.join() !== this.snapshot.private.deviceIds.join();
      this.wall = wall;
      this.snapshot = snap;
      this.values = { ...snap.public.values };
      this.devices = JSON.parse(JSON.stringify(snap.public.devices));
      this.lastSeenMs = { ...snap.private.lastSeenMs };
      this.byDevice = new Map();
      for (const t of snap.private.tiles) {
        if (!this.byDevice.has(t.deviceId)) this.byDevice.set(t.deviceId, []);
        this.byDevice.get(t.deviceId).push(t);
      }
      if (changed && !first && this.clients.size) this.broadcastRaw(frame("snapshot", snap.public));
      return true;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  send(update) {
    if (!Object.keys(update.values).length && !Object.keys(update.devices).length && !Object.keys(update.points).length) return;
    update.at = new Date().toISOString();
    this.broadcastRaw(frame("update", update));
  }

  telemetry(deviceId, doc) {
    const tiles = this.byDevice.get(deviceId);
    if (!tiles || !this.snapshot) return;
    const update = { values: {}, devices: {}, points: {} };
    const t = new Date(doc.createdAt || Date.now()).getTime();
    for (const tile of tiles) {
      if (tile.type === "series") {
        // Graph lines: only new points, the graph shows its own latest value
        const p = sensorValue(doc, tile.key);
        if (typeof p === "number") update.points[tile.id] = [t, p];
        continue;
      }
      if (tile.type !== "sensor") continue;
      const v = sensorValue(doc, tile.key);
      if (v === null) continue; // a partial message doesn't blank a reading
      if (!sameValue(this.values[tile.id], v)) {
        this.values[tile.id] = v;
        update.values[tile.id] = v;
      }
      if (tile.chart && typeof v === "number") update.points[tile.id] = [t, v];
    }
    const alias = this.snapshot.private.alias.get(deviceId);
    this.lastSeenMs[deviceId] = t;
    const dev = this.devices[alias];
    if (dev) {
      dev.lastSeen = new Date(t).toISOString();
      dev.online = true;
      update.devices[alias] = { ...dev };
    }
    this.send(update);
  }

  control(deviceId, doc) {
    const tiles = this.byDevice.get(deviceId);
    if (!tiles) return;
    const update = { values: {}, devices: {}, points: {} };
    for (const tile of tiles) {
      if (tile.type !== "actuator") continue;
      const v = actuatorValue(doc, tile.key);
      if (!sameValue(this.values[tile.id], v)) {
        this.values[tile.id] = v;
        update.values[tile.id] = v;
      }
    }
    this.send(update);
  }

  /** Devices go offline by silence, not by a message: check the clock. */
  checkStatus() {
    if (!this.snapshot) return;
    const limit = offlineThresholdSec() * 1000;
    const update = { values: {}, devices: {}, points: {} };
    for (const [deviceId, alias] of this.snapshot.private.alias) {
      const dev = this.devices[alias];
      const seen = this.lastSeenMs[deviceId];
      const online = seen != null && Date.now() - seen <= limit;
      if (dev && dev.online !== online) {
        dev.online = online;
        update.devices[alias] = { ...dev };
      }
    }
    this.send(update);
  }

  broadcastRaw(text) {
    for (const c of this.clients) {
      try {
        c.res.write(text);
      } catch {
        this.dropClient(c);
      }
    }
  }

  add(client) {
    this.clients.add(client);
  }

  dropClient(c, revoked) {
    if (!this.clients.delete(c)) return;
    release(c.ip);
    try {
      if (revoked) c.res.write(frame("revoked", revoked));
      c.res.end();
    } catch {}
    if (!this.clients.size) this.stop();
  }

  closeAll(revoked) {
    for (const c of [...this.clients]) this.dropClient(c, revoked);
    if (!this.closed) this.stop();
  }
}

function release(ip) {
  total = Math.max(0, total - 1);
  const n = (perIp.get(ip) || 1) - 1;
  if (n <= 0) perIp.delete(ip);
  else perIp.set(ip, n);
}

/**
 * Open a live stream for an already-verified session.
 * Returns { error, status } when the screen can't be added (too many screens).
 */
async function openStream(req, res, wall, session) {
  const ip = req.ip || "unknown";
  if (total >= MAX_STREAMS_TOTAL) return { status: 503, error: "The server is busy, try again in a minute" };
  if ((perIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) return { status: 429, error: "Too many screens open from this network" };
  let room = rooms.get(wall._id);
  if (room && room.clients.size >= MAX_STREAMS_PER_WALL) return { status: 429, error: `This wall is already open on ${MAX_STREAMS_PER_WALL} screens` };

  total++;
  perIp.set(ip, (perIp.get(ip) || 0) + 1);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.write("retry: 5000\n\n");

  const client = { res, session, ip };
  let fresh = false;
  if (!room) {
    room = new Room(wall._id);
    rooms.set(wall._id, room);
    room.start();
    fresh = true;
  }
  room.add(client);
  res.on("close", () => room.dropClient(client));

  try {
    if (fresh) {
      const ok = await room.reload({ force: false });
      if (!ok) return {};
    } else if (room.loading) {
      await room.loading;
    } else if (!room.snapshot) {
      await room.reload();
    }
    if (room.clients.has(client) && room.snapshot) {
      res.write(frame("snapshot", { ...room.snapshot.public, values: room.values, devices: room.devices, serverTime: new Date().toISOString() }));
    }
  } catch (e) {
    console.error("❌ wall stream failed:", e.message);
    room.dropClient(client);
  }
  return {};
}

/** The owner saved, re-linked or changed the PIN: refresh open screens now. */
function wallChanged(wallId) {
  const room = rooms.get(wallId);
  if (room) room.reload().catch((e) => console.error("⚠️ wall reload failed:", e.message));
}

/** Number of screens showing a wall right now. */
function screensOpen(wallId) {
  return rooms.get(wallId)?.clients.size || 0;
}

function closeAllStreams() {
  for (const room of [...rooms.values()]) room.closeAll(null);
}

/** Tests only */
function _setDb(fn) {
  getDbFn = fn;
}

module.exports = { openStream, wallChanged, screensOpen, closeAllStreams, _setDb };
