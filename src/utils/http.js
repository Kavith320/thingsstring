// src/utils/http.js
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

/**
 * Log the real error server-side and return a generic 500 to the client,
 * so database/driver internals are never leaked in API responses.
 */
function sendServerError(res, err, context = "") {
  console.error(`❌ ${context || "Request"} failed:`, err);
  return res.status(500).json({ ok: false, error: "Internal server error" });
}

/** Parse a 24-hex ObjectId string; returns null when invalid. */
function parseObjectId(value) {
  if (typeof value !== "string" || !ObjectId.isValid(value) || !/^[a-f0-9]{24}$/i.test(value)) {
    return null;
  }
  return new ObjectId(value);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A key that is safe to splice into a MongoDB dotted path
 * (`actuators.<key>.<field>`): no dots, no `$`, no prototype keys.
 */
function isSafeKey(key) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 64 &&
    !key.includes(".") &&
    !key.startsWith("$") &&
    key !== "__proto__" &&
    key !== "constructor" &&
    key !== "prototype"
  );
}

function clampInt(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

module.exports = { sendServerError, parseObjectId, isPlainObject, isSafeKey, clampInt };
