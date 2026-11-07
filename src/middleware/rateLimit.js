// src/middleware/rateLimit.js
// Small in-memory fixed-window rate limiter (single API process).
// Keyed by a caller-supplied function, e.g. client IP or the email being logged into.

function rateLimit({ windowMs, max, key, message = "Too many attempts, please try again later" }) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return function rateLimitMiddleware(req, res, next) {
    const k = key(req);
    if (!k) return next();

    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;

    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: message });
    }
    return next();
  };
}

const byIp = (prefix) => (req) => `${prefix}:ip:${req.ip}`;
const byEmail = (prefix) => (req) => {
  const email = req.body?.email;
  return typeof email === "string" ? `${prefix}:email:${email.trim().toLowerCase()}` : null;
};

module.exports = { rateLimit, byIp, byEmail };
