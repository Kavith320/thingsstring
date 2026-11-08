const router = require("express").Router();
const { requireAuth } = require("../middleware/auth.middleware");
const { rateLimit } = require("../middleware/rateLimit");
const {
  listMyDevices,
  getDeviceById,
  getDeviceTelemetry,
  exportDeviceTelemetryCsv,
  updateDeviceControl
} = require("../controllers/devices.controller");
const { getDeviceUi, updateDeviceUi, getDeviceMap } = require("../controllers/customize.controller");

router.get("/", requireAuth, listMyDevices);
router.get("/map", requireAuth, getDeviceMap); // before /:deviceId
router.get("/:deviceId", requireAuth, getDeviceById);
router.get("/:deviceId/telemetry", requireAuth, getDeviceTelemetry);
// CSV export reads the whole history twice; cap it per user
const exportLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  key: (req) => `export:user:${req.user.id}`,
  message: "Too many exports, please wait a few minutes",
});
router.get("/:deviceId/telemetry/export", requireAuth, exportLimit, exportDeviceTelemetryCsv);
router.post("/:deviceId/control", requireAuth, updateDeviceControl);
router.get("/:deviceId/ui", requireAuth, getDeviceUi);
router.patch("/:deviceId/ui", requireAuth, updateDeviceUi);

module.exports = router;
