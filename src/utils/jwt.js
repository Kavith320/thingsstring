// src/utils/jwt.js
const jwt = require("jsonwebtoken");

function signToken(payload) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing in .env");

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function verifyToken(token) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing in .env");
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { signToken, verifyToken };
