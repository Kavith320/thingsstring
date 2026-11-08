const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { rateLimit } = require("../middleware/rateLimit");
const { MAX_IMAGE_BYTES } = require("../services/fileStore");
const c = require("../controllers/profile.controller");
const { requestEmailChange } = require("../controllers/email.controller");

const router = express.Router();
const MIN = 60 * 1000;
const byUser = (prefix) => (req) => `${prefix}:user:${req.user.id}`;

const uploadLimit = rateLimit({ windowMs: 10 * MIN, max: 30, key: byUser("upload"), message: "Too many uploads, please wait a few minutes" });
const passwordLimit = rateLimit({ windowMs: 15 * MIN, max: 10, key: byUser("password") });
// Raw image bytes; parsed only after auth so anonymous uploads are never buffered
const rawImage = express.raw({ type: "*/*", limit: MAX_IMAGE_BYTES });

router.get("/", requireAuth, c.getProfile);
router.patch("/", requireAuth, c.updateProfile);
router.patch("/preferences", requireAuth, c.updatePreferences);
router.put("/password", requireAuth, passwordLimit, c.changePassword);
const emailChangeLimit = rateLimit({ windowMs: 60 * MIN, max: 5, key: byUser("email-change") });
router.post("/email", requireAuth, emailChangeLimit, requestEmailChange);
router.put("/avatar", requireAuth, uploadLimit, rawImage, c.uploadAvatar);
router.delete("/avatar", requireAuth, c.removeAvatar);

module.exports = router;
