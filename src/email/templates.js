// src/email/templates.js
// Every email has an HTML and a plain-text version (better delivery, readable anywhere).
// Values from users (names, emails) are always HTML-escaped.

const BRAND = "ThingsString";
const ACCENT = "#16a34a";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function appUrl(pathAndQuery) {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${pathAndQuery}`;
}

/** Wrap content in the shared layout. `button` = { label, url } (optional). */
function layout({ title, intro, button, outro, footerNote }) {
  const btn = button
    ? `<p style="margin:28px 0"><a href="${esc(button.url)}" style="background:${ACCENT};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>
       <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">${esc(button.url)}</span></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;padding:32px">
<tr><td>
<p style="font-size:18px;font-weight:700;color:${ACCENT};margin:0 0 24px">${BRAND}</p>
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
${intro.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${p}</p>`).join("")}
${btn}
${(outro || []).map((p) => `<p style="font-size:14px;line-height:1.6;color:#374151;margin:12px 0 0">${p}</p>`).join("")}
</td></tr></table>
<p style="font-size:12px;color:#9ca3af;margin:16px 0 0">${esc(footerNote || `You received this email because of your ${BRAND} account.`)}</p>
</td></tr></table></body></html>`;

  const strip = (p) => p.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [
    BRAND,
    "",
    title,
    "",
    ...intro.map(strip),
    ...(button ? ["", `${button.label}: ${button.url}`] : []),
    ...(outro ? ["", ...outro.map(strip)] : []),
  ].join("\n");

  return { html, text };
}

const templates = {
  verifyEmail: ({ name, token }) => {
    const url = appUrl(`/verify-email?token=${encodeURIComponent(token)}`);
    return {
      subject: `Verify your ${BRAND} email`,
      ...layout({
        title: "Confirm your email address",
        intro: [`Hi ${esc(name)},`, `Please confirm this is your email address to finish setting up your ${BRAND} account.`],
        button: { label: "Verify email", url },
        outro: ["This link expires in 24 hours. If you didn't create an account, you can ignore this email."],
      }),
    };
  },

  resetPassword: ({ name, token }) => {
    const url = appUrl(`/reset-password?token=${encodeURIComponent(token)}`);
    return {
      subject: `Reset your ${BRAND} password`,
      ...layout({
        title: "Reset your password",
        intro: [`Hi ${esc(name)},`, "Someone (hopefully you) asked to reset the password for your account."],
        button: { label: "Choose a new password", url },
        outro: ["This link expires in 30 minutes and can be used once.", "If you didn't ask for this, ignore this email. Your password won't change."],
      }),
    };
  },

  passwordChanged: ({ name }) => ({
    subject: `Your ${BRAND} password was changed`,
    ...layout({
      title: "Your password was changed",
      intro: [`Hi ${esc(name)},`, "The password for your account was just changed, and every other signed-in session was logged out."],
      outro: [`If this wasn't you, reset your password now from the ${BRAND} login page and contact support.`],
      footerNote: "This is a security notice and can't be turned off.",
    }),
  }),

  confirmEmailChange: ({ name, newEmail, token }) => {
    const url = appUrl(`/confirm-email?token=${encodeURIComponent(token)}`);
    return {
      subject: `Confirm your new ${BRAND} email`,
      ...layout({
        title: "Confirm your new email address",
        intro: [`Hi ${esc(name)},`, `Click below to use <b>${esc(newEmail)}</b> for your ${BRAND} account.`],
        button: { label: "Confirm new email", url },
        outro: ["This link expires in 24 hours. Until you confirm, your old email stays active."],
      }),
    };
  },

  emailChanged: ({ name, newEmail }) => ({
    subject: `Your ${BRAND} email was changed`,
    ...layout({
      title: "Your account email was changed",
      intro: [`Hi ${esc(name)},`, `Your ${BRAND} account now uses <b>${esc(newEmail)}</b>. This address will no longer receive emails about it.`],
      outro: ["If this wasn't you, contact support right away."],
      footerNote: "This is a security notice and can't be turned off.",
    }),
  }),
};

function render(name, data) {
  const t = templates[name];
  if (!t) throw new Error(`Unknown email template '${name}'`);
  return t(data);
}

module.exports = { render, esc, templateNames: Object.keys(templates) };
