// src/services/emailTokens.js
// One-time tokens for email links (verify email, reset password, change email).
// Only a SHA-256 hash is stored, so a database leak gives no usable links.
// Expired tokens are removed by a TTL index on expiresAt.

const crypto = require("node:crypto");

const COL = "email_tokens";

const PURPOSES = {
  verifyEmail: 24 * 3600e3,
  resetPassword: 30 * 60e3,
  changeEmail: 24 * 3600e3,
};

const hash = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

/** Create a token; any earlier unused token of the same purpose for the user is revoked. */
async function createToken(db, { userId, purpose, data = {} }) {
  const ttl = PURPOSES[purpose];
  if (!ttl) throw new Error(`Unknown token purpose '${purpose}'`);
  const col = db.collection(COL);
  const raw = crypto.randomBytes(32).toString("base64url");
  await col.deleteMany({ userId: String(userId), purpose });
  await col.insertOne({
    _id: hash(raw),
    userId: String(userId),
    purpose,
    data,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ttl),
  });
  return raw;
}

/** Use a token once. Returns { userId, data } or null if unknown, expired or already used. */
async function consumeToken(db, raw, purpose) {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 200) return null;
  const doc = await db.collection(COL).findOneAndDelete({ _id: hash(raw), purpose, expiresAt: { $gt: new Date() } });
  return doc ? { userId: doc.userId, data: doc.data || {} } : null;
}

async function revokeTokens(db, userId, purpose) {
  await db.collection(COL).deleteMany({ userId: String(userId), ...(purpose ? { purpose } : {}) });
}

module.exports = { createToken, consumeToken, revokeTokens };
