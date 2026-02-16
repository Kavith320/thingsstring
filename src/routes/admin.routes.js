const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth.middleware");
const { requireAdmin } = require("../middleware/admin.middleware");
const {
    getSystemStats,
    getAllUsers,
    deleteUser,
    getAllDevices,
    deleteDevice,
    getAllSchedules,
    deleteSchedule,
    getDeviceDetails,
    controlDevice,
    getDeviceTelemetryHistory,
} = require("../controllers/admin.controller");

// ✅ Protect all admin routes
router.use(requireAuth, requireAdmin);

// System Stats
router.get("/stats", getSystemStats);

// User Management
router.get("/users", getAllUsers);
router.delete("/users/:userId", deleteUser);

// Device Management
router.get("/devices", getAllDevices);
router.delete("/devices/:deviceId", deleteDevice);
router.get("/devices/:deviceId", getDeviceDetails);
router.post("/devices/:deviceId/control", controlDevice);
router.get("/devices/:deviceId/telemetry", getDeviceTelemetryHistory);

// Schedule Management
router.get("/schedules", getAllSchedules);
router.delete("/schedules/:scheduleId", deleteSchedule);

module.exports = router;
