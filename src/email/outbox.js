// src/email/outbox.js
// Emails are queued in `email_outbox` and sent by the scheduler worker, so a slow
// or failing provider never slows down the API and nothing is lost on restart.
// The message body (which may contain a one-time link) is erased once sent.

const os = require("node:os");
const { render } = require("./templates");
const { sendMail } = require("./mailer");

const COL = "email_outbox";
const RETRY_DELAYS_MS = [60e3, 5 * 60e3, 30 * 60e3]; // then give up
const LOCK_MS = 2 * 60e3;
const WORKER_ID = `${os.hostname()}:${process.pid}`;

/**
 * Queue an email. `dedupeKey` (optional) makes repeated calls a no-op while the
 * earlier email is still queued or was sent within `dedupeWindowMs`.
 */
async function enqueueEmail(db, { to, template, data, dedupeKey, dedupeWindowMs = 60e3 }) {
  const col = db.collection(COL);
  const now = new Date();
  if (dedupeKey) {
    const recent = await col.findOne({ dedupeKey, createdAt: { $gte: new Date(now - dedupeWindowMs) } });
    if (recent) return { queued: false, id: recent._id };
  }
  const { subject, html, text } = render(template, data);
  const { insertedId } = await col.insertOne({
    to,
    template,
    subject,
    html,
    text,
    dedupeKey: dedupeKey || null,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    lockedBy: null,
    lockedUntil: null,
    lastError: null,
    createdAt: now,
    sentAt: null,
  });
  return { queued: true, id: insertedId };
}

/** Atomically claim the next due email (safe with several processes). */
function claimNext(col) {
  const now = new Date();
  return col.findOneAndUpdate(
    {
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        { status: "sending", lockedUntil: { $lte: now } }, // a crashed sender's claim
      ],
    },
    { $set: { status: "sending", lockedBy: WORKER_ID, lockedUntil: new Date(now.getTime() + LOCK_MS) } },
    { sort: { nextAttemptAt: 1 }, returnDocument: "after" }
  );
}

/** Send every due email. Returns { sent, failed, retried }. */
async function processOutbox(db, { max = 50, send = sendMail } = {}) {
  const col = db.collection(COL);
  const stats = { sent: 0, failed: 0, retried: 0 };

  for (let i = 0; i < max; i++) {
    const job = await claimNext(col);
    if (!job) break;
    try {
      const messageId = await send({ to: job.to, subject: job.subject, html: job.html, text: job.text });
      await col.updateOne(
        { _id: job._id },
        {
          $set: { status: "sent", sentAt: new Date(), messageId, lockedBy: null, lockedUntil: null, lastError: null },
          $unset: { html: "", text: "" }, // never keep one-time links around
        }
      );
      stats.sent++;
    } catch (e) {
      const attempts = job.attempts + 1;
      const delay = RETRY_DELAYS_MS[attempts - 1];
      // Bad / unknown recipient will never succeed; everything else (network, auth, rate limits) is retried
      const permanent = [550, 551, 553].includes(e.responseCode);
      const giveUp = !delay || permanent;
      await col.updateOne(
        { _id: job._id },
        {
          $set: {
            status: giveUp ? "failed" : "pending",
            attempts,
            nextAttemptAt: giveUp ? null : new Date(Date.now() + delay),
            lockedBy: null,
            lockedUntil: null,
            lastError: String(e.message || e).slice(0, 500),
          },
          ...(giveUp ? { $unset: { html: "", text: "" } } : {}),
        }
      );
      console.error(`❌ Email to ${job.to} (${job.template}) failed, attempt ${attempts}${giveUp ? ", giving up" : ""}: ${e.message}`);
      if (giveUp) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}

/** Poll the outbox every `intervalMs`; never runs two batches at once. Returns a stop function. */
function startOutboxLoop(db, { intervalMs = 5000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await processOutbox(db);
      if (s.sent || s.failed) console.log(`📧 Outbox: ${s.sent} sent, ${s.failed} failed, ${s.retried} will retry`);
    } catch (e) {
      console.error("❌ Outbox loop error:", e.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}

module.exports = { enqueueEmail, processOutbox, startOutboxLoop };
