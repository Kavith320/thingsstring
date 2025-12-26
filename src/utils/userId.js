// src/utils/userId.js
const User = require("../models/User");

function random8Digits() {
  // 00000000 - 99999999 (string with leading zeros)
  return Math.floor(Math.random() * 100000000).toString().padStart(8, "0");
}

async function generateUniqueUserId8() {
  // Retry a few times (very low collision chance, but we guarantee uniqueness)
  for (let i = 0; i < 20; i++) {
    const id = random8Digits();
    const exists = await User.findOne({ userId8: id }).select("_id").lean();
    if (!exists) return id;
  }
  throw new Error("Failed to generate unique 8-digit user id");
}

module.exports = { generateUniqueUserId8 };
