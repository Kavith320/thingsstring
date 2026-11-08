const router = require("express").Router();
const { requireAuth, requireVerifiedEmail } = require("../middleware/auth.middleware");
const share = require("../controllers/sharing.controller");
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

// Sharing (members + invitations), personal alert settings, activity history
router.get("/:deviceId/members", requireAuth, share.listMembers);
router.patch("/:deviceId/members/:userId", requireAuth, share.changeMemberRole);
router.delete("/:deviceId/members/:userId", requireAuth, share.removeMember);
router.post("/:deviceId/invites", requireAuth, requireVerifiedEmail, share.createInvite);
router.delete("/:deviceId/invites/:inviteId", requireAuth, share.cancelInvite);
router.get("/:deviceId/alerts", requireAuth, share.getAlerts);
router.put("/:deviceId/alerts", requireAuth, share.updateAlerts);
router.get("/:deviceId/activity", requireAuth, share.getActivity);
router.patch("/:deviceId/ui", requireAuth, updateDeviceUi);

module.exports = router;
