// src/email/budget.js
// Daily email budget for free-tier providers (Brevo free: 300 emails/day).
//
//   MAIL_DAILY_LIMIT   hard cap per rolling 24 h (default 300). The sender never goes
//                      over it: extra emails wait in the outbox and go out later.
//   MAIL_RESERVED      part of the cap kept for important emails: sign-up, password,
//                      invitations, admin notices (default 60). Optional alerts are not
//                      queued once (limit - reserved) emails were used.

const DAY_MS = 24 * 3600e3;

function limits() {
  const limit = Math.max(1, parseInt(process.env.MAIL_DAILY_LIMIT || "300", 10) || 300);
  const reserved = Math.min(limit, Math.max(0, parseInt(process.env.MAIL_RESERVED || "60", 10) || 0));
  return { limit, reserved };
}

/** Emails sent in the last 24 h and queued now. */
async function usage(db) {
  const col = db.collection("email_outbox");
  const since = new Date(Date.now() - DAY_MS);
  const [sent24h, queued] = await Promise.all([
    col.countDocuments({ status: "sent", sentAt: { $gte: since } }),
    col.countDocuments({ status: { $in: ["pending", "sending"] } }),
  ]);
  return { sent24h, queued };
}

async function budget(db) {
  const { limit, reserved } = limits();
  const { sent24h, queued } = await usage(db);
  const used = sent24h + queued;
  return {
    limit,
    reserved,
    sent24h,
    queued,
    remaining: Math.max(0, limit - used),
    alertsAllowed: used < limit - reserved,
    sendingAllowed: sent24h < limit,
  };
}

module.exports = { budget, limits, usage, DAY_MS };
