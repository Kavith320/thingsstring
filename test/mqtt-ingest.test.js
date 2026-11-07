const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startDb, stopDb, resetDb } = require("./helpers");

let db;
let handleDeviceMessage;

before(async () => {
  db = await startDb();
  ({ handleDeviceMessage } = require("../src/mqtt/client"));
});
after(stopDb);
beforeEach(() => resetDb(db));

const msg = (o) => Buffer.from(JSON.stringify(o));

test("telemetry cannot overwrite deviceId, createdAt or _id", async () => {
  await handleDeviceMessage(
    db,
    "ts/devA/telemetry",
    msg({ deviceId: "devB", createdAt: "1999-01-01", _id: "x", t: 21 })
  );
  const rows = await db.collection("device_telemetry").find({}).toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deviceId, "devA");
  assert.ok(rows[0].createdAt instanceof Date);
  assert.ok(Date.now() - rows[0].createdAt.getTime() < 5000);
  assert.equal(rows[0].t, 21);
});

test("non-object and invalid payloads are dropped", async () => {
  await handleDeviceMessage(db, "ts/devA/telemetry", Buffer.from("42"));
  await handleDeviceMessage(db, "ts/devA/telemetry", Buffer.from("[1,2]"));
  await handleDeviceMessage(db, "ts/devA/telemetry", Buffer.from("{not json"));
  await handleDeviceMessage(db, "ts/devA/telemetry", Buffer.alloc(70 * 1024, 32));
  assert.equal(await db.collection("device_telemetry").countDocuments(), 0);
});

test("first config claims the owner; later configs cannot change it", async () => {
  await handleDeviceMessage(db, "ts/dev1/config", msg({ user_id: "owner1", device: { user_id: "owner1", fw: "1" } }));
  let cfg = await db.collection("device_config").findOne({ _id: "dev1" });
  assert.equal(cfg.device.user_id, "owner1");
  assert.ok(cfg.ownerAssignedAt instanceof Date);

  await handleDeviceMessage(db, "ts/dev1/config", msg({ user_id: "attacker", device: { user_id: "attacker", fw: "2" } }));
  cfg = await db.collection("device_config").findOne({ _id: "dev1" });
  assert.equal(cfg.device.user_id, "owner1");
  assert.equal(cfg.user_id, "owner1");
  assert.equal(cfg.device.fw, "2", "other config fields still update");
});

test("admin lockout and admin transfer survive a config re-publish (device reboot)", async () => {
  await handleDeviceMessage(db, "ts/dev1/config", msg({ device: { user_id: "owner1" } }));
  await db
    .collection("device_config")
    .updateOne({ _id: "dev1" }, { $set: { isDisabled: true, disabledReason: "sparks", "device.user_id": "owner2" } });

  await handleDeviceMessage(db, "ts/dev1/config", msg({ isDisabled: false, device: { user_id: "owner1" } }));
  const cfg = await db.collection("device_config").findOne({ _id: "dev1" });
  assert.equal(cfg.isDisabled, true);
  assert.equal(cfg.disabledReason, "sparks");
  assert.equal(cfg.device.user_id, "owner2");
});

test("a device cannot lock/unlock itself on first publish", async () => {
  await handleDeviceMessage(db, "ts/dev9/config", msg({ isDisabled: true, device: { user_id: "o" } }));
  const cfg = await db.collection("device_config").findOne({ _id: "dev9" });
  assert.equal(cfg.isDisabled, undefined);
});

test("config re-publish resets actuators to firmware defaults (chosen reboot behaviour)", async () => {
  const config = { device: { user_id: "o" }, actuators: { relay1: { type: "relay", default: { state: "OFF", auto: true } } } };
  await handleDeviceMessage(db, "ts/dev1/config", msg(config));
  await db
    .collection("device_control")
    .updateOne({ _id: "dev1" }, { $set: { "actuators.relay1.state": "ON", "actuators.extra": { state: "ON" } } });

  await handleDeviceMessage(db, "ts/dev1/config", msg(config));
  const ctl = await db.collection("device_control").findOne({ _id: "dev1" });
  assert.equal(ctl.actuators.relay1.state, undefined, "relay1 back to its config definition");
  assert.deepEqual(ctl.actuators.extra, { state: "ON" }, "actuators not in config are kept");
});
