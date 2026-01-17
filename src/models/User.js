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

    role: { type: String, default: "user" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
