const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");

let db;
let app;

before(async () => {
  db = await startDb();
  app = await startApp();
});
after(async () => {
  await app.close();
  await stopDb();
});
beforeEach(() => resetDb(db));

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** n docs, one per second from T0, with numeric + non-numeric fields. */
async function seed(deviceId, n) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({
      deviceId,
      createdAt: new Date(T0 + i * 1000),
      t: i,
      h: 50,
      fw: "1.0.0",
      online: true,
      actuators: { relay1: { state: "ON" } },
    });
  }
  await db.collection("device_telemetry").insertMany(docs);
}

async function owner() {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id, { online: false });
  return alice;
}

const get = (token, qs) => app.api("GET", `/api/devices/d1/telemetry?${qs}`, { token });
const iso = (ms) => new Date(ms).toISOString();

test("?limit=20 still returns the newest 20 raw docs, newest first", async () => {
  const alice = await owner();
  await seed("d1", 50);

  const r = await get(alice.token, "limit=20");
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 20);
  assert.deepEqual(
    r.body.telemetry.map((d) => d.t),
    Array.from({ length: 20 }, (_, i) => 49 - i)
  );
  assert.equal(r.body.telemetry[0].fw, "1.0.0", "raw docs keep every field");
  assert.equal(r.body.downsampled, undefined, "live polling response is unchanged");
});

test("a range with fewer than maxPoints docs returns raw docs oldest first", async () => {
  const alice = await owner();
  await seed("d1", 50);

  // seconds 10..19 inclusive; `to` as epoch ms
  const r = await get(alice.token, `from=${iso(T0 + 10_000)}&to=${T0 + 19_000}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.downsampled, false);
  assert.equal(r.body.bucketMs, null);
  assert.deepEqual(
    r.body.telemetry.map((d) => d.t),
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
  );
  assert.equal(r.body.telemetry[0].fw, "1.0.0", "raw docs keep every field");
  assert.equal(r.body.from, iso(T0 + 10_000));
  assert.equal(r.body.to, iso(T0 + 19_000));
  assert.equal(r.body.retentionDays, 7, "falls back to TELEMETRY_TTL_DAYS without a TTL index");
});

test("a large range is downsampled to <= maxPoints buckets with correct averages", async () => {
  const alice = await owner();
  await seed("d1", 100); // t = 0..99, one per second
  await db.collection("device_telemetry").insertOne({ deviceId: "other", createdAt: new Date(T0 + 5000), t: 999999 });

  // 100 s range, maxPoints 10 -> 10 s buckets of 10 docs each
  const r = await get(alice.token, `from=${iso(T0)}&to=${iso(T0 + 100_000)}&maxPoints=10`);
  assert.equal(r.status, 200);
  assert.equal(r.body.downsampled, true);
  assert.equal(r.body.bucketMs, 10_000);
  assert.ok(r.body.count <= 10);
  assert.equal(r.body.count, 10);

  const pts = r.body.telemetry;
  assert.equal(pts.reduce((s, p) => s + p.count, 0), 100, "every doc counted exactly once");
  pts.forEach((p, i) => {
    assert.equal(p.createdAt, iso(T0 + i * 10_000), "bucket start, ascending");
    assert.equal(p.count, 10);
    assert.equal(p.t, i * 10 + 4.5, "average of t in the bucket");
    assert.equal(p.h, 50);
    assert.deepEqual(Object.keys(p).sort(), ["count", "createdAt", "h", "t"], "non-numeric fields dropped");
  });
});

test("a doc exactly at 'to' lands in the last bucket (never more than maxPoints)", async () => {
  const alice = await owner();
  await seed("d1", 101); // t = 0..100, the last one exactly at `to`

  const r = await get(alice.token, `from=${iso(T0)}&to=${iso(T0 + 100_000)}&maxPoints=10`);
  assert.equal(r.body.count, 10);
  assert.equal(r.body.telemetry.reduce((s, p) => s + p.count, 0), 101);
  assert.equal(r.body.telemetry[9].count, 11);
});

test("maxPoints is clamped and retentionDays follows the TTL index", async () => {
  const alice = await owner();
  await seed("d1", 30);
  await db.collection("device_telemetry").createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });

  // maxPoints=1 clamps to 10 -> 30 docs over 29 s get downsampled
  const r = await get(alice.token, `from=${iso(T0)}&to=${iso(T0 + 29_000)}&maxPoints=1`);
  assert.equal(r.body.downsampled, true);
  assert.ok(r.body.count <= 10);
  assert.equal(r.body.retentionDays, 30);
});

test("invalid dates are 400, another user's device is 404", async () => {
  const alice = await owner();
  const bob = await createUser(app.api);

  assert.equal((await get(alice.token, "from=yesterday")).status, 400);
  assert.equal((await get(alice.token, `from=${iso(T0)}&to=not-a-date`)).status, 400);
  assert.equal((await get(alice.token, `from=${iso(T0 + 1000)}&to=${iso(T0)}`)).status, 400);
  assert.equal((await get(alice.token, `to=${iso(T0)}`)).status, 400);

  assert.equal((await get(bob.token, `from=${iso(T0)}`)).status, 404);
  assert.equal((await get(bob.token, "limit=20")).status, 404);
});
