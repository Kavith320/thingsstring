// src/services/fileStore.js
// Uploaded images (avatars, custom icons). Bytes live on disk in UPLOAD_DIR,
// metadata in the `files` collection. Only this module touches the disk, so
// moving to S3 / Cloudflare R2 later means changing this file only.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ValidationError } = require("../utils/validate");

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FILE_ID_RE = /^[a-f0-9]{32}$/;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Detected from the bytes, never from the client's Content-Type or file name.
// SVG is deliberately not accepted: it can carry scripts.
const IMAGE_TYPES = [
  { mime: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(PNG) },
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/webp",
    test: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  },
];

function uploadDir() {
  return path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "..", "..", "uploads"));
}

function filePath(id) {
  if (!FILE_ID_RE.test(id)) throw new Error("bad file id");
  return path.join(uploadDir(), id);
}

function sniffImage(buf) {
  return IMAGE_TYPES.find((t) => t.test(buf))?.mime || null;
}

/** Validate and store an uploaded image. Returns the `files` document. */
async function saveImage(db, buf, { userId, kind }) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new ValidationError("Send the image bytes as the request body (Content-Type: image/png, image/jpeg or image/webp)");
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new ValidationError("Image is larger than 2 MB");
  const mime = sniffImage(buf);
  if (!mime) throw new ValidationError("Only PNG, JPEG and WebP images are accepted");

  const id = crypto.randomBytes(16).toString("hex");
  const dest = filePath(id);
  await fsp.mkdir(uploadDir(), { recursive: true });
  const tmp = `${dest}.tmp`;
  await fsp.writeFile(tmp, buf, { mode: 0o640 });
  await fsp.rename(tmp, dest);

  const doc = { _id: id, user_id: String(userId), kind, mime, size: buf.length, createdAt: new Date() };
  try {
    await db.collection("files").insertOne(doc);
  } catch (e) {
    await fsp.unlink(dest).catch(() => {});
    throw e;
  }
  return doc;
}

/** Delete matching files from the database and the disk. Returns the number removed. */
async function deleteFiles(db, filter) {
  const docs = await db.collection("files").find(filter, { projection: { _id: 1 } }).toArray();
  if (!docs.length) return 0;
  await db.collection("files").deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  await Promise.all(
    docs.map((d) =>
      fsp.unlink(filePath(d._id)).catch((e) => {
        if (e.code !== "ENOENT") console.error(`⚠️ Could not delete file ${d._id}:`, e.message);
      })
    )
  );
  return docs.length;
}

/** "file:<id>" -> id, anything else -> null */
function fileIdFromRef(ref) {
  const m = typeof ref === "string" ? /^file:([a-f0-9]{32})$/.exec(ref) : null;
  return m ? m[1] : null;
}

// GET /files/:id — public, unguessable URL (128-bit random id), cached forever.
async function serveFile(db, req, res) {
  const { id } = req.params;
  if (!FILE_ID_RE.test(id)) return res.status(404).json({ ok: false, error: "Not found" });

  const doc = await db.collection("files").findOne({ _id: id });
  if (!doc) return res.status(404).json({ ok: false, error: "Not found" });

  const stream = fs.createReadStream(filePath(id));
  stream.once("open", () => {
    res.set({
      "Content-Type": doc.mime,
      "Content-Length": String(doc.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Disposition": "inline",
    });
    stream.pipe(res);
  });
  stream.once("error", (e) => {
    if (e.code !== "ENOENT") console.error(`❌ Reading file ${id} failed:`, e.message);
    if (!res.headersSent) res.status(404).json({ ok: false, error: "Not found" });
    else res.destroy();
  });
}

/** Read an uploaded file's bytes, or null if it's gone. */
function readFileSafe(id) {
  try {
    return fs.readFileSync(filePath(id));
  } catch {
    return null;
  }
}

module.exports = { saveImage, deleteFiles, serveFile, fileIdFromRef, uploadDir, readFileSafe, sniffImage, MAX_IMAGE_BYTES };
