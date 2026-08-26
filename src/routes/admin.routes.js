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
    getSystemHealth,
    updateUserRole,
    resetUserPassword,
    toggleDeviceLockout,
    broadcastDeviceControl,
    setUserStatus,
    transferDeviceOwnership,
    getAllAutomationFlows,
    toggleAutomationFlow,
    deleteAutomationFlow,
    getGlobalAutomationLogs,
    triggerDatabaseBackup,
    triggerTelemetryCleanup,
    getAuditLogs,
} = require("../controllers/admin.controller");

// ✅ Protect all admin routes
router.use(requireAuth, requireAdmin);

// System Health & Stats
router.get("/stats", getSystemStats);
router.get("/health", getSystemHealth);

// User Management & Access Control
router.get("/users", getAllUsers);
router.put("/users/:userId/role", updateUserRole);
router.put("/users/:userId/status", setUserStatus);
router.post("/users/:userId/reset-password", resetUserPassword);
router.delete("/users/:userId", deleteUser);

// Device Management, Transfers & Emergency Controls
router.get("/devices", getAllDevices);
router.delete("/devices/:deviceId", deleteDevice);
router.get("/devices/:deviceId", getDeviceDetails);
router.post("/devices/:deviceId/control", controlDevice);
router.post("/devices/:deviceId/lockout", toggleDeviceLockout);
router.put("/devices/:deviceId/transfer", transferDeviceOwnership);
router.get("/devices/:deviceId/telemetry", getDeviceTelemetryHistory);

// Automation Rule Oversight & Management
router.get("/automation/flows", getAllAutomationFlows);
router.put("/automation/flows/:flowId/toggle", toggleAutomationFlow);
router.delete("/automation/flows/:flowId", deleteAutomationFlow);
router.get("/automation/logs", getGlobalAutomationLogs);

// On-Demand Maintenance & Backups
router.post("/maintenance/backup", triggerDatabaseBackup);
router.post("/maintenance/clean-telemetry", triggerTelemetryCleanup);

// Audit Logging
router.get("/audit-logs", getAuditLogs);

// Mass / Broadcast Controls
router.post("/broadcast/control", broadcastDeviceControl);

// Schedule Management
router.get("/schedules", getAllSchedules);
router.delete("/schedules/:scheduleId", deleteSchedule);

module.exports = router;
