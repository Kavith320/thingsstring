// src/middleware/auth.middleware.js
const { verifyToken } = require("../utils/jwt");
const User = require("../models/User");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ ok: false, error: "Missing Bearer token" });
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid/expired token" });
  }

  try {
    const user = await User.findById(decoded.sub).select("role isActive status email emailVerified userId8 tokenVersion");
    if (!user) {
      return res.status(401).json({ ok: false, error: "User account no longer exists" });
    }

    if (user.isActive === false || user.status === "disabled") {
      return res.status(403).json({ ok: false, error: "User account is suspended" });
    }

    // Tokens issued before a password reset / role change / Google link are revoked.
    // Tokens issued before tokenVersion existed carry no `tv` and count as version 0.
    if ((decoded.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ ok: false, error: "Session expired, please log in again" });
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      role: user.role,
      userId8: user.userId8,
      emailVerified: !!user.emailVerified,
    };
    return next();
  } catch (e) {
    console.error("❌ Auth lookup failed:", e);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
}

/** Use after requireAuth on actions that need a proven email (e.g. sharing devices). */
function requireVerifiedEmail(req, res, next) {
  if (req.user?.emailVerified) return next();
  return res.status(403).json({ ok: false, error: "Please verify your email address first", code: "EMAIL_NOT_VERIFIED" });
}

module.exports = { requireAuth, requireVerifiedEmail };
