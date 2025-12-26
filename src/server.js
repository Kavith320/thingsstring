require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { connectMongo } = require("./db/mongo");
const { startMqtt } = require("./mqtt/client");
const {
  publishAllControlsOnce,
  watchControlChanges,
} = require("./services/controlPublisher");

const authRoutes = require("./routes/auth.routes");
const deviceRoutes = require("./routes/devices.routes");
const scheduleRoutes = require("./routes/schedules.routes"); // if you have it

const app = express(); // ✅ must be BEFORE app.use()

// ✅ CORS (temporary allow all)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ JSON body parser
app.use(express.json());

// ✅ routes
app.get("/", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/schedules", scheduleRoutes); // comment if you don’t have schedules.routes.js

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);

  // 1) Connect DB
  await connectMongo();

  // 2) Connect MQTT
  startMqtt();

  // 3) Publish current control state once (retain)
  await publishAllControlsOnce();

  // 4) Watch control updates (real-time)
  await watchControlChanges();
});
