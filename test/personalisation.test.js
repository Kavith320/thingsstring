const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-uploads-"));
process.env.UPLOAD_DIR = tmp;

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
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => resetDb(db));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function upload(token, urlPath, bytes, method = "PUT", type = "image/png") {
  const res = await fetch(app.base + urlPath, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: bytes,
  });
  return { status: res.status, body: await res.json() };
}

/* ─────────────── Profile ─────────────── */

test("profile: read, update info, validation", async () => {
  const u = await createUser(app.api);
  let r = await app.api("GET", "/api/me", { token: u.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, u.email);
  assert.equal(r.body.user.hasPassword, true);
  assert.deepEqual(r.body.user.preferences, { theme: "system", accentColor: null, language: "en", timezone: null, units: "metric" });

  r = await app.api("PATCH", "/api/me", {
    token: u.token,
    body: { name: "  Kavith  ", phone: "+94 77 123 4567", organization: "Geek Agri", bio: "", avatar: "avatar:robot-3", email: "hacker@x.com", role: "admin" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, "Kavith");
  assert.equal(r.body.user.phone, "+94 77 123 4567");
  assert.equal(r.body.user.bio, null, "empty string clears");
  assert.equal(r.body.user.avatar, "avatar:robot-3");
  assert.equal(r.body.user.email, u.email, "email cannot be changed here");
  assert.equal(r.body.user.role, "user", "role cannot be changed here");

  for (const body of [{ name: "" }, { phone: "call me" }, { avatar: "javascript:alert(1)" }, { avatar: `file:${"a".repeat(32)}` }, {}]) {
    assert.equal((await app.api("PATCH", "/api/me", { token: u.token, body })).status, 400, JSON.stringify(body));
  }
});

test("preferences: theme, colour, timezone are validated", async () => {
  const u = await createUser(app.api);
  const r = await app.api("PATCH", "/api/me/preferences", {
    token: u.token,
    body: { theme: "dark", accentColor: "#22c55e", timezone: "Asia/Colombo", units: "imperial", language: "si-LK" },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.preferences, { theme: "dark", accentColor: "#22c55e", language: "si-LK", timezone: "Asia/Colombo", units: "imperial" });

  const login = await app.api("POST", "/api/auth/login", { body: { email: u.email, password: "password123" } });
  assert.equal(login.body.user.preferences.theme, "dark", "login returns preferences so the app can theme immediately");

  for (const body of [{ theme: "neon" }, { accentColor: "red" }, { timezone: "Mars/Base" }, { units: "furlongs" }]) {
    assert.equal((await app.api("PATCH", "/api/me/preferences", { token: u.token, body })).status, 400, JSON.stringify(body));
  }
});

test("password change needs the current password and logs out other sessions", async () => {
  const u = await createUser(app.api);
  let r = await app.api("PUT", "/api/me/password", { token: u.token, body: { currentPassword: "wrong", newPassword: "newpassword1" } });
  assert.equal(r.status, 400);
  r = await app.api("PUT", "/api/me/password", { token: u.token, body: { currentPassword: "password123", newPassword: "short" } });
  assert.equal(r.status, 400);

  r = await app.api("PUT", "/api/me/password", { token: u.token, body: { currentPassword: "password123", newPassword: "newpassword1" } });
  assert.equal(r.status, 200);
  assert.equal((await app.api("GET", "/api/me", { token: u.token })).status, 401, "old token revoked");
  assert.equal((await app.api("GET", "/api/me", { token: r.body.token })).status, 200, "new token works");
  const login = await app.api("POST", "/api/auth/login", { body: { email: u.email, password: "newpassword1" } });
  assert.equal(login.status, 200);
});

test("avatar upload: sniffed images only, served publicly, old avatar removed", async () => {
  const u = await createUser(app.api);
  assert.equal((await upload(u.token, "/api/me/avatar", SVG, "PUT", "image/png")).status, 400, "SVG disguised as PNG is rejected");
  assert.equal((await upload(u.token, "/api/me/avatar", Buffer.alloc(0))).status, 400);
  assert.equal((await upload(u.token, "/api/me/avatar", Buffer.alloc(3 * 1024 * 1024, 1))).status, 413);

  const first = await upload(u.token, "/api/me/avatar", PNG);
  assert.equal(first.status, 200);
  assert.match(first.body.user.avatar, /^file:[a-f0-9]{32}$/);

  const img = await fetch(app.base + first.body.file.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(img.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  const second = await upload(u.token, "/api/me/avatar", PNG);
  assert.equal((await fetch(app.base + first.body.file.url)).status, 404, "replaced avatar is deleted");
  assert.equal(fs.readdirSync(tmp).length, 1);

  await app.api("PATCH", "/api/me", { token: u.token, body: { avatar: "emoji:🦊" } });
  assert.equal((await fetch(app.base + second.body.file.url)).status, 404, "switching to a preset deletes the upload");
  assert.equal((await fetch(app.base + "/files/../../etc/passwd")).status, 404);
});

/* ─────────────── Device display settings ─────────────── */

test("device ui: rename, icon, colour, ordered sensors/actuators, location", async () => {
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "d1", alice.id);

  const body = {
    displayName: "Greenhouse Pump",
    icon: "mdi:water-pump",
    color: "#22c55e",
    sensors: [
      { key: "data.temp", label: "Temp", unit: "°C", pinned: true },
      { key: "rssi", visible: false },
    ],
    actuators: [{ key: "relay1", label: "Pump", icon: "emoji:💧" }],
    location: { lat: 6.9271, lng: 79.8612, label: "Colombo farm" },
  };
  let r = await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body });
  assert.equal(r.status, 200);
  assert.equal(r.body.ui.displayName, "Greenhouse Pump");
  assert.deepEqual(r.body.ui.sensors[0], { key: "data.temp", label: "Temp", unit: "°C", icon: null, color: null, visible: true, pinned: true });
  assert.equal(r.body.ui.sensors[1].visible, false);

  // partial update keeps the other fields
  r = await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body: { color: null } });
  assert.equal(r.body.ui.color, null);
  assert.equal(r.body.ui.displayName, "Greenhouse Pump");

  // included in the device list and details, with online status
  const list = await app.api("GET", "/api/devices", { token: alice.token });
  assert.equal(list.body.devices[0].ui.displayName, "Greenhouse Pump");
  assert.equal(list.body.devices[0].status.online, true);
  assert.ok(list.body.devices[0].status.lastSeen);
  const one = await app.api("GET", "/api/devices/d1", { token: alice.token });
  assert.equal(one.body.device.ui.actuators[0].label, "Pump");

  // map
  const map = await app.api("GET", "/api/devices/map", { token: alice.token });
  assert.equal(map.body.count, 1);
  assert.deepEqual(map.body.devices[0].location, { lat: 6.9271, lng: 79.8612, label: "Colombo farm", address: null });

  // other users
  assert.equal((await app.api("PATCH", "/api/devices/d1/ui", { token: bob.token, body })).status, 404);
  assert.equal((await app.api("GET", "/api/devices/d1/ui", { token: bob.token })).status, 404);
  assert.equal((await app.api("GET", "/api/devices/map", { token: bob.token })).body.count, 0);

  // validation
  for (const bad of [
    { color: "green" },
    { location: { lat: 91, lng: 0 } },
    { sensors: [{ key: "$where" }] },
    { sensors: [{ key: "t" }, { key: "t" }] },
    { actuators: [{ key: "a.b" }] },
    { icon: "<img>" },
    { displayName: "x".repeat(61) },
  ]) {
    assert.equal((await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body: bad })).status, 400, JSON.stringify(bad));
  }
});

test("device ui survives a device reboot (config re-publish)", async () => {
  const alice = await createUser(app.api);
  await createDevice(db, "d1", alice.id);
  await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body: { displayName: "Pump" } });

  const { handleDeviceMessage } = require("../src/mqtt/client");
  await handleDeviceMessage(db, "ts/d1/config", Buffer.from(JSON.stringify({ device: { user_id: alice.id }, actuators: {} })));
  const r = await app.api("GET", "/api/devices/d1/ui", { token: alice.token });
  assert.equal(r.body.ui.displayName, "Pump");
});

/* ─────────────── Custom icons ─────────────── */

test("custom icons: upload, use on a device/group, other users cannot use them", async () => {
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "d1", alice.id);
  await createDevice(db, "d2", bob.id);

  const up = await upload(alice.token, "/api/files/icons", PNG, "POST");
  assert.equal(up.status, 201);
  const ref = up.body.icon.ref;

  assert.equal((await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body: { icon: ref } })).status, 200);
  assert.equal((await app.api("PATCH", "/api/devices/d2/ui", { token: bob.token, body: { icon: ref } })).status, 400, "bob can't use alice's icon");
  assert.equal((await app.api("POST", "/api/groups", { token: alice.token, body: { name: "G", icon: ref } })).status, 201);

  assert.equal((await app.api("GET", "/api/files/icons", { token: alice.token })).body.count, 1);
  assert.equal((await app.api("DELETE", `/api/files/icons/${up.body.icon.id}`, { token: bob.token })).status, 404);
  assert.equal((await app.api("DELETE", `/api/files/icons/${up.body.icon.id}`, { token: alice.token })).status, 200);
  assert.equal((await fetch(app.base + up.body.icon.url)).status, 404);
});

/* ─────────────── Groups ─────────────── */

test("groups: create, edit, reorder, delete; only own devices", async () => {
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "d1", alice.id);
  await createDevice(db, "d2", alice.id);
  await createDevice(db, "b1", bob.id);

  let r = await app.api("POST", "/api/groups", {
    token: alice.token,
    body: { name: "Greenhouse", icon: "mdi:sprout", color: "#16a34a", deviceIds: ["d1", "d2", "d1"] },
  });
  assert.equal(r.status, 201);
  const g1 = r.body.group;
  assert.deepEqual(g1.deviceIds, ["d1", "d2"], "duplicates removed");

  const g2 = (await app.api("POST", "/api/groups", { token: alice.token, body: { name: "Barn" } })).body.group;
  assert.equal(g2.order, 1);

  assert.equal((await app.api("POST", "/api/groups", { token: alice.token, body: { name: "X", deviceIds: ["b1"] } })).status, 400, "bob's device");
  assert.equal((await app.api("POST", "/api/groups", { token: alice.token, body: {} })).status, 400, "name required");

  r = await app.api("PATCH", `/api/groups/${g1.id}`, { token: alice.token, body: { name: "Green House", deviceIds: ["d2"], collapsed: true } });
  assert.equal(r.body.group.name, "Green House");
  assert.deepEqual(r.body.group.deviceIds, ["d2"]);
  assert.equal((await app.api("PATCH", `/api/groups/${g1.id}`, { token: bob.token, body: { name: "mine" } })).status, 404);

  r = await app.api("PUT", "/api/groups/order", { token: alice.token, body: { groupIds: [g2.id, g1.id] } });
  assert.deepEqual(r.body.groups.map((g) => g.name), ["Barn", "Green House"]);
  assert.equal((await app.api("GET", "/api/groups", { token: bob.token })).body.count, 0);

  assert.equal((await app.api("DELETE", `/api/groups/${g1.id}`, { token: bob.token })).status, 404);
  assert.equal((await app.api("DELETE", `/api/groups/${g1.id}`, { token: alice.token })).status, 200);
  assert.equal((await app.api("GET", "/api/groups", { token: alice.token })).body.count, 1);
  assert.equal(await db.collection("device_config").countDocuments({ _id: { $in: ["d1", "d2"] } }), 2, "devices untouched");
});

/* ─────────────── Dashboard layout ─────────────── */

test("dashboard layout is stored as-is per user, with a size limit", async () => {
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  assert.equal((await app.api("GET", "/api/dashboard", { token: alice.token })).body.layout, null);

  const layout = { lg: [{ i: "d1", x: 0, y: 0, w: 4, h: 2 }], $weird: { "a.b": 1 } };
  assert.equal((await app.api("PUT", "/api/dashboard", { token: alice.token, body: { layout } })).status, 200);
  assert.deepEqual((await app.api("GET", "/api/dashboard", { token: alice.token })).body.layout, layout);
  assert.equal((await app.api("GET", "/api/dashboard", { token: bob.token })).body.layout, null);

  assert.equal((await app.api("PUT", "/api/dashboard", { token: alice.token, body: { layout: "x" } })).status, 400);
  const big = { data: "x".repeat(260 * 1024) };
  assert.equal((await app.api("PUT", "/api/dashboard", { token: alice.token, body: { layout: big } })).status, 400);
});

/* ─────────────── Admin cleanup ─────────────── */

test("admin transfer drops the old owner's settings; user delete removes everything", async () => {
  const admin = await createUser(app.api, { role: "admin" });
  const alice = await createUser(app.api);
  const bob = await createUser(app.api);
  await createDevice(db, "d1", alice.id);

  await app.api("PATCH", "/api/devices/d1/ui", { token: alice.token, body: { displayName: "Alice's pump", location: { lat: 1, lng: 2 } } });
  await app.api("POST", "/api/groups", { token: alice.token, body: { name: "G", deviceIds: ["d1"] } });
  await upload(alice.token, "/api/me/avatar", PNG);

  const t = await app.api("PUT", "/api/admin/devices/d1/transfer", { token: admin.token, body: { targetUserId: bob.id } });
  assert.equal(t.status, 200);
  assert.equal((await app.api("GET", "/api/devices/d1/ui", { token: bob.token })).body.ui.displayName, null, "new owner starts clean");
  assert.deepEqual((await app.api("GET", "/api/groups", { token: alice.token })).body.groups[0].deviceIds, []);

  assert.equal((await app.api("DELETE", `/api/admin/users/${alice.id}`, { token: admin.token })).status, 200);
  assert.equal(await db.collection("device_groups").countDocuments({ user_id: alice.id }), 0);
  assert.equal(await db.collection("files").countDocuments({ user_id: alice.id }), 0);
  assert.equal(fs.readdirSync(tmp).length, 0, "uploaded files removed from disk");
});
