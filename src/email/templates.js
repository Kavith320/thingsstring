// src/email/templates.js
// Every email has an HTML and a plain-text version (better delivery, readable anywhere).
// Values from users (names, emails) are always HTML-escaped.

const BRAND = "ThingsString";

// Brand palette, taken from the frontend (Logo.tsx and the zinc UI)
const C = {
  blue: "#4898cf",
  teal: "#58b3a4",
  green: "#7add8f",
  ink: "#18181b", // zinc-900
  body: "#3f3f46", // zinc-700
  muted: "#71717a", // zinc-500
  faint: "#a1a1aa", // zinc-400
  line: "#e4e4e7", // zinc-200
  page: "#f4f4f5", // zinc-100
  soft: "#fafafa", // zinc-50
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Logo: embedded in the email (cid:ts-logo, see mailer.js) unless MAIL_LOGO_URL points to a hosted copy. */
const logoSrc = () => process.env.MAIL_LOGO_URL || "cid:ts-logo";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function appUrl(pathAndQuery) {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${pathAndQuery}`;
}

/**
 * Shared layout. `preheader` is the grey preview line shown in the inbox list.
 * `button` = { label, url }, `notice` = a highlighted box (e.g. security info).
 */
function layout({ preheader, title, intro, button, notice, outro, footerNote }) {
  const p = (html, extra = "") =>
    `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.body};${extra}">${html}</p>`;

  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 22px"><tr>
         <td style="border-radius:10px;background:${C.ink}">
           <a href="${esc(button.url)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${esc(button.label)} &rarr;</a>
         </td></tr></table>
       <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted}">Button not working? Paste this link into your browser:</p>
       <p style="margin:0 0 4px;padding:10px 12px;background:${C.soft};border:1px solid ${C.line};border-radius:8px;font-family:${MONO};font-size:12px;line-height:18px;color:${C.body};word-break:break-all">${esc(button.url)}</p>`
    : "";

  const noticeBox = notice
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 6px"><tr>
         <td style="width:3px;background:${C.blue};border-radius:3px"></td>
         <td style="padding:12px 14px;background:${C.soft};font-family:${FONT};font-size:14px;line-height:21px;color:${C.body}">${notice}</td>
       </tr></table>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader || "")}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:36px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

    <!-- Brand -->
    <tr><td style="padding:0 4px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle"><img src="${esc(logoSrc())}" width="44" height="44" alt="" style="display:block;border:0;border-radius:13px"></td>
        <td style="vertical-align:middle;padding-left:12px">
          <div style="font-family:${FONT};font-size:17px;font-weight:700;line-height:20px;color:${C.ink}">${BRAND}</div>
          <div style="font-family:${FONT};font-size:12px;font-weight:500;line-height:16px;color:${C.muted}">IoT Platform</div>
        </td>
      </tr></table>
    </td></tr>

    <!-- Card -->
    <tr><td style="background:#ffffff;border:1px solid ${C.line};border-radius:16px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td height="4" style="height:4px;line-height:4px;font-size:0;background:${C.blue}">&nbsp;</td>
        <td height="4" style="height:4px;line-height:4px;font-size:0;background:${C.teal}">&nbsp;</td>
        <td height="4" style="height:4px;line-height:4px;font-size:0;background:${C.green}">&nbsp;</td>
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 32px 28px">
        <h1 style="margin:0 0 18px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;letter-spacing:-0.2px;color:${C.ink}">${esc(title)}</h1>
        ${intro.map((x) => p(x)).join("")}
        ${noticeBox}
        ${btn}
        ${(outro || []).map((x) => p(x, `font-size:13px;line-height:20px;color:${C.muted};margin:16px 0 0`)).join("")}
      </td></tr></table>
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:20px 8px 0;text-align:center">
      <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint}">${esc(footerNote || `You're receiving this because you have a ${BRAND} account.`)}</p>
      <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint}">&copy; ${new Date().getFullYear()} ${BRAND} &middot; <a href="https://thingsstring.com" style="color:${C.faint};text-decoration:underline">thingsstring.com</a></p>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;

  const strip = (x) =>
    x.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [
    `${BRAND}`,
    "",
    title,
    "",
    ...intro.map(strip),
    ...(notice ? ["", strip(notice)] : []),
    ...(button ? ["", `${button.label}: ${button.url}`] : []),
    ...(outro ? ["", ...outro.map(strip)] : []),
    "",
    `-- ${BRAND} · https://thingsstring.com`,
  ].join("\n");

  return { html, text };
}

const templates = {
  verifyEmail: ({ name, token }) => {
    const url = appUrl(`/verify-email?token=${encodeURIComponent(token)}`);
    return {
      subject: `Verify your ${BRAND} email`,
      ...layout({
        preheader: "Confirm your email to finish setting up your account.",
        title: "Confirm your email address",
        intro: [`Hi ${esc(name)},`, `Welcome to ${BRAND}! Please confirm this is your email address to finish setting up your account.`],
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
        preheader: "Use this link within 30 minutes to choose a new password.",
        title: "Reset your password",
        intro: [`Hi ${esc(name)},`, "Someone (hopefully you) asked to reset the password for your account."],
        button: { label: "Choose a new password", url },
        notice: "This link expires in <b>30 minutes</b> and can be used once. Resetting signs you out on every device.",
        outro: ["If you didn't ask for this, you can ignore this email. Your password won't change."],
      }),
    };
  },

  passwordChanged: ({ name }) => ({
    subject: `Your ${BRAND} password was changed`,
    ...layout({
      preheader: "Security notice: your password was just changed.",
      title: "Your password was changed",
      intro: [`Hi ${esc(name)},`, "The password for your account was just changed, and every other signed-in session was logged out."],
      notice: `<b>Wasn't you?</b> Reset your password from the ${BRAND} login page right away, and reply to this email so we can help.`,
      footerNote: "This is a security notice and can't be turned off.",
    }),
  }),

  confirmEmailChange: ({ name, newEmail, token }) => {
    const url = appUrl(`/confirm-email?token=${encodeURIComponent(token)}`);
    return {
      subject: `Confirm your new ${BRAND} email`,
      ...layout({
        preheader: "Confirm the new email address for your account.",
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
      preheader: "Security notice: your account email was changed.",
      title: "Your account email was changed",
      intro: [`Hi ${esc(name)},`, `Your ${BRAND} account now uses <b>${esc(newEmail)}</b>. This address will no longer receive emails about it.`],
      notice: "<b>Wasn't you?</b> Reply to this email right away so we can secure your account.",
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
