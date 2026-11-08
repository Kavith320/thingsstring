const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startDb, stopDb, resetDb, startApp, createUser, createDevice } = require("./helpers");
const { csvCell, flatten } = require("../src/services/telemetryCsv");

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
const iso = (ms) => new Date(ms).toISOString();

async function download(token, deviceId, qs = "") {
  const res = await fetch(`${app.base}/api/devices/${deviceId}/telemetry/export${qs ? "?" + qs : ""}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString("utf8") };
}

/** Parse our CSV output (handles quoted cells) into rows of strings. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\r" && s[i + 1] === "\n") row.push(cell), rows.push(row), (row = []), (cell = ""), i++;
    else cell += c;
  }
  return rows;
}

test("exports every reading as CSV, oldest first, with flattened columns", async () => {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id, { online: false });
  await db.collection("device_telemetry").insertMany([
    { deviceId: "d1", createdAt: new Date(T0 + 2000), temp: 25, actuators: { relay1: { state: "OFF" } } },
    { deviceId: "d1", createdAt: new Date(T0), temp: 24.5, hum: 60, note: 'say "hi", ok', fw: "=cmd" },
    { deviceId: "d1", createdAt: new Date(T0 + 1000), rssi: -47, tags: [1, 2] },
    { deviceId: "other", createdAt: new Date(T0), temp: 999 },
  ]);

  const r = await download(alice.token, "d1");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/csv/);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="d1_telemetry_.*\.csv"$/);
  assert.ok(r.text.startsWith("﻿"), "BOM for Excel");

  const [header, ...rows] = parseCsv(r.text);
  assert.deepEqual(header, ["createdAt", "actuators.relay1.state", "fw", "hum", "note", "rssi", "tags", "temp"]);
  assert.equal(rows.length, 3, "other devices are not included");
  const col = (row, name) => row[header.indexOf(name)];

  assert.equal(col(rows[0], "createdAt"), iso(T0));
  assert.equal(col(rows[0], "note"), 'say "hi", ok', "quotes and commas survive");
  assert.equal(col(rows[0], "fw"), "'=cmd", "formula injection neutralised");
  assert.equal(col(rows[0], "rssi"), "", "missing values are empty");
  assert.equal(col(rows[1], "rssi"), "-47", "negative numbers are not escaped");
  assert.equal(col(rows[1], "tags"), "[1,2]");
  assert.equal(col(rows[2], "actuators.relay1.state"), "OFF");
});

test("from/to limit the export; bad input is 400; others' devices are 404", async () => {
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "d1", alice.id, { online: false });
  await db.collection("device_telemetry").insertMany(
    Array.from({ length: 10 }, (_, i) => ({ deviceId: "d1", createdAt: new Date(T0 + i * 1000), t: i }))
  );

  const r = await download(alice.token, "d1", `from=${iso(T0 + 3000)}&to=${T0 + 5000}`);
  const [, ...rows] = parseCsv(r.text);
  assert.deepEqual(rows.map((x) => x[1]), ["3", "4", "5"]);

  assert.equal((await download(alice.token, "d1", "from=yesterday")).status, 400);
  assert.equal((await download(alice.token, "d1", `from=${iso(T0 + 1)}&to=${iso(T0)}`)).status, 400);
  assert.equal((await download(bob.token, "d1")).status, 404);
  assert.equal((await download(null, "d1")).status, 401);
});

test("a device with no telemetry gives a header-only CSV", async () => {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id, { online: false });
  const r = await download(alice.token, "d1");
  assert.equal(r.status, 200);
  assert.deepEqual(parseCsv(r.text), [["createdAt"]]);
});

test("large export streams completely", async () => {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id, { online: false });
  const docs = Array.from({ length: 20000 }, (_, i) => ({
    deviceId: "d1",
    createdAt: new Date(T0 + i * 1000),
    t: i,
    h: 50.5,
  }));
  await db.collection("device_telemetry").insertMany(docs);

  const r = await download(alice.token, "d1");
  const [header, ...rows] = parseCsv(r.text);
  assert.deepEqual(header, ["createdAt", "h", "t"]);
  assert.equal(rows.length, 20000);
  assert.equal(rows.at(-1)[2], "19999");
});

test("csvCell / flatten unit cases", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(true), "true");
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.deepEqual(flatten({ _id: 1, deviceId: "x", a: { b: { c: 1 } }, e: {} }), { "a.b.c": 1, e: {} });
});
