// Wall display: /api/wall (owner, logged in) and /api/public/wall (screen, no login)
const express = require("express");
const { requireAuth, requireVerifiedEmail } = require("../middleware/auth.middleware");
const { rateLimit, byIp } = require("../middleware/rateLimit");
const c = require("../controllers/wall.controller");

const ownerWrites = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  key: (req) => `wall:user:${req.user.id}`,
  message: "Too many changes, please wait a few minutes",
});

const owner = express.Router();
owner.get("/", requireAuth, c.getWall);
owner.put("/", requireAuth, ownerWrites, c.saveWall);
// A public link shows data to anyone: only for accounts with a confirmed email
owner.post("/link", requireAuth, requireVerifiedEmail, ownerWrites, c.createLink);
owner.delete("/link", requireAuth, c.deleteLink);
owner.put("/pin", requireAuth, ownerWrites, c.setPin);
owner.delete("/pin", requireAuth, c.clearPin);

const pub = express.Router();
pub.post("/session", rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: byIp("wall-session") }), c.createSession);
pub.get("/stream", rateLimit({ windowMs: 60 * 1000, max: 30, key: byIp("wall-stream") }), c.stream);
pub.get("/snapshot", rateLimit({ windowMs: 60 * 1000, max: 240, key: byIp("wall-snapshot") }), c.snapshot);

module.exports = { owner, public: pub };
