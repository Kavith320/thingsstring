const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongoose").Types;
const { startDb, stopDb, resetDb, createDevice } = require("./helpers");

let db;
let runFlow;

before(async () => {
  db = await startDb();
  ({ runFlow } = require("../src/automation/flowJobs"));
});
after(stopDb);
beforeEach(() => resetDb(db));

async function addFlow(overrides = {}) {
  const flow = {
    user_id: "u1",
    name: "f",
    deviceId: "dev1",
    enabled: true,
    intervalSec: 30,
    metricPath: "data.temp",
    condition: { operator: ">", value: 30 },
    action: { deviceId: "dev1", actuatorKey: "relay1", setValue: true },
    cooldownSec: 0,
    ...overrides,
  };
  const { insertedId } = await db.collection("automation_flows").insertOne(flow);
  return insertedId;
}
const lastLog = () => db.collection("automation_flow_logs").find({}).sort({ _id: -1 }).limit(1).next();
const relay = async (id = "dev1") => (await db.collection("device_control").findOne({ _id: id })).actuators.relay1;

test("condition met → writes ON in the device's own format and logs 'ran' with deviceId", async () => {
  await createDevice(db, "dev1", "u1");
  const id = await addFlow();
  await runFlow(db, id);
  assert.equal((await relay()).state, "ON");
  assert.equal((await relay()).value, true);
  const log = await lastLog();
  assert.equal(log.status, "ran");
  assert.equal(log.deviceId, "dev1");
});

test("missing metric never triggers, even with '!='", async () => {
  await createDevice(db, "dev1", "u1");
  const id = await addFlow({ metricPath: "data.nope", condition: { operator: "!=", value: 5 } });
  await runFlow(db, id);
  assert.equal((await relay()).state, undefined);
  assert.match((await lastLog()).reason, /not in telemetry/);
});

test("flow is blocked when its owner no longer owns the target device", async () => {
  await createDevice(db, "dev1", "u1");
  await createDevice(db, "victim", "someone-else");
  const id = await addFlow({ action: { deviceId: "victim", actuatorKey: "relay1", setValue: true } });
  await runFlow(db, id);
  assert.equal((await relay("victim")).state, undefined);
  assert.equal((await lastLog()).reason, "flow owner does not own device");
});

test("offline sensor, locked target and manual mode are all skipped", async () => {
  await createDevice(db, "dev1", "u1", { online: false });
  let id = await addFlow();
  await runFlow(db, id);
  assert.equal((await lastLog()).reason, "no telemetry");

  await resetDb(db);
  await createDevice(db, "dev1", "u1");
  await db.collection("device_config").updateOne({ _id: "dev1" }, { $set: { isDisabled: true } });
  id = await addFlow();
  await runFlow(db, id);
  assert.equal((await lastLog()).reason, "device locked out by admin");

  await resetDb(db);
  await createDevice(db, "dev1", "u1", { auto: true });
  // user switched the relay to manual: live `auto:false` overrides `default.auto:true`
  await db.collection("device_control").updateOne({ _id: "dev1" }, { $set: { "actuators.relay1.auto": false } });
  id = await addFlow();
  await runFlow(db, id);
  assert.equal((await lastLog()).reason, "manual mode");
});

test("flowSync: flows with long intervals actually run (regression: they never ran)", { timeout: 30000 }, async () => {
  const Agenda = require("agenda");
  const { startFlowSync } = require("../src/automation/flowSync");
  const ids = await db.collection("automation_flows").insertMany([
    { enabled: true, intervalSec: 2 },
    { enabled: true, intervalSec: 4 },
  ]);
  const runs = {};
  const agenda = new Agenda({ db: { address: process.env.MONGO_URI, collection: "automation_jobs" }, processEvery: "1 second" });
  agenda.define("run_automation_flow", async (job) => {
    runs[job.attrs.data.flowId] = (runs[job.attrs.data.flowId] || 0) + 1;
  });
  await agenda.start();
  // Sync much more often than the intervals — the old code reset nextRunAt on every sync
  const timer = await startFlowSync(agenda, { intervalMs: 300 });
  await new Promise((r) => setTimeout(r, 10500));
  clearInterval(timer);
  await agenda.stop();
  await agenda.close();

  const [a, b] = Object.values(ids.insertedIds).map(String);
  assert.ok(runs[a] >= 3, `2s flow ran ${runs[a]} times`);
  assert.ok(runs[b] >= 1, `4s flow ran ${runs[b]} times`);
  assert.equal(await db.collection("automation_jobs").countDocuments({ name: "run_automation_flow" }), 2);
});

test("scheduler: END actions apply while offline, START actions don't; lockout blocks both", async () => {
  const { applyActions } = require("../src/scheduler/jobs");
  const on = [{ actuator: "relay1", set: { state: "ON" } }];
  const off = [{ actuator: "relay1", set: { state: "OFF" } }];

  await createDevice(db, "dev1", "u1", { online: false });
  assert.equal(await applyActions("dev1", on, { phase: "start" }), "offline");
  assert.equal(await applyActions("dev1", off, { phase: "end" }), "applied");
  assert.equal((await relay()).state, "OFF");

  await db.collection("device_config").updateOne({ _id: "dev1" }, { $set: { isDisabled: true } });
  assert.equal(await applyActions("dev1", off, { phase: "end" }), "locked");
});

test("scheduler sync: invalid cron is not scheduled, unchanged schedules are not re-saved", { timeout: 15000 }, async () => {
  const Agenda = require("agenda");
  const { startScheduleSync } = require("../src/scheduler/scheduleSync");
  await db.collection("device_schedules").insertMany([
    { _id: new ObjectId(), deviceId: "d", enabled: true, cron: "0 8 * * *", timezone: "UTC", actions: [] },
    { _id: new ObjectId(), deviceId: "d", enabled: true, cron: "not a cron", timezone: "UTC", actions: [] },
  ]);
  const agenda = new Agenda({ db: { address: process.env.MONGO_URI, collection: "agenda_jobs" }, processEvery: "1 second" });
  agenda.define("run-device-schedule", async () => {});
  await agenda.start();
  const timer = await startScheduleSync(agenda, { intervalMs: 200 });
  const first = await db.collection("agenda_jobs").findOne({ name: "run-device-schedule" });
  await new Promise((r) => setTimeout(r, 1200));
  clearInterval(timer);
  await agenda.stop();
  await agenda.close();
  const jobs = await db.collection("agenda_jobs").find({ name: "run-device-schedule" }).toArray();
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].lastModifiedBy, first.lastModifiedBy);
  assert.equal(jobs[0].nextRunAt.getTime(), first.nextRunAt.getTime());
});
