// src/models/User.js
const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    userId8: { type: String, unique: true, required: true }, // ✅ 8-digit id as string

    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, unique: true, required: true },
    passwordHash: { type: String, required: true },

    role: { type: String, default: "user" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
