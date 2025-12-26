require("dotenv").config();
const express = require("express");

const { connectMongo } = require("./db/mongo");
const { startMqtt } = require("./mqtt/client");
const scheduleRoutes = require("./routes/schedules.routes");

const {
  publishAllControlsOnce,
  watchControlChanges,
} = require("./services/controlPublisher");

// routes
const authRoutes = require("./routes/auth.routes");
const deviceRoutes = require("./routes/devices.routes");

const app = express();

// body parser
app.use(express.json());

// health check
app.get("/", (req, res) => res.json({ ok: true }));

// mount routes
app.use("/api/auth", authRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/schedules", scheduleRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);

  await connectMongo();
  startMqtt();

  await publishAllControlsOnce();
  await watchControlChanges();
});
