const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongoose").mongo;
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");

let db;
let app;
let deviceBus;
let hub;

before(async () => {
  db = await startDb();
  await require("../src/db/indexes").ensureIndexes(db);
  app = await startApp();
  ({ deviceBus } = require("../src/services/deviceBus"));
  hub = require("../src/services/wallHub");
});
after(async () => {
  hub.closeAllStreams();
  await app.close();
  await stopDb();
});
beforeEach(async () => {
  hub.closeAllStreams();
  await resetDb(db);
});

const call = (u, method, path, body) => app.api(method, path, { token: u.token, body });
const verify = (u) => db.collection("users").updateOne({ _id: new ObjectId(u.id) }, { $set: { emailVerified: true } });

async function pub(method, path, { session, body } = {}) {
  const res = await fetch(app.base + path, {
    method,
    headers: { "content-type": "application/json", ...(session ? { authorization: `Wall ${session}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

function wallBody(deviceId, extra = {}) {
  return {
    title: "Greenhouse wall",
    display: { theme: "dark", columns: 4, sound: { enabled: true }, voice: { enabled: true, lang: "en-GB" } },
    pages: [
      {
        id: "p1",
        title: "Main",
        tiles: [
          { id: "temp", type: "sensor", deviceId, key: "data.temp", unit: "°C", style: "chart", critical: { above: 40 } },
          { id: "raw", type: "sensor", deviceId, key: "t" },
          { id: "pump", type: "actuator", deviceId, key: "relay1", label: "Pump" },
          { id: "st", type: "status", deviceId },
          { id: "clk", type: "clock", size: "m" },
          { id: "note", type: "text", text: "Call 0771234567 if red" },
        ],
      },
    ],
    ...extra,
  };
}

/** Owner with a device, a saved wall and a public link. */
async function setup() {
  const owner = await createUser(app.api);
  await verify(owner);
  await createDevice(db, "dev-secret-id", owner.id);
  const saved = await call(owner, "PUT", "/api/wall", wallBody("dev-secret-id"));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const linked = await call(owner, "POST", "/api/wall/link");
  assert.equal(linked.status, 201);
  return { owner, token: linked.body.link.token };
}

async function session(token, pin) {
  const r = await pub("POST", "/api/public/wall/session", { body: { token, ...(pin !== undefined ? { pin } : {}) } });
  return r;
}

/** Open an SSE stream; returns { next(event), close }. */
async function openStream(sess) {
  const ac = new AbortController();
  const res = await fetch(app.base + "/api/public/wall/stream", { headers: { authorization: `Wall ${sess}` }, signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const queue = [];
  async function next(want, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = queue.findIndex((e) => e.event === want);
      if (i >= 0) return queue.splice(i, 1)[0].data;
      if (Date.now() > deadline) throw new Error(`no '${want}' event`);
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ value: null, done: false }), Math.max(10, deadline - Date.now()))),
      ]);
      if (done) throw new Error(`stream ended before '${want}'`);
      if (!value) continue;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) queue.push({ event: ev, data: JSON.parse(data) });
      }
    }
  }
  return { status: res.status, next, close: () => ac.abort() };
}

// ---------------------------------------------------------------- owner

test("a new user gets a default wall that is not saved yet", async () => {
  const u = await createUser(app.api);
  const r = await call(u, "GET", "/api/wall");
  assert.equal(r.status, 200);
  assert.equal(r.body.saved, false);
  assert.equal(r.body.link, null);
  assert.equal(r.body.wall.pages.length, 1);
});

test("saving validates the wall", async () => {
  const u = await createUser(app.api);
  const bad = [
    { pages: [] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "sensor" }] }] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "weird" }] }] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "clock" }, { id: "x", type: "clock" }] }] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "actuator", deviceId: "d", key: "__proto__" }] }] },
    { display: { theme: "neon" }, pages: [{ id: "p1", tiles: [] }] },
    { display: { quietHours: { from: "25:00" } }, pages: [{ id: "p1", tiles: [] }] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "text", text: "a".repeat(301) }] }] },
    { display: { voice: { engine: "robot" } }, pages: [{ id: "p1", tiles: [] }] },
    { display: { voice: { naturalVoice: "../../etc/passwd" } }, pages: [{ id: "p1", tiles: [] }] },
    { display: { voice: { volume: 3 } }, pages: [{ id: "p1", tiles: [] }] },
    { display: { canvas: { width: 100 } }, pages: [{ id: "p1", tiles: [] }] },
    { display: { canvas: { cols: 40 } }, pages: [{ id: "p1", tiles: [] }] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "clock", x: 0 }] }] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "clock", x: 20, y: 0, w: 6, h: 1 }] }] },
    { pages: [{ id: "p1", tiles: [{ id: "x", type: "clock", x: 0, y: 0, w: 0, h: 1 }] }] },
  ];
  for (const body of bad) {
    const r = await call(u, "PUT", "/api/wall", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test("voice settings are kept, with natural-voice defaults", async () => {
  const u = await createUser(app.api);
  let r = await call(u, "PUT", "/api/wall", { pages: [{ id: "p1", tiles: [] }] });
  assert.deepEqual(
    { engine: r.body.wall.display.voice.engine, naturalVoice: r.body.wall.display.voice.naturalVoice, volume: r.body.wall.display.voice.volume },
    { engine: "natural", naturalVoice: "en_US-hfc_female-medium", volume: 1 }
  );
  r = await call(u, "PUT", "/api/wall", { display: { voice: { enabled: true, engine: "natural", naturalVoice: "en_GB-jenny_dioco-medium", volume: 0.7 } }, pages: [{ id: "p1", tiles: [] }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.wall.display.voice.naturalVoice, "en_GB-jenny_dioco-medium");
  assert.equal(r.body.wall.display.voice.volume, 0.7);
});

test("canvas, tile positions and sound defaults are kept", async () => {
  const u = await createUser(app.api);
  let r = await call(u, "PUT", "/api/wall", { pages: [{ id: "p1", tiles: [] }] });
  assert.deepEqual(r.body.wall.display.canvas, { width: 1920, height: 1080, cols: 12, rows: 6 });
  assert.equal(r.body.wall.display.notifySec, 8);
  assert.equal(r.body.wall.display.sound.enabled, true);
  assert.equal(r.body.wall.display.voice.enabled, true);
  r = await call(u, "PUT", "/api/wall", {
    display: { canvas: { width: 1080, height: 1920, cols: 6, rows: 12 }, notifySec: 15 },
    pages: [{ id: "p1", tiles: [{ id: "c", type: "clock", x: 2, y: 3, w: 4, h: 2 }, { id: "n", type: "text", text: "hi" }] }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.wall.display.canvas, { width: 1080, height: 1920, cols: 6, rows: 12 });
  const [c, n] = r.body.wall.pages[0].tiles;
  assert.deepEqual([c.x, c.y, c.w, c.h], [2, 3, 4, 2]);
  assert.equal(n.x, undefined);
});

test("only devices you own or manage can go on a wall", async () => {
  const owner = await createUser(app.api);
  const viewer = await createUser(app.api);
  const manager = await createUser(app.api);
  await createDevice(db, "devA", owner.id);
  await db.collection("device_access").insertMany([
    { deviceId: "devA", userId: viewer.id, role: "viewer" },
    { deviceId: "devA", userId: manager.id, role: "manager" },
  ]);
  let r = await call(viewer, "PUT", "/api/wall", wallBody("devA"));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "WALL_DEVICE_NOT_ALLOWED");
  assert.deepEqual(r.body.deviceIds, ["devA"]);
  r = await call(viewer, "PUT", "/api/wall", wallBody("someone-elses"));
  assert.equal(r.status, 403);
  r = await call(manager, "PUT", "/api/wall", wallBody("devA"));
  assert.equal(r.status, 200);
  r = await call(owner, "PUT", "/api/wall", wallBody("devA"));
  assert.equal(r.status, 200);
});

test("a public link needs a verified email, and the owner can copy it again", async () => {
  const u = await createUser(app.api);
  let r = await call(u, "POST", "/api/wall/link");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "EMAIL_NOT_VERIFIED");
  await verify(u);
  r = await call(u, "POST", "/api/wall/link");
  assert.equal(r.status, 201);
  const token = r.body.link.token;
  assert.ok(token.length >= 40);
  r = await call(u, "GET", "/api/wall");
  assert.equal(r.body.link.token, token);
  // Only a hash and ciphertext are stored
  const doc = await db.collection("wall_displays").findOne({ userId: u.id });
  assert.ok(!JSON.stringify(doc).includes(token));
});

test("one wall per user: creating the link twice replaces it", async () => {
  const { owner, token } = await setup();
  const r = await call(owner, "POST", "/api/wall/link");
  assert.notEqual(r.body.link.token, token);
  assert.equal(await db.collection("wall_displays").countDocuments({ userId: owner.id }), 1);
  assert.equal((await session(token)).status, 404);
  assert.equal((await session(r.body.link.token)).status, 200);
});

// ---------------------------------------------------------------- public

test("the screen gets only what is on the tiles", async () => {
  const { owner, token } = await setup();
  const s = await session(token);
  assert.equal(s.status, 200);
  assert.equal(s.headers.get("cache-control"), "no-store");
  const r = await pub("GET", "/api/public/wall/snapshot", { session: s.body.session });
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("dev-secret-id"), "device id leaked");
  assert.ok(!text.includes(owner.email), "owner email leaked");
  assert.ok(!text.includes(owner.id), "owner id leaked");
  assert.ok(!text.includes("data.temp"), "telemetry key leaked");

  const tiles = r.body.wall.pages[0].tiles;
  const temp = tiles.find((t) => t.id === "temp");
  assert.equal(temp.dev, "d1");
  assert.equal(temp.label, "Temp");
  assert.equal(r.body.values.temp, 31);
  assert.equal(r.body.values.raw, 25);
  assert.deepEqual(r.body.values.pump, { on: false, auto: true });
  assert.equal(r.body.devices.d1.online, true);
  assert.equal(r.body.history.temp.length, 1);
  assert.equal(tiles.find((t) => t.id === "note").text, "Call 0771234567 if red");
});

test("bad tokens and sessions are refused", async () => {
  const { token } = await setup();
  assert.equal((await session("x".repeat(43))).status, 404);
  assert.equal((await session(undefined)).status, 404);
  assert.equal((await pub("GET", "/api/public/wall/snapshot")).status, 401);
  const s = (await session(token)).body.session;
  const [payload, sig] = s.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), exp: 9999999999 })).toString("base64url");
  assert.equal((await pub("GET", "/api/public/wall/snapshot", { session: `${forged}.${sig}` })).status, 401);
  // A normal login token is not a wall session, and a wall session is not a login token
  assert.equal((await app.api("GET", "/api/devices", { token: s })).status, 401);
});

test("turning the link off stops sessions", async () => {
  const { owner, token } = await setup();
  const s = (await session(token)).body.session;
  await call(owner, "DELETE", "/api/wall/link");
  assert.equal((await pub("GET", "/api/public/wall/snapshot", { session: s })).status, 404);
  assert.equal((await session(token)).status, 404);
});

test("a PIN is asked for, checked, and locks after 10 wrong tries", async () => {
  const { owner, token } = await setup();
  const before = (await session(token)).body.session;
  assert.equal((await call(owner, "PUT", "/api/wall/pin", { pin: "12" })).status, 400);
  assert.equal((await call(owner, "PUT", "/api/wall/pin", { pin: "482913" })).status, 200);
  // Sessions from before the PIN stop working
  assert.equal((await pub("GET", "/api/public/wall/snapshot", { session: before })).status, 401);

  let r = await session(token);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "WALL_PIN_REQUIRED");
  r = await session(token, "000000");
  assert.equal(r.body.code, "WALL_PIN_WRONG");
  assert.equal(r.body.attemptsLeft, 9);
  r = await session(token, "482913");
  assert.equal(r.status, 200);
  for (let i = 0; i < 9; i++) await session(token, "111111");
  r = await session(token, "482913");
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "WALL_PIN_LOCKED");
  // Changing the PIN clears the lock
  await call(owner, "PUT", "/api/wall/pin", { pin: "5555" });
  assert.equal((await session(token, "5555")).status, 200);
  await call(owner, "DELETE", "/api/wall/pin");
  assert.equal((await session(token)).status, 200);
});

test("a device the owner no longer manages disappears from the wall", async () => {
  const owner = await createUser(app.api);
  const manager = await createUser(app.api);
  await verify(manager);
  await createDevice(db, "devB", owner.id);
  await db.collection("device_access").insertOne({ deviceId: "devB", userId: manager.id, role: "manager" });
  await call(manager, "PUT", "/api/wall", wallBody("devB"));
  const token = (await call(manager, "POST", "/api/wall/link")).body.link.token;
  const s = (await session(token)).body.session;

  await db.collection("device_access").updateOne({ deviceId: "devB", userId: manager.id }, { $set: { role: "viewer" } });
  const r = await pub("GET", "/api/public/wall/snapshot", { session: s });
  assert.equal(r.status, 200);
  const temp = r.body.wall.pages[0].tiles.find((t) => t.id === "temp");
  assert.equal(temp.unavailable, true);
  assert.equal(r.body.values.temp, undefined);
  assert.deepEqual(r.body.devices, {});
});

test("a disabled account's wall stops", async () => {
  const { owner, token } = await setup();
  await db.collection("users").updateOne({ _id: new ObjectId(owner.id) }, { $set: { status: "disabled" } });
  assert.equal((await session(token)).status, 404);
});

// ---------------------------------------------------------------- live stream

test("graphs, pictures, colours, big icons and groups", async () => {
  const owner = await createUser(app.api);
  await verify(owner);
  await createDevice(db, "dev-secret-id", owner.id);
  // A day of readings, plus one a stranger owns
  const now = Date.now();
  await db.collection("device_telemetry").insertMany(
    Array.from({ length: 48 }, (_, i) => ({ deviceId: "dev-secret-id", createdAt: new Date(now - i * 30 * 60 * 1000), data: { temp: 20 + (i % 5) } }))
  );

  // Upload a picture (PNG signature is enough for the sniffing)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const up = await fetch(app.base + "/api/files/images", { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "image/png" }, body: png });
  assert.equal(up.status, 201);
  const image = (await up.json()).image;
  const list = await call(owner, "GET", "/api/files/images");
  assert.equal(list.body.images.length, 1);

  const page = {
    id: "p1",
    tiles: [
      { id: "g", type: "graph", x: 0, y: 0, w: 6, h: 3, rangeH: 24, chart: "line", series: [{ deviceId: "dev-secret-id", key: "data.temp", color: "#22c55e" }, { deviceId: "someone-elses", key: "x" }] },
      { id: "img", type: "image", image: image.ref, fit: "contain", label: "Factory", x: 6, y: 0, w: 4, h: 3 },
      { id: "t", type: "sensor", deviceId: "dev-secret-id", key: "data.temp", bg: "#1e3a8a", iconSize: "lg", icon: "emoji:🌡️", x: 0, y: 3, w: 2, h: 2 },
    ],
    groups: [{ id: "grp", label: "Hall A", icon: "emoji:🏭", color: "#f97316", x: 0, y: 3, w: 6, h: 3 }],
  };
  // Someone else's device in a graph is refused
  let r = await call(owner, "PUT", "/api/wall", { pages: [page] });
  assert.equal(r.status, 403);
  page.tiles[0].series.pop();
  r = await call(owner, "PUT", "/api/wall", { pages: [page] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const saved = r.body.wall.pages[0];
  assert.equal(saved.tiles[2].bg, "#1e3a8a");
  assert.equal(saved.tiles[2].iconSize, "lg");
  assert.deepEqual(saved.groups[0], { id: "grp", label: "Hall A", icon: "emoji:🏭", color: "#f97316", x: 0, y: 3, w: 6, h: 3 });

  // Someone else's picture can't be used
  const other = await createUser(app.api);
  r = await call(other, "PUT", "/api/wall", { pages: [{ id: "p1", tiles: [{ id: "img", type: "image", image: image.ref }] }] });
  assert.equal(r.status, 400);

  const bad = [
    { id: "g", type: "graph", series: [] },
    { id: "g", type: "graph", series: [{ deviceId: "dev-secret-id", key: "$where" }] },
    { id: "g", type: "graph", rangeH: 5, series: [{ deviceId: "dev-secret-id", key: "a" }] },
    { id: "i", type: "image", image: "https://example.com/x.png" },
    { id: "c", type: "clock", iconSize: "huge" },
    { id: "c", type: "clock", bg: "red; background:url(x)" },
  ];
  for (const t of bad) assert.equal((await call(owner, "PUT", "/api/wall", { pages: [{ id: "p1", tiles: [t] }] })).status, 400, JSON.stringify(t));
  assert.equal((await call(owner, "PUT", "/api/wall", { pages: [{ id: "p1", tiles: [], groups: [{ id: "g", label: "No place" }] }] })).status, 400);

  // The screen gets the graph's lines (device as an alias), bucketed history and the group
  const linked = await call(owner, "POST", "/api/wall/link");
  const s = (await session(linked.body.link.token)).body.session;
  const snap = (await pub("GET", "/api/public/wall/snapshot", { session: s })).body;
  const g = snap.wall.pages[0].tiles.find((t) => t.id === "g");
  assert.deepEqual(g.series.map((x) => [x.id, x.dev, x.label]), [["g.0", "d1", "Temp"]]);
  assert.ok(!JSON.stringify(snap).includes("dev-secret-id"));
  const hist = snap.history["g.0"];
  assert.ok(hist.length >= 40 && hist.length <= 120, `history points: ${hist.length}`);
  assert.ok(hist.every(([t, v], i) => (i === 0 || t > hist[i - 1][0]) && v >= 20 && v <= 31));
  assert.equal(snap.wall.pages[0].groups[0].label, "Hall A");
  assert.equal(snap.wall.pages[0].tiles.find((t) => t.id === "img").image, image.ref);

  // Live points for the graph line
  const st = await openStream(s);
  await st.next("snapshot");
  deviceBus.emit("telemetry", "dev-secret-id", { deviceId: "dev-secret-id", createdAt: new Date(), data: { temp: 27 } });
  const u = await st.next("update");
  assert.equal(u.points["g.0"][1], 27);
  st.close();

  assert.equal((await call(owner, "DELETE", `/api/files/images/${image.id}`)).status, 200);
});

test("the stream sends a snapshot, then only changes", async () => {
  const { token } = await setup();
  const s = (await session(token)).body.session;
  const st = await openStream(s);
  assert.equal(st.status, 200);
  const snap = await st.next("snapshot");
  assert.equal(snap.values.temp, 31);

  // A reading arrives: temp changed, t unchanged
  deviceBus.emit("telemetry", "dev-secret-id", { deviceId: "dev-secret-id", createdAt: new Date(), t: 25, data: { temp: 33.5 } });
  let up = await st.next("update");
  assert.deepEqual(up.values, { temp: 33.5 });
  assert.equal(up.points.temp[1], 33.5);
  assert.equal(up.devices.d1.online, true);

  // The pump is switched (from the API, a schedule or an automation)
  deviceBus.emit("control", "dev-secret-id", { _id: "dev-secret-id", actuators: { relay1: { state: "ON", auto: false } } });
  up = await st.next("update");
  assert.deepEqual(up.values, { pump: { on: true, auto: false } });

  // Other devices are ignored
  deviceBus.emit("telemetry", "other", { deviceId: "other", createdAt: new Date(), data: { temp: 99 } });
  await assert.rejects(st.next("update", 300));

  assert.equal(hub.screensOpen((await db.collection("wall_displays").findOne({}))._id), 1);
  st.close();
});

test("open screens get the owner's edits and are stopped when the link is turned off", async () => {
  const { owner, token } = await setup();
  const s = (await session(token)).body.session;
  const st = await openStream(s);
  await st.next("snapshot");

  const body = wallBody("dev-secret-id");
  body.title = "Renamed";
  await call(owner, "PUT", "/api/wall", body);
  const snap = await st.next("snapshot");
  assert.equal(snap.wall.title, "Renamed");

  await call(owner, "DELETE", "/api/wall/link");
  const rev = await st.next("revoked");
  assert.equal(rev.reason, "link");
  st.close();
});

test("an invalid session can't open a stream", async () => {
  const res = await fetch(app.base + "/api/public/wall/stream", { headers: { authorization: "Wall nope.nope" } });
  assert.equal(res.status, 401);
});
