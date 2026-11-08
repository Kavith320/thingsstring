// src/app.js — the Express app (no network/DB side effects, so tests can import it)
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const deviceRoutes = require("./routes/devices.routes");
const scheduleRoutes = require("./routes/schedules.routes");
const adminRoutes = require("./routes/admin.routes");
const automationRoutes = require("./routes/automation.routes");
const profileRoutes = require("./routes/profile.routes");
const customizeRoutes = require("./routes/customize.routes");
const inviteRoutes = require("./routes/invites.routes");
const { serveFile } = require("./services/fileStore");
const { getDb } = require("./db/mongo");

function parseTrustProxy(v) {
  if (v === undefined || v === "") return false;
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return Number.isInteger(n) ? n : v; // hop count, or a subnet list like "loopback"
}

function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Behind a reverse proxy (nginx, Render, Railway...) set TRUST_PROXY=1 so
  // rate limiting and audit logs see the real client IP.
  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

  // CORS: CORS_ORIGINS="https://app.example.com,https://admin.example.com" (default: any origin).
  // Auth uses Bearer tokens, not cookies, so a wildcard does not expose sessions.
  const origins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: origins.length ? origins : "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  app.use(express.json({ limit: "300kb" }));

  app.get("/", (req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRoutes);
  app.use("/api/devices", deviceRoutes);
  app.use("/api/schedules", scheduleRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/automation", automationRoutes);
  app.use("/api/me", profileRoutes);
  app.use("/api/groups", customizeRoutes.groups);
  app.use("/api/dashboard", customizeRoutes.dashboard);
  app.use("/api/files", customizeRoutes.files);
  app.use("/api/invites", inviteRoutes);

  // Uploaded images (avatars, icons): public, unguessable ids, usable in <img src>
  app.get("/files/:id", (req, res, next) => serveFile(getDb(), req, res).catch(next));

  app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

  // Malformed JSON, oversized bodies, and anything thrown that a handler didn't catch
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    if (err.type === "entity.too.large") return res.status(413).json({ ok: false, error: "Request body too large" });
    console.error("❌ Unhandled request error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  });

  return app;
}

module.exports = { createApp };
