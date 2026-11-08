// src/services/telemetryCsv.js
// Stream a device's telemetry as CSV without holding it all in memory.
// Pass 1 discovers the columns (telemetry fields are free-form), pass 2 writes rows.

const { once } = require("node:events");

const MAX_COLUMNS = 1000;
const MAX_DEPTH = 5;
const CHUNK_BYTES = 64 * 1024;
const SKIP_KEYS = new Set(["_id", "deviceId", "createdAt"]);

/** A nested object to flatten into `a.b.c` columns (not Date, ObjectId, arrays, ...). */
function isFlattenable(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Flatten a document into { "a.b": value } leaves. Arrays stay whole (written as JSON). */
function flatten(obj, prefix = "", out = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    if (!prefix && SKIP_KEYS.has(k)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isFlattenable(v) && depth < MAX_DEPTH && Object.keys(v).length > 0) {
      flatten(v, key, out, depth + 1);
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** Format one cell: RFC 4180 quoting, plus a guard against spreadsheet formula injection. */
function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s;
  if (v instanceof Date) s = Number.isNaN(v.getTime()) ? "" : v.toISOString();
  else if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  else if (typeof v === "string") s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  else if (Array.isArray(v) || isFlattenable(v)) s = JSON.stringify(v);
  else s = String(v); // ObjectId, Decimal128, Long, ...
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Write the CSV for `filter` (sorted by createdAt) to an http response.
 * Stops early if the client disconnects. Throws on DB errors.
 */
async function streamTelemetryCsv(col, filter, res) {
  const opts = { sort: { createdAt: 1 }, projection: { _id: 0, deviceId: 0 } };

  // Pass 1: column discovery
  const columns = new Set();
  let truncated = false;
  for await (const doc of col.find(filter, opts)) {
    if (res.destroyed) return { rows: 0, columns: 0, aborted: true };
    for (const k of Object.keys(flatten(doc))) {
      if (columns.has(k)) continue;
      if (columns.size >= MAX_COLUMNS) {
        truncated = true;
        continue;
      }
      columns.add(k);
    }
  }
  const header = ["createdAt", ...[...columns].sort()];

  // Pass 2: rows. UTF-8 BOM so Excel detects the encoding.
  let buf = "﻿" + header.map(csvCell).join(",") + "\r\n";
  let rows = 0;
  const flush = async () => {
    if (!buf) return;
    const ok = res.write(buf);
    buf = "";
    if (!ok) await Promise.race([once(res, "drain"), once(res, "close")]);
  };

  const cursor = col.find(filter, opts);
  try {
    for await (const doc of cursor) {
      if (res.destroyed) return { rows, columns: header.length, aborted: true };
      const flat = flatten(doc);
      flat.createdAt = doc.createdAt;
      buf += header.map((h) => csvCell(flat[h])).join(",") + "\r\n";
      rows++;
      if (buf.length >= CHUNK_BYTES) await flush();
    }
  } finally {
    await cursor.close().catch(() => {});
  }
  await flush();
  return { rows, columns: header.length, truncated, aborted: false };
}

module.exports = { streamTelemetryCsv, flatten, csvCell, MAX_COLUMNS };
