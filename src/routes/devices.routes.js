const router = require("express").Router();
const { requireAuth } = require("../middleware/auth.middleware");
const {
  listMyDevices,
  getDeviceById,
  getDeviceTelemetry,
  updateDeviceControl
} = require("../controllers/devices.controller");

router.get("/", requireAuth, listMyDevices);
router.get("/:deviceId", requireAuth, getDeviceById);
router.get("/:deviceId/telemetry", requireAuth, getDeviceTelemetry);
router.post("/:deviceId/control", requireAuth, updateDeviceControl);

module.exports = router;
