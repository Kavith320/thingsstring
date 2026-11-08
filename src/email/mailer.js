// src/email/mailer.js
// The one place that talks to the email provider. SMTP (Brevo, SES, ZeptoMail...)
// is configured from .env; switching provider means changing .env only.
//
//   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for port 465), SMTP_USER, SMTP_PASS
//   MAIL_FROM="ThingsString <no-reply@thingsstring.com>", MAIL_REPLY_TO
//
// Without SMTP_HOST the mailer runs in "log" mode: emails are printed, not sent.
// MAIL_TRANSPORT=json (tests) builds the message with nodemailer and keeps it in memory.

const nodemailer = require("nodemailer");

let transporter = null;
let mode = null;
const sentInMemory = []; // json mode only

function mailMode() {
  if (process.env.MAIL_TRANSPORT === "json") return "json";
  return process.env.SMTP_HOST ? "smtp" : "log";
}

function getTransporter() {
  const m = mailMode();
  if (transporter && mode === m) return transporter;
  mode = m;
  if (m === "json") {
    transporter = nodemailer.createTransport({ jsonTransport: true });
  } else if (m === "smtp") {
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      requireTLS: port === 587, // never send credentials or mail in clear text
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      pool: true,
      maxConnections: 2,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } else {
    transporter = null;
  }
  return transporter;
}

function fromAddress() {
  return process.env.MAIL_FROM || "ThingsString <no-reply@thingsstring.com>";
}

/** Send one message { to, subject, html, text, headers? }. Resolves with the provider's message id. */
async function sendMail(msg) {
  const t = getTransporter();
  const message = {
    from: fromAddress(),
    replyTo: process.env.MAIL_REPLY_TO || undefined,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    headers: msg.headers,
  };

  if (!t) {
    console.log(`📧 [log mode, not sent] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
    return "log-mode";
  }
  const info = await t.sendMail(message);
  if (mode === "json") sentInMemory.push(JSON.parse(info.message));
  return info.messageId;
}

/** Check the SMTP login at startup; logs the result and never throws. */
async function verifyMailer() {
  const t = getTransporter();
  if (!t) {
    console.warn("📧 SMTP_HOST not set: emails are only logged, not sent");
    return false;
  }
  if (mode === "json") return true;
  try {
    await t.verify();
    console.log(`📧 SMTP ready (${process.env.SMTP_HOST})`);
    return true;
  } catch (e) {
    console.error(`❌ SMTP check failed (${process.env.SMTP_HOST}): ${e.message}`);
    return false;
  }
}

function closeMailer() {
  if (transporter && typeof transporter.close === "function") transporter.close();
  transporter = null;
}

module.exports = { sendMail, verifyMailer, closeMailer, mailMode, sentInMemory };
