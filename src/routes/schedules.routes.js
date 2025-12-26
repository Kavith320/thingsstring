// src/routes/schedules.routes.js
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth.middleware");

const {
  createDeviceSchedule,
  listDeviceSchedules,
  updateSchedule,
  deleteSchedule,
} = require("../controllers/schedules.controller");

// Device scoped
router.post("/devices/:deviceId/schedules", requireAuth, createDeviceSchedule);
router.get("/devices/:deviceId/schedules", requireAuth, listDeviceSchedules);

// Schedule scoped
router.put("/:scheduleId", requireAuth, updateSchedule);
router.delete("/:scheduleId", requireAuth, deleteSchedule);

module.exports = router;
