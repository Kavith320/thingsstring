const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");

let db;
let app;
let handleDeviceMessage;
let handleDeviceEvent;

before(async () => {
  db = await startDb();
  app = await startApp();
  ({ handleDeviceMessage, handleDeviceEvent } = require("../src/mqtt/client"));
});
after(async () => {
  await app.close();
  await stopDb();
});
beforeEach(() => resetDb(db));

const msg = (o) => Buffer.from(JSON.stringify(o));
const call = (u, method, path, body) => app.api(method, path, { token: u.token, body });

// ---------------------------------------------------------------- ts/<id>/event

test("a device event lands in the activity history with the time it happened", async () => {
  await createDevice(db, "board1", "owner1");
  const t = Math.floor(Date.now() / 1000) - 600; // sent after a 10 minute outage
  await handleDeviceMessage(db, "ts/board1/event", msg({ t, up: 42, type: "WIFI", msg: "Wi-Fi back after 600 s" }));

  const rows = await db.collection("device_activity").find({ deviceId: "board1" }).toArray();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].actor, { type: "device" });
  assert.equal(rows[0].action, "device.wifi");
  assert.deepEqual(rows[0].details, { type: "WIFI", msg: "Wi-Fi back after 600 s" });
  assert.equal(rows[0].ts.getTime(), t * 1000);
});

test("an event without a usable clock gets the server time", async () => {
  await createDevice(db, "board1", "owner1");
  const before = Date.now();
  await handleDeviceMessage(db, "ts/board1/event", msg({ t: 0, type: "SYSTEM", msg: "Started" }));
  await handleDeviceMessage(db, "ts/board1/event", msg({ t: 1000, type: "SYSTEM", msg: "Clock from 1970" }));
  await handleDeviceMessage(db, "ts/board1/event", msg({ t: Date.now() / 1000 + 86400, type: "SYSTEM", msg: "Tomorrow" }));

  const rows = await db.collection("device_activity").find({ deviceId: "board1" }).toArray();
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(r.ts.getTime() >= before && r.ts.getTime() <= Date.now(), r.details.msg);
});

test("events from unknown devices, and empty or odd ones, are not stored", async () => {
  await createDevice(db, "board1", "owner1");
  await handleDeviceMessage(db, "ts/ghost/event", msg({ type: "RELAY", msg: "Fans ON" }));
  await handleDeviceMessage(db, "ts/board1/event", msg({ type: "RELAY", msg: "" }));
  await handleDeviceMessage(db, "ts/board1/event", msg({ type: "RELAY", msg: 42 }));
  await handleDeviceMessage(db, "ts/board1/event", msg({ type: "$where", msg: "x".repeat(500) }));

  const rows = await db.collection("device_activity").find({}).toArray();
  assert.equal(rows.length, 1, "only the long one with a real message");
  assert.equal(rows[0].action, "device.other");
  assert.equal(rows[0].details.msg.length, 200);
});

test("a flood of events is cut off per device and minute", async () => {
  await createDevice(db, "board2", "owner1");
  const now = Date.now();
  for (let i = 0; i < 70; i++) await handleDeviceEvent(db, "board2", { type: "RELAY", msg: `flip ${i}` }, now);
  assert.equal(await db.collection("device_activity").countDocuments({ deviceId: "board2" }), 60);

  await handleDeviceEvent(db, "board2", { type: "RELAY", msg: "next minute" }, now + 61e3);
  assert.equal(await db.collection("device_activity").countDocuments({ deviceId: "board2" }), 61);
});

test("device events show up in the activity list and its 'device' filter", async () => {
  const owner = await createUser(app.api);
  await createDevice(db, "board1", owner.id);
  await handleDeviceMessage(db, "ts/board1/event", msg({ type: "SENSOR", msg: "Sensor disconnected" }));

  const all = await call(owner, "GET", "/api/devices/board1/activity?action=device");
  assert.equal(all.status, 200);
  assert.equal(all.body.activity.length, 1);
  assert.deepEqual(all.body.activity[0].actor, { type: "device" });
  assert.equal(all.body.activity[0].details.msg, "Sensor disconnected");
});

// ---------------------------------------------------------------- POST /:deviceId/command

test("command: managers and owners only, known actions only", async () => {
  const owner = await createUser(app.api);
  const operator = await createUser(app.api);
  const manager = await createUser(app.api);
  await createDevice(db, "board1", owner.id);
  await db.collection("device_access").insertMany([
    { deviceId: "board1", userId: operator.id, role: "operator" },
    { deviceId: "board1", userId: manager.id, role: "manager" },
  ]);

  let r = await call(operator, "POST", "/api/devices/board1/command", { action: "update" });
  assert.equal(r.status, 403);

  r = await call(owner, "POST", "/api/devices/board1/command", { action: "reboot; rm -rf" });
  assert.equal(r.status, 400);
  r = await call(owner, "POST", "/api/devices/board1/command", {});
  assert.equal(r.status, 400);

  // Tests run without a broker: an allowed command is refused as "MQTT down", not sent blindly
  r = await call(manager, "POST", "/api/devices/board1/command", { action: "check_update" });
  assert.equal(r.status, 503);
  assert.equal(await db.collection("device_activity").countDocuments({ action: "device.command" }), 0);
});

test("command: a locked device takes none", async () => {
  const owner = await createUser(app.api);
  await createDevice(db, "board1", owner.id);
  await db.collection("device_config").updateOne({ _id: "board1" }, { $set: { isDisabled: true, disabledReason: "audit" } });
  const r = await call(owner, "POST", "/api/devices/board1/command", { action: "update" });
  assert.equal(r.status, 403);
});
