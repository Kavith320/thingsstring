// test/helpers.js — throwaway in-memory MongoDB + HTTP app for tests.
// Never reads .env: every setting the code needs is set here.
const { MongoMemoryReplSet } = require("mongodb-memory-server");

process.env.JWT_SECRET = "test-secret-0123456789abcdef0123456789abcdef";
process.env.JWT_EXPIRES_IN = "1h";
process.env.DEVICE_OFFLINE_THRESHOLD_SEC = "300";

let replSet;

async function startDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URI = replSet.getUri("thingsstring_test");
  const { connectMongo, getDb } = require("../src/db/mongo");
  await connectMongo(1, 100);
  return getDb();
}

async function stopDb() {
  const { closeMongo } = require("../src/db/mongo");
  await closeMongo();
  if (replSet) await replSet.stop();
}

async function resetDb(db) {
  const cols = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(cols.map((c) => db.collection(c.name).deleteMany({})));
}

async function startApp() {
  const { createApp } = require("../src/app");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, body: json };
  }

  return { api, base, close: () => new Promise((r) => server.close(r)) };
}

let emailCounter = 0;
async function createUser(api, { role } = {}) {
  const email = `user${++emailCounter}-${Date.now()}@example.com`;
  const res = await api("POST", "/api/auth/register", { body: { name: "Test", email, password: "password123" } });
  if (res.status !== 201) throw new Error("register failed: " + JSON.stringify(res.body));
  let { token, user } = res.body;
  if (role === "admin") {
    const User = require("../src/models/User");
    await User.updateOne({ _id: user.id }, { $set: { role: "admin" } });
    const login = await api("POST", "/api/auth/login", { body: { email, password: "password123" } });
    token = login.body.token;
  }
  return { token, id: String(user.id), email };
}

/** Insert a device owned by userId, with a relay in AUTO mode and fresh telemetry. */
async function createDevice(db, deviceId, userId, { online = true, auto = true } = {}) {
  await db.collection("device_config").insertOne({
    _id: deviceId,
    user_id: userId,
    device: { device_id: deviceId, user_id: userId },
    actuators: { relay1: { type: "relay", default: { state: "OFF", auto } } },
  });
  await db.collection("device_control").insertOne({
    _id: deviceId,
    actuators: { relay1: { type: "relay", default: { state: "OFF", auto } } },
  });
  if (online) {
    await db.collection("device_telemetry").insertOne({ deviceId, createdAt: new Date(), t: 25, data: { temp: 31 } });
  }
}

module.exports = { startDb, stopDb, resetDb, startApp, createUser, createDevice };
