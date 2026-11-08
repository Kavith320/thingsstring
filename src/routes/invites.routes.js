// /api/invites — the invitee's side of device sharing
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth.middleware");
const { rateLimit, byIp } = require("../middleware/rateLimit");
const share = require("../controllers/sharing.controller");

const tokenPerIp = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, key: byIp("invite-token") });

router.post("/lookup", tokenPerIp, share.lookupInvite); // no login: shown on the invite page
router.post("/accept", requireAuth, tokenPerIp, share.acceptInviteByToken);
router.get("/", requireAuth, share.myInvites);
router.post("/:inviteId/accept", requireAuth, share.acceptInviteById);
router.post("/:inviteId/decline", requireAuth, share.declineInvite);

module.exports = router;
