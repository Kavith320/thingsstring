const router = require("express").Router();
const { register, login, me, googleAuth } = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { rateLimit, byIp, byEmail } = require("../middleware/rateLimit");

const MIN = 60 * 1000;

// Brute-force protection: per targeted account, plus a generous per-IP ceiling
// (generous because users behind one NAT/proxy share an IP).
const loginPerEmail = rateLimit({ windowMs: 15 * MIN, max: 10, key: byEmail("login") });
const loginPerIp = rateLimit({ windowMs: 15 * MIN, max: 100, key: byIp("login") });
const registerPerIp = rateLimit({ windowMs: 60 * MIN, max: 20, key: byIp("register") });
const googlePerIp = rateLimit({ windowMs: 15 * MIN, max: 100, key: byIp("google") });

router.post("/register", registerPerIp, register);
router.post("/login", loginPerIp, loginPerEmail, login);
router.post("/google", googlePerIp, googleAuth);

router.get("/me", requireAuth, me);

module.exports = router;
