const router = require("express").Router();
const { register, login, me, googleAuth } = require("../controllers/auth.controller");
const emailCtl = require("../controllers/email.controller");
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

// Email-based account operations. Strict limits: each one sends an email.
const forgotPerEmail = rateLimit({ windowMs: 60 * MIN, max: 3, key: byEmail("forgot"), message: "Too many reset emails, try again later" });
const forgotPerIp = rateLimit({ windowMs: 60 * MIN, max: 20, key: byIp("forgot") });
const resendPerUser = rateLimit({ windowMs: 60 * MIN, max: 5, key: (req) => `verify:user:${req.user.id}`, message: "Too many verification emails, try again later" });
const tokenPerIp = rateLimit({ windowMs: 15 * MIN, max: 50, key: byIp("email-token") });

router.post("/verify-email/send", requireAuth, resendPerUser, emailCtl.resendVerification);
router.post("/verify-email", tokenPerIp, emailCtl.verifyEmail);
router.post("/forgot-password", forgotPerIp, forgotPerEmail, emailCtl.forgotPassword);
router.post("/reset-password", tokenPerIp, emailCtl.resetPassword);
router.post("/confirm-email", tokenPerIp, emailCtl.confirmEmailChange);

module.exports = router;
