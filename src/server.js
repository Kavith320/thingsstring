require("dotenv").config({ quiet: true });

const { createApp } = require("./app");
const { connectMongo, getDb, closeMongo } = require("./db/mongo");
const { ensureIndexes } = require("./db/indexes");
const { startMqtt, stopMqtt } = require("./mqtt/client");
const { publishAllControlsOnce, watchControlChanges, stopWatching } = require("./services/controlPublisher");
const { checkJwtSecretStrength } = require("./utils/jwt");

process.on("unhandledRejection", (err) => console.error("❌ Unhandled promise rejection:", err));

async function main() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing in .env");
  checkJwtSecretStrength();

  // 1) DB first, so no request ever hits "MongoDB not ready yet"
  await connectMongo();
  await ensureIndexes(getDb());

  // 2) MQTT. This is the ONLY process that ingests device messages and publishes
  //    control state. Every (re)connect republishes every device's desired state,
  //    so commands made while MQTT was down are delivered when it comes back.
  startMqtt({ role: "api", subscribe: true, onConnect: publishAllControlsOnce });

  // 3) Publish device_control changes made by any process (API, scheduler, automation)
  await watchControlChanges();

  // 4) HTTP
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${signal} received, shutting down...`);
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close();
    await stopWatching();
    await stopMqtt();
    await closeMongo();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("❌ Server failed to start:", e);
  process.exit(1);
});
