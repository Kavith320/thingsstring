// src/utils/jwt.js
const jwt = require("jsonwebtoken");

const ALGORITHM = "HS256";
const PLACEHOLDER_SECRETS = new Set(["change_this_to_a_long_random_string", "secret", "changeme"]);

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing in .env");
  return secret;
}

/** Warn loudly at startup when the signing secret is weak — anyone who knows it can forge admin tokens. */
function checkJwtSecretStrength() {
  const secret = process.env.JWT_SECRET || "";
  if (PLACEHOLDER_SECRETS.has(secret) || secret.length < 32) {
    console.warn(
      "🚨 SECURITY: JWT_SECRET is a placeholder or shorter than 32 characters. Anyone who knows it can " +
        "log in as any user, including admins. Generate one with `openssl rand -hex 32`."
    );
    return false;
  }
  return true;
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), {
    algorithm: ALGORITHM,
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
}

module.exports = { signToken, verifyToken, checkJwtSecretStrength };
