const router = require("express").Router();
const { register, login, me, googleAuth } = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth.middleware");

router.post("/register", register);
router.post("/login", login);
router.post("/google", googleAuth);

router.get("/me", requireAuth, me);

module.exports = router;
