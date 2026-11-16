// src/controllers/wall.controller.js
// Wall display: the owner's editor (/api/wall, logged in) and the public, read-only
// screen (/api/public/wall, link token or session, no login). See WALL_FRONTEND_GUIDE.md.

const crypto = require("node:crypto");
const { getDb } = require("../db/mongo");
const { sendServerError } = require("../utils/http");
const { assertOwnFiles, sendIfValidation } = require("../utils/validate");
const w = require("../services/wall");
const hub = require("../services/wallHub");

const PIN_MAX_FAILS = 10;
const PIN_WINDOW_MS = 15 * 60 * 1000;
const SNAPSHOT_CACHE_MS = 3000;

const pinFails = new Map(); // wallId -> { count, resetAt }
const snapshotCache = new Map(); // wallId -> { at, version, data }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pinFails) if (v.resetAt <= now) pinFails.delete(k);
  for (const [k, v] of snapshotCache) if (now - v.at > 60_000) snapshotCache.delete(k);
}, 60_000).unref();

function handle(res, e, ctx) {
  if (sendIfValidation(res, e)) return;
  sendServerError(res, e, ctx);
}

const noStore = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

/* ─────────────────────────────── Owner (logged in) ─────────────────────────────── */

function ownerView(wall) {
  const base = wall || w.defaultWall();
  let link = null;
  if (wall?.link) {
    const token = w.decryptToken(wall.link.enc);
    link = token ? { token, createdAt: wall.link.createdAt } : { token: null, unreadable: true, createdAt: wall.link.createdAt };
  }
  return {
    ok: true,
    saved: !!wall,
    wall: { title: base.title, display: base.display, pages: base.pages },
    link,
    pin: { enabled: !!wall?.pin, updatedAt: wall?.pin?.updatedAt || null },
    screens: wall ? hub.screensOpen(wall._id) : 0,
    lastViewedAt: wall?.lastViewedAt || null,
    updatedAt: wall?.updatedAt || null,
  };
}

/** Create the user's wall with defaults if it doesn't exist yet; returns it. */
async function ensureWall(db, userId) {
  const d = w.defaultWall();
  const now = new Date();
  try {
    await db.collection(w.COLLECTION).updateOne(
      { userId },
      {
        $setOnInsert: {
          _id: crypto.randomBytes(12).toString("hex"),
          userId,
          ...d,
          link: null,
          linkVersion: 0,
          pin: null,
          pinVersion: 0,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true }
    );
  } catch (e) {
    if (e.code !== 11000) throw e; // created by a parallel request
  }
  return w.findWallByUser(db, userId);
}

// GET /api/wall
async function getWall(req, res) {
  try {
    const wall = await w.findWallByUser(getDb(), req.user.id);
    return res.json(ownerView(wall));
  } catch (e) {
    return handle(res, e, "get wall");
  }
}

// PUT /api/wall   { title, display, pages }
async function saveWall(req, res) {
  try {
    const db = getDb();
    const { title, display, pages, deviceIds, iconRefs } = w.validateWall(req.body);
    await assertOwnFiles(db, req.user.id, iconRefs, "icon");

    const allowed = await w.publishableDevices(db, req.user.id, deviceIds);
    const refused = deviceIds.filter((id) => !allowed.has(id));
    if (refused.length) {
      return res.status(403).json({
        ok: false,
        error: "Only devices you own or manage can go on a public wall",
        code: "WALL_DEVICE_NOT_ALLOWED",
        deviceIds: refused,
      });
    }

    const wall = await ensureWall(db, req.user.id);
    const saved = await db
      .collection(w.COLLECTION)
      .findOneAndUpdate({ _id: wall._id }, { $set: { title, display, pages, updatedAt: new Date() } }, { returnDocument: "after" });
    snapshotCache.delete(wall._id);
    hub.wallChanged(wall._id);
    return res.json(ownerView(saved));
  } catch (e) {
    return handle(res, e, "save wall");
  }
}

// POST /api/wall/link   create the public link, or replace it (the old one stops at once)
async function createLink(req, res) {
  try {
    const db = getDb();
    const wall = await ensureWall(db, req.user.id);
    const raw = w.newLinkToken();
    const version = (wall.linkVersion || 0) + 1;
    const saved = await db.collection(w.COLLECTION).findOneAndUpdate(
      { _id: wall._id },
      {
        $set: {
          link: { tokenHash: w.hashToken(raw), enc: w.encryptToken(raw), version, createdAt: new Date() },
          linkVersion: version,
        },
      },
      { returnDocument: "after" }
    );
    snapshotCache.delete(wall._id);
    hub.wallChanged(wall._id);
    return res.status(201).json(ownerView(saved));
  } catch (e) {
    return handle(res, e, "create wall link");
  }
}

// DELETE /api/wall/link   turn the public link off
async function deleteLink(req, res) {
  try {
    const db = getDb();
    const saved = await db
      .collection(w.COLLECTION)
      .findOneAndUpdate({ userId: req.user.id }, { $set: { link: null }, $inc: { linkVersion: 1 } }, { returnDocument: "after" });
    if (saved) {
      snapshotCache.delete(saved._id);
      hub.wallChanged(saved._id);
    }
    return res.json(ownerView(saved));
  } catch (e) {
    return handle(res, e, "delete wall link");
  }
}

// PUT /api/wall/pin   { pin: "4-8 digits" }   every open screen asks for it again
async function setPin(req, res) {
  try {
    const db = getDb();
    const hash = await w.hashPin(req.body?.pin);
    const wall = await ensureWall(db, req.user.id);
    const version = (wall.pinVersion || 0) + 1;
    const saved = await db
      .collection(w.COLLECTION)
      .findOneAndUpdate(
        { _id: wall._id },
        { $set: { pin: { hash, version, updatedAt: new Date() }, pinVersion: version } },
        { returnDocument: "after" }
      );
    pinFails.delete(wall._id);
    hub.wallChanged(wall._id);
    return res.json(ownerView(saved));
  } catch (e) {
    return handle(res, e, "set wall pin");
  }
}

// DELETE /api/wall/pin
async function clearPin(req, res) {
  try {
    const db = getDb();
    const saved = await db
      .collection(w.COLLECTION)
      .findOneAndUpdate({ userId: req.user.id }, { $set: { pin: null }, $inc: { pinVersion: 1 } }, { returnDocument: "after" });
    if (saved) hub.wallChanged(saved._id);
    return res.json(ownerView(saved));
  } catch (e) {
    return handle(res, e, "clear wall pin");
  }
}

/* ─────────────────────────────── Public (no login) ─────────────────────────────── */

const linkGone = (res) =>
  res.status(404).json({ ok: false, error: "This wall link doesn't work any more. Ask its owner for the new one.", code: "WALL_NOT_FOUND" });
const sessionInvalid = (res) => res.status(401).json({ ok: false, error: "Open the wall link again", code: "WALL_SESSION_INVALID" });

async function touchViewed(db, wall) {
  const last = wall.lastViewedAt ? new Date(wall.lastViewedAt).getTime() : 0;
  if (Date.now() - last < 60_000) return;
  await db.collection(w.COLLECTION).updateOne({ _id: wall._id }, { $set: { lastViewedAt: new Date() } });
}

// POST /api/public/wall/session   { token, pin? }  ->  { session, expiresAt }
async function createSession(req, res) {
  noStore(res);
  try {
    const db = getDb();
    const wall = await w.findWallByToken(db, req.body?.token);
    if (!wall || !wall.link || !(await w.ownerActive(db, wall.userId))) return linkGone(res);

    if (wall.pin) {
      const pin = req.body?.pin;
      if (pin === undefined || pin === null || pin === "") {
        return res.status(401).json({ ok: false, error: "Enter the PIN for this wall", code: "WALL_PIN_REQUIRED", title: wall.title });
      }
      const f = pinFails.get(wall._id);
      if (f && f.resetAt > Date.now() && f.count >= PIN_MAX_FAILS) {
        const minutes = Math.ceil((f.resetAt - Date.now()) / 60000);
        res.set("Retry-After", String(minutes * 60));
        return res.status(429).json({ ok: false, error: `Too many wrong PINs. Try again in ${minutes} min.`, code: "WALL_PIN_LOCKED" });
      }
      if (!(await w.checkPin(wall, String(pin)))) {
        const cur = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + PIN_WINDOW_MS };
        cur.count++;
        pinFails.set(wall._id, cur);
        return res.status(401).json({
          ok: false,
          error: "Wrong PIN",
          code: "WALL_PIN_WRONG",
          attemptsLeft: Math.max(0, PIN_MAX_FAILS - cur.count),
          title: wall.title,
        });
      }
    }

    await touchViewed(db, wall);
    return res.json({ ok: true, ...w.signSession(wall), title: wall.title });
  } catch (e) {
    return handle(res, e, "wall session");
  }
}

/** The wall for the session in `Authorization: Wall <session>`, or null after replying. */
async function wallFromSession(req, res) {
  const [type, value] = (req.headers.authorization || "").split(" ");
  const s = type === "Wall" ? w.verifySession(value) : null;
  if (!s) {
    sessionInvalid(res);
    return null;
  }
  const db = getDb();
  const wall = await db.collection(w.COLLECTION).findOne({ _id: s.w });
  if (!wall || !wall.link || !(await w.ownerActive(db, wall.userId))) {
    linkGone(res);
    return null;
  }
  if (!w.sessionMatches(s, wall)) {
    sessionInvalid(res);
    return null;
  }
  return { wall, session: s, db };
}

// GET /api/public/wall/stream   Server-Sent Events (see services/wallHub.js)
async function stream(req, res) {
  noStore(res);
  try {
    const found = await wallFromSession(req, res);
    if (!found) return;
    await touchViewed(found.db, found.wall);
    const r = await hub.openStream(req, res, found.wall, found.session);
    if (r.error && !res.headersSent) return res.status(r.status).json({ ok: false, error: r.error, code: "WALL_BUSY" });
  } catch (e) {
    if (!res.headersSent) return handle(res, e, "wall stream");
    console.error("❌ wall stream failed:", e.message);
  }
}

// GET /api/public/wall/snapshot   the same data once (for screens that can't stream)
async function snapshot(req, res) {
  noStore(res);
  try {
    const found = await wallFromSession(req, res);
    if (!found) return;
    const { wall, db } = found;
    const version = `${wall.updatedAt?.getTime?.() || 0}:${wall.linkVersion}:${wall.pinVersion}`;
    const cached = snapshotCache.get(wall._id);
    if (cached && cached.version === version && Date.now() - cached.at < SNAPSHOT_CACHE_MS) {
      return res.json({ ok: true, ...cached.data, serverTime: new Date().toISOString() });
    }
    await touchViewed(db, wall);
    const snap = await w.buildSnapshot(db, wall);
    snapshotCache.set(wall._id, { at: Date.now(), version, data: snap.public });
    return res.json({ ok: true, ...snap.public });
  } catch (e) {
    return handle(res, e, "wall snapshot");
  }
}

module.exports = { getWall, saveWall, createLink, deleteLink, setPin, clearPin, createSession, stream, snapshot };
