const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // ✅ Stable short ID for IoT (always required)
    userId8: { type: String, unique: true, required: true, index: true },

    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, unique: true, required: true },

    // ✅ Local auth (optional for Google users)
    passwordHash: { type: String, required: false },

    // ✅ Google auth fields
    authProvider: { type: String, enum: ["local", "google"], default: "local" },
    googleId: { type: String, index: true },
    emailVerified: { type: Boolean, default: false },

    role: { type: String, enum: ["user", "admin"], default: "user" },
    isActive: { type: Boolean, default: true },
    status: { type: String, enum: ["active", "disabled"], default: "active" },

    // Bumped to revoke every token issued before (password reset, role change, ...)
    tokenVersion: { type: Number, default: 0 },

    // Profile (editable by the user via /api/me)
    phone: { type: String, default: null },
    organization: { type: String, default: null },
    country: { type: String, default: null },
    bio: { type: String, default: null },
    // "avatar:robot-3" (built-in set), "emoji:🦊", or "file:<id>" (uploaded, served at /files/<id>)
    avatar: { type: String, default: null },

    // Optional notification emails (security and account notices are always sent)
    notifications: {
      deviceOffline: { type: Boolean, default: true },
      automation: { type: Boolean, default: true },
      weeklyReport: { type: Boolean, default: true },
    },

    preferences: {
      theme: { type: String, enum: ["light", "dark", "system"], default: "system" },
      accentColor: { type: String, default: null },
      language: { type: String, default: "en" },
      timezone: { type: String, default: null },
      units: { type: String, enum: ["metric", "imperial"], default: "metric" },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
