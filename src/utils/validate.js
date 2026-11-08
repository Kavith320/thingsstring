// src/utils/validate.js
// Small validators for user-editable settings. Each throws a ValidationError
// (HTTP 400) with a message that names the offending field.

const { isPlainObject } = require("./http");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const fail = (msg) => {
  throw new ValidationError(msg);
};

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Icon / avatar references:
//   "<set>:<name>"  an icon from a set the frontend ships, e.g. "mdi:water-pump", "avatar:robot-3"
//   "emoji:🌱"      an emoji
//   "file:<id>"     an image the user uploaded (GET /files/<id>)
const ICON_SET_RE = /^[a-z0-9-]{1,20}:[a-z0-9-]{1,60}$/;
const EMOJI_RE = /^emoji:[^\s\p{Cc}]{1,16}$/u;
const FILE_REF_RE = /^file:([a-f0-9]{32})$/;

/** Optional trimmed string. `null` or "" clears (returns null). */
function optString(v, field, { max, pattern, patternMsg } = {}) {
  if (v === null) return null;
  if (typeof v !== "string") fail(`'${field}' must be a string`);
  const s = v.trim();
  if (!s) return null;
  if (max && s.length > max) fail(`'${field}' must be at most ${max} characters`);
  if (pattern && !pattern.test(s)) fail(patternMsg || `'${field}' has an invalid format`);
  return s;
}

function reqString(v, field, opts) {
  const s = optString(v === undefined ? null : v, field, opts);
  if (s === null) fail(`'${field}' is required`);
  return s;
}

function optColor(v, field) {
  return optString(v, field, { max: 9, pattern: HEX_COLOR_RE, patternMsg: `'${field}' must be a hex colour like #22c55e` });
}

function optBool(v, field, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") fail(`'${field}' must be true or false`);
  return v;
}

function optEnum(v, field, values) {
  if (!values.includes(v)) fail(`'${field}' must be one of: ${values.join(", ")}`);
  return v;
}

/** Syntax check of an icon reference; returns { value, fileId }. */
function parseIconRef(v, field) {
  const s = optString(v, field, { max: 100 });
  if (s === null) return { value: null, fileId: null };
  const file = FILE_REF_RE.exec(s);
  if (file) return { value: s, fileId: file[1] };
  if (ICON_SET_RE.test(s) || EMOJI_RE.test(s)) return { value: s, fileId: null };
  return fail(`'${field}' must look like "mdi:fan", "emoji:🌱" or "file:<uploaded id>"`);
}

/**
 * Check that every uploaded-file icon reference belongs to the user.
 * `refs` is a list of { fileId, field } from parseIconRef.
 */
async function assertOwnFiles(db, userId, refs, kind) {
  const ids = [...new Set(refs.filter((r) => r.fileId).map((r) => r.fileId))];
  if (!ids.length) return;
  const found = await db
    .collection("files")
    .find({ _id: { $in: ids }, user_id: String(userId), kind }, { projection: { _id: 1 } })
    .toArray();
  const ok = new Set(found.map((f) => f._id));
  const bad = refs.find((r) => r.fileId && !ok.has(r.fileId));
  if (bad) fail(`'${bad.field}' refers to an uploaded ${kind} that does not exist`);
}

function requireObject(body, what = "Body") {
  if (!isPlainObject(body)) fail(`${what} must be a JSON object`);
  return body;
}

/** Send a ValidationError as 400; returns true when handled. */
function sendIfValidation(res, e) {
  if (!(e instanceof ValidationError)) return false;
  res.status(400).json({ ok: false, error: e.message });
  return true;
}

module.exports = {
  ValidationError,
  fail,
  optString,
  reqString,
  optColor,
  optBool,
  optEnum,
  parseIconRef,
  assertOwnFiles,
  requireObject,
  sendIfValidation,
};
