// src/middleware/auth.middleware.js
const { verifyToken } = require("../utils/jwt");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ ok: false, error: "Missing Bearer token" });
  }

  try {
    const decoded = verifyToken(token);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      userId8: decoded.userId8,
    };
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid/expired token" });
  }
}

module.exports = { requireAuth };
