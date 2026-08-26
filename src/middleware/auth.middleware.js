// src/middleware/auth.middleware.js
const { verifyToken } = require("../utils/jwt");
const User = require("../models/User");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ ok: false, error: "Missing Bearer token" });
  }

  try {
    const decoded = verifyToken(token);

    const user = await User.findById(decoded.sub).select("role isActive status email userId8");
    if (!user) {
      return res.status(401).json({ ok: false, error: "User account no longer exists" });
    }

    if (user.isActive === false || user.status === "disabled") {
      return res.status(403).json({ ok: false, error: "User account is suspended" });
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      role: user.role,
      userId8: user.userId8,
    };
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid/expired token" });
  }
}

module.exports = { requireAuth };
