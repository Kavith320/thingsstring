// src/services/wall.js
// Wall display: a full-screen, read-only dashboard a user can open on a big screen
// through a public link (no login). One wall and one link per user.
//
// Security model (see WALL_FRONTEND_GUIDE.md):
//   - The link token is 256 random bits. It is stored twice: as a SHA-256 hash (to look
//     it up) and encrypted with AES-256-GCM (so the owner can copy it again). A copy
//     of the database alone gives no working link.
//   - A viewer swaps the link token (and the PIN, when one is set) for a signed session
//     that is valid 30 days. Regenerating or turning off the link, or changing the PIN,
//     bumps a version number and every session and open screen stops at once.
//   - Only what the owner put on a tile is ever sent: no device ids, owner details,
//     locations, schedules, or other readings. Nothing on a public route can write.
//   - Devices are re-checked while screens are open: a device only shows while its
//     owner still owns or manages it, and the wall stops if the account is disabled.

const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const { ObjectId } = require("mongoose").mongo;
const { isPlainObject, isSafeKey } = require("../utils/http");
const { fail, optString, optColor, optBool, parseIconRef } = require("../utils/validate");
const { getDeviceAccess } = require("./deviceAccess");
const { statusFromTelemetry, isAutoMode, offlineThresholdSec } = require("./deviceState");

const COLLECTION = "wall_displays";
const SESSION_TTL_SEC = 30 * 86400;
const MAX_PAGES = 10;
const MAX_TILES_PER_PAGE = 48;
const MAX_DEVICES = 50;
const HISTORY_MS = 60 * 60 * 1000;
const HISTORY_POINTS = 60;

const TILE_TYPES = ["sensor", "actuator", "status", "clock", "text", "graph", "image"];
const DEVICE_TILES = new Set(["sensor", "actuator", "status"]);
const TILE_SIZES = ["s", "m", "l", "t"]; // legacy sizes, used only to place tiles that have no position yet
const MAX_GRID = 24; // canvas columns / rows
const SENSOR_STYLES = ["number", "gauge", "chart"];
const ICON_SIZES = ["sm", "md", "lg"];
const GRAPH_KINDS = ["line", "area", "bar"];
const GRAPH_RANGES_H = [1, 6, 24, 72, 168]; // telemetry is kept 7 days
const MAX_SERIES = 4;
const MAX_GROUPS_PER_PAGE = 16;
const GRAPH_POINTS = 120;
const FILE_REF_RE = /^file:([a-f0-9]{32})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const SENSOR_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
// Piper voice ids, e.g. "en_US-hfc_female-medium" (the screen downloads the model itself)
const NATURAL_VOICE_RE = /^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]{1,40}-(x_low|low|medium|high)$/;

/* ─────────────────────────────── Secrets ─────────────────────────────── */

function masterSecret() {
  const s = process.env.WALL_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET missing in .env");
  return s;
}

const keyCache = new Map();
function derivedKey(purpose) {
  const secret = masterSecret();
  const id = `${purpose}:${secret}`;
  if (!keyCache.has(id)) {
    keyCache.clear();
    keyCache.set(id, Buffer.from(crypto.hkdfSync("sha256", secret, "thingsstring-wall", purpose, 32)));
  }
  return keyCache.get(id);
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

function newLinkToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function encryptToken(raw) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey("link-v1"), iv);
  const ct = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return { iv: b64u(iv), tag: b64u(cipher.getAuthTag()), ct: b64u(ct) };
}

/** The owner's copy of the link token, or null if it can't be read (e.g. the secret changed). */
function decryptToken(enc) {
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", derivedKey("link-v1"), Buffer.from(enc.iv, "base64url"));
    d.setAuthTag(Buffer.from(enc.tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(enc.ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", derivedKey("session-v1")).update(payloadB64).digest("base64url");
}

function signSession(wall) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = b64u(JSON.stringify({ w: wall._id, lv: wall.link?.version || 0, pv: wall.pin?.version || 0, exp }));
  return { session: `${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** { w, lv, pv, exp } for a valid, unexpired session string; otherwise null. */
function verifySession(str) {
  if (typeof str !== "string" || str.length > 400) return null;
  const [payload, sig] = str.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let s;
  try {
    s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!s || typeof s.w !== "string" || !Number.isInteger(s.lv) || !Number.isInteger(s.pv)) return null;
  if (!Number.isInteger(s.exp) || s.exp * 1000 < Date.now()) return null;
  return s;
}

/** Does this session still match the wall (link not regenerated/turned off, PIN unchanged)? */
function sessionMatches(s, wall) {
  return !!(wall && wall.link && s.w === wall._id && s.lv === wall.link.version && s.pv === (wall.pin?.version || 0));
}

/* ─────────────────────────────────── PIN ─────────────────────────────────── */

const PIN_RE = /^\d{4,8}$/;

async function hashPin(pin) {
  if (typeof pin !== "string" || !PIN_RE.test(pin)) fail("The PIN must be 4 to 8 digits");
  return bcrypt.hash(pin, 10);
}

async function checkPin(wall, pin) {
  if (!wall.pin?.hash) return true;
  if (typeof pin !== "string" || !PIN_RE.test(pin)) return false;
  return bcrypt.compare(pin, wall.pin.hash);
}

/* ──────────────────────────────── Validation ──────────────────────────────── */

function optNumber(v, field, { min = -1e12, max = 1e12 } = {}) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`'${field}' must be a number`);
  if (v < min || v > max) fail(`'${field}' must be between ${min} and ${max}`);
  return v;
}

function optInt(v, field, { min, max, fallback }) {
  if (v === undefined || v === null) return fallback;
  if (!Number.isInteger(v) || v < min || v > max) fail(`'${field}' must be a whole number from ${min} to ${max}`);
  return v;
}

function pick(v, field, values, fallback) {
  if (v === undefined || v === null) return fallback;
  if (!values.includes(v)) fail(`'${field}' must be one of: ${values.join(", ")}`);
  return v;
}

function range(v, field) {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) fail(`'${field}' must be an object like { "below": 20, "above": 35 }`);
  const below = optNumber(v.below, `${field}.below`);
  const above = optNumber(v.above, `${field}.above`);
  return below === null && above === null ? null : { below, above };
}

function validateDisplay(d = {}) {
  if (!isPlainObject(d)) fail("'display' must be an object");
  const sound = d.sound === undefined ? {} : d.sound;
  const voice = d.voice === undefined ? {} : d.voice;
  const quiet = d.quietHours === undefined ? {} : d.quietHours;
  if (!isPlainObject(sound)) fail("'display.sound' must be an object");
  if (!isPlainObject(voice)) fail("'display.voice' must be an object");
  if (!isPlainObject(quiet)) fail("'display.quietHours' must be an object");
  const canvas = d.canvas === undefined || d.canvas === null ? {} : d.canvas;
  if (!isPlainObject(canvas)) fail("'display.canvas' must be an object");
  const rotateSec = optInt(d.rotateSec, "display.rotateSec", { min: 0, max: 3600, fallback: 0 });
  if (rotateSec > 0 && rotateSec < 5) fail("'display.rotateSec' must be 0 (off) or at least 5");
  return {
    theme: pick(d.theme, "display.theme", ["auto", "light", "dark"], "dark"),
    accent: optColor(d.accent ?? null, "display.accent"),
    columns: optInt(d.columns, "display.columns", { min: 2, max: 8, fallback: 4 }),
    // The screen the wall is designed for: its size sets the shape of the canvas, which is
    // split into cols x rows cells that tiles snap to. Other screens scale it to fit.
    canvas: {
      width: optInt(canvas.width, "display.canvas.width", { min: 320, max: 7680, fallback: 1920 }),
      height: optInt(canvas.height, "display.canvas.height", { min: 320, max: 7680, fallback: 1080 }),
      cols: optInt(canvas.cols, "display.canvas.cols", { min: 2, max: MAX_GRID, fallback: 12 }),
      rows: optInt(canvas.rows, "display.canvas.rows", { min: 2, max: MAX_GRID, fallback: 6 }),
    },
    notifySec: optInt(d.notifySec, "display.notifySec", { min: 3, max: 120, fallback: 8 }),
    textScale: optNumber(d.textScale, "display.textScale", { min: 0.75, max: 2 }) ?? 1,
    rotateSec,
    showClock: optBool(d.showClock, "display.showClock", true),
    showFeed: optBool(d.showFeed, "display.showFeed", true),
    highlightSec: optInt(d.highlightSec, "display.highlightSec", { min: 1, max: 60, fallback: 6 }),
    burnInShift: optBool(d.burnInShift, "display.burnInShift", true),
    sound: {
      enabled: optBool(sound.enabled, "display.sound.enabled", true),
      on: pick(sound.on, "display.sound.on", ["all", "alerts"], "all"),
      tone: pick(sound.tone, "display.sound.tone", ["chime", "beep", "soft"], "chime"),
      volume: optNumber(sound.volume, "display.sound.volume", { min: 0, max: 1 }) ?? 0.6,
    },
    voice: {
      enabled: optBool(voice.enabled, "display.voice.enabled", true),
      on: pick(voice.on, "display.voice.on", ["all", "alerts"], "all"),
      engine: pick(voice.engine, "display.voice.engine", ["natural", "browser"], "natural"),
      naturalVoice:
        optString(voice.naturalVoice ?? null, "display.voice.naturalVoice", { max: 60, pattern: NATURAL_VOICE_RE, patternMsg: "'display.voice.naturalVoice' is not a voice id" }) ||
        "en_US-hfc_female-medium",
      volume: optNumber(voice.volume, "display.voice.volume", { min: 0, max: 1 }) ?? 1,
      rate: optNumber(voice.rate, "display.voice.rate", { min: 0.5, max: 2 }) ?? 1,
      pitch: optNumber(voice.pitch, "display.voice.pitch", { min: 0.5, max: 2 }) ?? 1,
      lang: optString(voice.lang ?? null, "display.voice.lang", { max: 20, pattern: LANG_RE }),
      voiceName: optString(voice.voiceName ?? null, "display.voice.voiceName", { max: 100 }),
    },
    quietHours: {
      enabled: optBool(quiet.enabled, "display.quietHours.enabled", false),
      from: optString(quiet.from ?? "22:00", "display.quietHours.from", { pattern: TIME_RE, patternMsg: "Quiet hours use HH:MM" }) || "22:00",
      to: optString(quiet.to ?? "06:00", "display.quietHours.to", { pattern: TIME_RE, patternMsg: "Quiet hours use HH:MM" }) || "06:00",
    },
  };
}

function cellFields(t, field, out, required) {
  if (t.x === undefined || t.x === null) {
    if (required) fail(`'${field}' needs x, y, w and h`);
    return;
  }
  out.x = optInt(t.x, `${field}.x`, { min: 0, max: MAX_GRID - 1 });
  out.y = optInt(t.y, `${field}.y`, { min: 0, max: MAX_GRID - 1 });
  out.w = optInt(t.w, `${field}.w`, { min: 1, max: MAX_GRID });
  out.h = optInt(t.h, `${field}.h`, { min: 1, max: MAX_GRID });
  if ([out.y, out.w, out.h].includes(undefined)) fail(`'${field}' needs x, y, w and h together`);
  if (out.x + out.w > MAX_GRID || out.y + out.h > MAX_GRID) fail(`'${field}' goes past the edge of the canvas`);
}

/** A named frame around tiles on a page (tiles inside its area belong to it). */
function validateGroup(g, field, iconRefs) {
  if (!isPlainObject(g)) fail(`'${field}' must be an object`);
  const id = optString(g.id ?? null, `${field}.id`, { pattern: ID_RE, patternMsg: `'${field}.id' must be 1-16 letters, digits, - or _` });
  if (!id) fail(`'${field}.id' is required`);
  const icon = parseIconRef(g.icon ?? null, `${field}.icon`);
  if (icon.fileId) iconRefs.push({ fileId: icon.fileId, field: `${field}.icon` });
  const out = { id, label: optString(g.label ?? null, `${field}.label`, { max: 40 }), icon: icon.value, color: optColor(g.color ?? null, `${field}.color`) };
  cellFields(g, field, out, true);
  return out;
}

function validateTile(t, field, iconRefs, imageRefs) {
  if (!isPlainObject(t)) fail(`'${field}' must be an object`);
  const id = optString(t.id ?? null, `${field}.id`, { pattern: ID_RE, patternMsg: `'${field}.id' must be 1-16 letters, digits, - or _` });
  if (!id) fail(`'${field}.id' is required`);
  const type = pick(t.type, `${field}.type`, TILE_TYPES);
  if (type === undefined) fail(`'${field}.type' is required`);
  const icon = parseIconRef(t.icon ?? null, `${field}.icon`);
  if (icon.fileId) iconRefs.push({ fileId: icon.fileId, field: `${field}.icon` });

  const tile = {
    id,
    type,
    label: optString(t.label ?? null, `${field}.label`, { max: 60 }),
    icon: icon.value,
    color: optColor(t.color ?? null, `${field}.color`),
    bg: optColor(t.bg ?? null, `${field}.bg`),
    iconSize: pick(t.iconSize, `${field}.iconSize`, ICON_SIZES, "sm"),
    size: pick(t.size, `${field}.size`, TILE_SIZES, "s"),
    announce: optBool(t.announce, `${field}.announce`, true),
  };
  // Position on the canvas grid, in cells. Tiles without one are placed by the screen.
  cellFields(t, field, tile, false);

  if (DEVICE_TILES.has(type)) {
    const deviceId = optString(t.deviceId ?? null, `${field}.deviceId`, { max: 100 });
    if (!deviceId) fail(`'${field}.deviceId' is required`);
    tile.deviceId = deviceId;
  }
  if (type === "sensor") {
    const key = optString(t.key ?? null, `${field}.key`, { pattern: SENSOR_KEY_RE, patternMsg: `'${field}.key' is not a valid reading key` });
    if (!key) fail(`'${field}.key' is required`);
    Object.assign(tile, {
      key,
      unit: optString(t.unit ?? null, `${field}.unit`, { max: 16 }),
      style: pick(t.style, `${field}.style`, SENSOR_STYLES, "number"),
      decimals: optInt(t.decimals, `${field}.decimals`, { min: 0, max: 4, fallback: null }),
      min: optNumber(t.min, `${field}.min`),
      max: optNumber(t.max, `${field}.max`),
      warn: range(t.warn, `${field}.warn`),
      critical: range(t.critical, `${field}.critical`),
    });
    if (tile.min !== null && tile.max !== null && tile.min >= tile.max) fail(`'${field}.min' must be below '${field}.max'`);
  }
  if (type === "actuator") {
    if (!isSafeKey(t.key)) fail(`'${field}.key' is not a valid control key`);
    tile.key = t.key;
  }
  if (type === "text") {
    tile.text = optString(t.text ?? null, `${field}.text`, { max: 300 });
  }
  if (type === "graph") {
    // One to four readings, from any devices, drawn over the last `rangeH` hours
    if (!Array.isArray(t.series) || t.series.length < 1 || t.series.length > MAX_SERIES) fail(`'${field}.series' must be a list of 1 to ${MAX_SERIES} readings`);
    tile.series = t.series.map((x, i) => {
      const f = `${field}.series[${i}]`;
      if (!isPlainObject(x)) fail(`'${f}' must be an object`);
      const deviceId = optString(x.deviceId ?? null, `${f}.deviceId`, { max: 100 });
      if (!deviceId) fail(`'${f}.deviceId' is required`);
      const key = optString(x.key ?? null, `${f}.key`, { pattern: SENSOR_KEY_RE, patternMsg: `'${f}.key' is not a valid reading key` });
      if (!key) fail(`'${f}.key' is required`);
      return { deviceId, key, label: optString(x.label ?? null, `${f}.label`, { max: 40 }), unit: optString(x.unit ?? null, `${f}.unit`, { max: 16 }), color: optColor(x.color ?? null, `${f}.color`) };
    });
    tile.rangeH = pick(t.rangeH, `${field}.rangeH`, GRAPH_RANGES_H, 24);
    tile.chart = pick(t.chart, `${field}.chart`, GRAPH_KINDS, "area");
    tile.decimals = optInt(t.decimals, `${field}.decimals`, { min: 0, max: 4, fallback: null });
    tile.min = optNumber(t.min, `${field}.min`);
    tile.max = optNumber(t.max, `${field}.max`);
    if (tile.min !== null && tile.max !== null && tile.min >= tile.max) fail(`'${field}.min' must be below '${field}.max'`);
  }
  if (type === "image") {
    const image = optString(t.image ?? null, `${field}.image`, { max: 100 });
    const m = image ? FILE_REF_RE.exec(image) : null;
    if (image && !m) fail(`'${field}.image' must be "file:<uploaded id>"`);
    tile.image = image;
    if (m) imageRefs.push({ fileId: m[1], field: `${field}.image` });
    tile.fit = pick(t.fit, `${field}.fit`, ["cover", "contain"], "cover");
  }
  return tile;
}

/**
 * Validate a whole wall from PUT /api/wall. Returns { title, display, pages, deviceIds, iconRefs, imageRefs }.
 * Unknown fields are dropped.
 */
function validateWall(body) {
  if (!isPlainObject(body)) fail("Body must be a JSON object");
  const title = optString(body.title ?? null, "title", { max: 80 }) || "Wall display";
  const display = validateDisplay(body.display ?? {});
  if (!Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > MAX_PAGES) {
    fail(`'pages' must be a list of 1 to ${MAX_PAGES} pages`);
  }
  const iconRefs = [];
  const imageRefs = [];
  const tileIds = new Set();
  const pageIds = new Set();
  const deviceIds = new Set();
  const pages = body.pages.map((p, i) => {
    if (!isPlainObject(p)) fail(`'pages[${i}]' must be an object`);
    const id = optString(p.id ?? null, `pages[${i}].id`, { pattern: ID_RE, patternMsg: `'pages[${i}].id' must be 1-16 letters, digits, - or _` });
    if (!id) fail(`'pages[${i}].id' is required`);
    if (pageIds.has(id)) fail(`Page id '${id}' is used twice`);
    pageIds.add(id);
    const tiles = p.tiles ?? [];
    if (!Array.isArray(tiles) || tiles.length > MAX_TILES_PER_PAGE) fail(`'pages[${i}].tiles' must be a list of at most ${MAX_TILES_PER_PAGE} tiles`);
    const groups = p.groups ?? [];
    if (!Array.isArray(groups) || groups.length > MAX_GROUPS_PER_PAGE) fail(`'pages[${i}].groups' must be a list of at most ${MAX_GROUPS_PER_PAGE} groups`);
    return {
      id,
      title: optString(p.title ?? null, `pages[${i}].title`, { max: 60 }),
      tiles: tiles.map((t, j) => {
        const tile = validateTile(t, `pages[${i}].tiles[${j}]`, iconRefs, imageRefs);
        if (tileIds.has(tile.id)) fail(`Tile id '${tile.id}' is used twice`);
        tileIds.add(tile.id);
        if (tile.deviceId) deviceIds.add(tile.deviceId);
        for (const x of tile.series || []) deviceIds.add(x.deviceId);
        return tile;
      }),
      groups: groups.map((g, j) => {
        const group = validateGroup(g, `pages[${i}].groups[${j}]`, iconRefs);
        if (tileIds.has(group.id)) fail(`Id '${group.id}' is used twice`);
        tileIds.add(group.id);
        return group;
      }),
    };
  });
  if (deviceIds.size > MAX_DEVICES) fail(`A wall can show at most ${MAX_DEVICES} devices`);
  return { title, display, pages, deviceIds: [...deviceIds], iconRefs, imageRefs };
}

/** Roles that may put a device on a public wall. */
const PUBLISH_ROLES = new Set(["owner", "manager"]);

/** Device ids (of `deviceIds`) the user may currently publish. */
async function publishableDevices(db, userId, deviceIds) {
  const ok = new Set();
  await Promise.all(
    deviceIds.map(async (id) => {
      const a = await getDeviceAccess(db, id, userId);
      if (a && PUBLISH_ROLES.has(a.role)) ok.add(id);
    })
  );
  return ok;
}

/* ──────────────────────────────── Live values ──────────────────────────────── */

function getPath(obj, path) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  return path.split(".").reduce((o, k) => (o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}

function scalar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.slice(0, 64);
  return null;
}

function sensorValue(telemetry, key) {
  return scalar(getPath(telemetry, key));
}

function isOn(v) {
  if (v && typeof v === "object") return isOn(v.state ?? v.status ?? v.value);
  const s = String(v ?? "").toUpperCase();
  return s === "ON" || s === "1" || s === "TRUE" || s === "HIGH";
}

/** { on, auto } of an actuator, from the control document (desired state). */
function actuatorValue(control, key) {
  const a = control?.actuators?.[key];
  if (!a || typeof a !== "object") return null;
  const raw = a.state ?? a.status ?? a.value ?? a.default?.state;
  return { on: isOn(raw), auto: isAutoMode(a) };
}

function humanize(key) {
  const last = String(key).split(".").pop();
  const s = last.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}

/** Numeric telemetry history for chart tiles: [[ms, value], ...] over the last hour. */
async function sensorHistory(db, deviceId, key) {
  const since = new Date(Date.now() - HISTORY_MS);
  const rows = await db
    .collection("device_telemetry")
    .find({ deviceId, createdAt: { $gte: since } }, { projection: { createdAt: 1, [key]: 1 } })
    .sort({ createdAt: 1 })
    .limit(2000)
    .toArray();
  const pts = [];
  for (const r of rows) {
    const v = sensorValue(r, key);
    if (typeof v === "number") pts.push([new Date(r.createdAt).getTime(), v]);
  }
  if (pts.length <= HISTORY_POINTS) return pts;
  // Average into equal time buckets
  const bucket = HISTORY_MS / HISTORY_POINTS;
  const start = since.getTime();
  const sums = new Map();
  for (const [t, v] of pts) {
    const b = Math.floor((t - start) / bucket);
    const s = sums.get(b) || { t: 0, v: 0, n: 0 };
    s.t += t;
    s.v += v;
    s.n++;
    sums.set(b, s);
  }
  return [...sums.keys()].sort((a, b) => a - b).map((b) => {
    const s = sums.get(b);
    return [Math.round(s.t / s.n), Math.round((s.v / s.n) * 1000) / 1000];
  });
}

/**
 * History for graph tiles over `hours`: averages in GRAPH_POINTS equal time buckets,
 * computed in the database (a week of readings can be a lot of rows). The last hour is
 * read exactly. Cached for a bucket's length, since open screens reload every minute.
 */
const historyCache = new Map();
async function rangeHistory(db, deviceId, key, hours) {
  if (hours <= 1) return sensorHistory(db, deviceId, key);
  const bucket = (hours * 3600 * 1000) / GRAPH_POINTS;
  const id = [deviceId, key, hours].join("|");
  const hit = historyCache.get(id);
  if (hit && Date.now() - hit.at < Math.min(bucket, 5 * 60 * 1000)) return hit.points;
  const start = Date.now() - hours * 3600 * 1000;
  const rows = await db
    .collection("device_telemetry")
    .aggregate([
      { $match: { deviceId, createdAt: { $gte: new Date(start) } } },
      // key is checked by SENSOR_KEY_RE: letters, digits, _ . - only, never "$"
      { $project: { t: { $toLong: "$createdAt" }, v: "$" + key } },
      { $match: { v: { $type: "number" } } },
      { $group: { _id: { $floor: { $divide: [{ $subtract: ["$t", start] }, bucket] } }, t: { $avg: "$t" }, v: { $avg: "$v" } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const points = rows.filter((r) => Number.isFinite(r.v)).map((r) => [Math.round(r.t), Math.round(r.v * 1000) / 1000]);
  if (historyCache.size > 2000) historyCache.clear();
  historyCache.set(id, { at: Date.now(), points });
  return points;
}

/**
 * Everything a screen needs, built from the database: the public wall (tiles without
 * device ids), device aliases with name and online state, current values and chart history.
 * Also returns `private` bookkeeping for the hub (never sent).
 */
async function buildSnapshot(db, wall) {
  const allIds = [...new Set(wall.pages.flatMap((p) => p.tiles.flatMap((t) => [t.deviceId, ...(t.series || []).map((x) => x.deviceId)]).filter(Boolean)))];
  const allowed = await publishableDevices(db, wall.userId, allIds);
  const ids = allIds.filter((id) => allowed.has(id));

  const [configs, controls, uis, telemetry] = await Promise.all([
    db.collection("device_config").find({ _id: { $in: ids } }, { projection: { "device.name": 1 } }).toArray(),
    db.collection("device_control").find({ _id: { $in: ids } }).toArray(),
    db.collection("device_ui").find({ _id: { $in: ids } }, { projection: { displayName: 1, sensors: 1, actuators: 1 } }).toArray(),
    Promise.all(ids.map((id) => db.collection("device_telemetry").findOne({ deviceId: id }, { sort: { _id: -1 } }))),
  ]);
  const cfg = new Map(configs.map((c) => [c._id, c]));
  const ctl = new Map(controls.map((c) => [c._id, c]));
  const ui = new Map(uis.map((u) => [u._id, u]));
  const tel = new Map(ids.map((id, i) => [id, telemetry[i]]));

  // Short aliases so the screen never learns real device ids
  const alias = new Map(ids.map((id, i) => [id, `d${i + 1}`]));
  const devices = {};
  const lastSeenMs = {};
  for (const id of ids) {
    const st = statusFromTelemetry(tel.get(id));
    const name = ui.get(id)?.displayName || cfg.get(id)?.device?.name || "Device";
    devices[alias.get(id)] = { name: String(name).slice(0, 80), online: st.online, lastSeen: st.lastSeen };
    lastSeenMs[id] = st.lastSeen ? Date.parse(st.lastSeen) : null;
  }

  const values = {};
  const history = {};
  const tiles = []; // [{ id, type, deviceId, key, chart }] for the hub
  const ranges = []; // graph series: [{ id, deviceId, key, hours }]
  const pages = [];
  const cellOf = (t) => ({ x: t.x, y: t.y, w: t.w, h: t.h });
  for (const p of wall.pages) {
    const out = [];
    for (const t of p.tiles) {
      if (t.type === "graph") {
        // Series of devices the owner can't publish any more are left out
        const series = [];
        (t.series || []).forEach((x, i) => {
          if (!alias.has(x.deviceId)) return;
          const entry = ui.get(x.deviceId)?.sensors?.find?.((e) => e?.key === x.key);
          const sid = `${t.id}.${i}`;
          series.push({ id: sid, dev: alias.get(x.deviceId), label: x.label || entry?.label || humanize(x.key), unit: x.unit || (entry?.unit ? String(entry.unit).slice(0, 16) : null), color: x.color });
          tiles.push({ id: sid, type: "series", deviceId: x.deviceId, key: x.key, chart: true });
          ranges.push({ id: sid, hours: t.rangeH || 24 });
        });
        if (!series.length) {
          out.push({ id: t.id, type: t.type, size: t.size, ...cellOf(t), label: t.label || "Not available", unavailable: true });
          continue;
        }
        out.push({ ...t, series });
        continue;
      }
      const { deviceId, ...pub } = t;
      if (deviceId) {
        if (!alias.has(deviceId)) {
          out.push({ id: t.id, type: t.type, size: t.size, ...cellOf(t), label: t.label || "Not available", unavailable: true });
          continue;
        }
        pub.dev = alias.get(deviceId);
        const entry = (t.type === "actuator" ? ui.get(deviceId)?.actuators : ui.get(deviceId)?.sensors)?.find?.((e) => e?.key === t.key);
        if (!pub.label) pub.label = t.type === "status" ? devices[pub.dev].name : entry?.label || humanize(t.key);
        if (t.type === "sensor" && !pub.unit && entry?.unit) pub.unit = String(entry.unit).slice(0, 16);
        if (t.type === "sensor") values[t.id] = sensorValue(tel.get(deviceId), t.key);
        if (t.type === "actuator") values[t.id] = actuatorValue(ctl.get(deviceId), t.key);
        tiles.push({ id: t.id, type: t.type, deviceId, key: t.key, chart: t.type === "sensor" && t.style === "chart" });
      }
      if (t.type === "sensor") delete pub.key;
      if (t.type === "actuator") delete pub.key;
      out.push(pub);
    }
    pages.push({ id: p.id, title: p.title, tiles: out, groups: p.groups || [] });
  }

  const rangeOf = new Map(ranges.map((r) => [r.id, r.hours]));
  await Promise.all(
    tiles
      .filter((t) => t.chart)
      .map(async (t) => {
        history[t.id] = rangeOf.has(t.id) ? await rangeHistory(db, t.deviceId, t.key, rangeOf.get(t.id)) : await sensorHistory(db, t.deviceId, t.key);
      })
  );

  return {
    public: {
      wall: { title: wall.title, display: wall.display, pages },
      devices,
      values,
      history,
      offlineAfterSec: offlineThresholdSec(),
      serverTime: new Date().toISOString(),
    },
    private: { alias, tiles, lastSeenMs, deviceIds: ids },
  };
}

/* ─────────────────────────────── Documents ─────────────────────────────── */

function defaultWall() {
  return {
    title: "Wall display",
    display: validateDisplay({}),
    pages: [{ id: "p1", title: null, tiles: [{ id: "clock", type: "clock", size: "m", x: 0, y: 0, w: 4, h: 2, label: null, icon: null, color: null, announce: false }] }],
  };
}

async function findWallByUser(db, userId) {
  return db.collection(COLLECTION).findOne({ userId: String(userId) });
}

async function findWallByToken(db, raw) {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 100) return null;
  return db.collection(COLLECTION).findOne({ "link.tokenHash": hashToken(raw) });
}

/** Is the account behind the wall still allowed to use the platform? */
async function ownerActive(db, userId) {
  let oid;
  try {
    oid = new ObjectId(String(userId));
  } catch {
    return false;
  }
  const u = await db.collection("users").findOne({ _id: oid }, { projection: { isActive: 1, status: 1 } });
  return !!u && u.isActive !== false && u.status !== "disabled";
}

module.exports = {
  COLLECTION,
  SESSION_TTL_SEC,
  newLinkToken,
  hashToken,
  encryptToken,
  decryptToken,
  signSession,
  verifySession,
  sessionMatches,
  hashPin,
  checkPin,
  validateWall,
  publishableDevices,
  PUBLISH_ROLES,
  buildSnapshot,
  sensorValue,
  actuatorValue,
  sensorHistory,
  rangeHistory,
  defaultWall,
  findWallByUser,
  findWallByToken,
  ownerActive,
};
