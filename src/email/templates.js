// src/email/templates.js
// Every email has an HTML and a plain-text version (better delivery, readable anywhere).
// Values from users (names, emails) are always HTML-escaped.

const moment = require("moment-timezone");

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
  amber: "#f59e0b", // amber-500 (warnings)
  emerald: "#10b981", // emerald-500 (all good)
};
const TONE = { info: C.blue, warn: C.amber, ok: C.emerald };
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

/** Two-column facts table (label, value). Values are HTML (escape user input before passing). */
function detailsTable(rows) {
  if (!rows || !rows.length) return "";
  const tr = rows
    .map(
      ([k, v], i) => `<tr>
        <td style="padding:9px 12px;${i ? `border-top:1px solid ${C.line};` : ""}font-family:${FONT};font-size:13px;line-height:18px;color:${C.muted};white-space:nowrap;vertical-align:top">${esc(k)}</td>
        <td style="padding:9px 12px;${i ? `border-top:1px solid ${C.line};` : ""}font-family:${FONT};font-size:14px;line-height:20px;color:${C.ink};font-weight:500">${v}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 6px;border:1px solid ${C.line};border-radius:10px;border-collapse:separate;background:${C.soft}">${tr}</table>`;
}

/** "8 Nov 2026, 14:05 (Asia/Colombo)" in the user's timezone, UTC by default. */
function fmtTime(date, tz) {
  const zone = tz && moment.tz.zone(tz) ? tz : "UTC";
  return `${moment(date).tz(zone).format("D MMM YYYY, HH:mm")} (${zone})`;
}

function fmtValue(v) {
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * Shared layout. `preheader` is the grey preview line shown in the inbox list.
 * `button` = { label, url }, `notice` = a highlighted box (e.g. security info).
 */
function layout({ preheader, title, intro, details, button, notice, tone = "info", outro, footerNote, unsubscribeUrl }) {
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
         <td style="width:3px;background:${TONE[tone] || C.blue};border-radius:3px"></td>
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
        ${detailsTable(details)}
        ${noticeBox}
        ${btn}
        ${(outro || []).map((x) => p(x, `font-size:13px;line-height:20px;color:${C.muted};margin:16px 0 0`)).join("")}
      </td></tr></table>
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:20px 8px 0;text-align:center">
      <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint}">${esc(footerNote || `You're receiving this because you have a ${BRAND} account.`)}</p>
      ${unsubscribeUrl ? `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint}"><a href="${esc(unsubscribeUrl)}" style="color:${C.muted};text-decoration:underline">Turn off these emails</a> &middot; or manage them in Settings</p>` : ""}
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
    ...(details && details.length ? ["", ...details.map(([k, v]) => `${k}: ${strip(String(v))}`)] : []),
    ...(notice ? ["", strip(notice)] : []),
    ...(button ? ["", `${button.label}: ${button.url}`] : []),
    ...(outro ? ["", ...outro.map(strip)] : []),
    "",
    `-- ${BRAND} · https://thingsstring.com`,
    ...(unsubscribeUrl ? [`Turn off these emails: ${unsubscribeUrl}`] : []),
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

  /* ───────────── Device alerts (optional, category "deviceOffline") ───────────── */

  deviceOffline: ({ name, deviceId, deviceName, lastSeen, afterMin, timezone, unsubscribeUrl }) => ({
    subject: `⚠️ ${deviceName} is offline`,
    ...layout({
      preheader: `${deviceName} stopped sending data.`,
      title: `${deviceName} is offline`,
      intro: [
        `Hi ${esc(name)},`,
        `<b>${esc(deviceName)}</b> hasn't sent any data${afterMin ? ` for more than ${esc(afterMin)} minutes` : ""}. Automations and schedule start actions for it are paused until it reconnects.`,
      ],
      details: [
        ["Device", esc(deviceName) + (deviceName !== deviceId ? ` <span style="color:${C.muted}">(${esc(deviceId)})</span>` : "")],
        ["Last seen", lastSeen ? esc(fmtTime(lastSeen, timezone)) : "Never"],
      ],
      notice: "Check its power and Wi-Fi. We'll email you again when it's back online.",
      tone: "warn",
      button: { label: "Open device", url: appUrl(`/devices/${encodeURIComponent(deviceId)}`) },
      unsubscribeUrl,
      footerNote: "You get this because you turned on offline alerts for this device.",
    }),
  }),

  deviceOnline: ({ name, deviceId, deviceName, offlineSince, timezone, unsubscribeUrl }) => ({
    subject: `✅ ${deviceName} is back online`,
    ...layout({
      preheader: `${deviceName} reconnected.`,
      title: `${deviceName} is back online`,
      intro: [`Hi ${esc(name)},`, `Good news: <b>${esc(deviceName)}</b> is sending data again.`],
      details: [
        ["Device", esc(deviceName)],
        ...(offlineSince ? [["Offline since", esc(fmtTime(offlineSince, timezone))]] : []),
        ["Back at", esc(fmtTime(new Date(), timezone))],
      ],
      tone: "ok",
      button: { label: "Open device", url: appUrl(`/devices/${encodeURIComponent(deviceId)}`) },
      unsubscribeUrl,
      footerNote: "You get this because you turned on offline alerts for this device.",
    }),
  }),

  /* ───────────── Automation (optional, category "automation") ───────────── */

  automationTriggered: ({ name, flowName, deviceId, deviceName, metricPath, value, operator, target, actionText, timezone, unsubscribeUrl }) => ({
    subject: `🔔 ${flowName}: ${metricPath} is ${fmtValue(value)}`,
    ...layout({
      preheader: `${deviceName}: ${metricPath} ${operator} ${fmtValue(target)}`,
      title: `Automation "${flowName}" triggered`,
      intro: [`Hi ${esc(name)},`, `Your automation rule's condition was met.`],
      details: [
        ["Device", esc(deviceName)],
        ["Reading", `${esc(metricPath)} = <b>${esc(fmtValue(value))}</b>`],
        ["Condition", `${esc(metricPath)} ${esc(operator)} ${esc(fmtValue(target))}`],
        ["Action", actionText ? esc(actionText) : `<span style="color:${C.muted}">Email only</span>`],
        ["Time", esc(fmtTime(new Date(), timezone))],
      ],
      tone: "info",
      button: { label: "Open device", url: appUrl(`/devices/${encodeURIComponent(deviceId)}`) },
      outro: ["You'll get at most one email per rule every 15 minutes."],
      unsubscribeUrl,
      footerNote: "You get this because the rule has \"Email me\" turned on.",
    }),
  }),

  /* ───────────── Sharing ───────────── */

  deviceInvite: ({ inviterName, deviceName, role, token, accountExists }) => {
    const url = appUrl(`/invite?token=${encodeURIComponent(token)}`);
    const can = {
      viewer: "see its live data, graphs and history",
      operator: "see its data and switch it on and off",
      manager: "see and control it, set schedules and automations, and invite others",
    }[role];
    return {
      subject: `${inviterName} shared "${deviceName}" with you on ${BRAND}`,
      ...layout({
        preheader: `You've been invited as ${role}. The invitation is valid for 7 days.`,
        title: `You're invited to "${deviceName}"`,
        intro: [`Hi,`, `<b>${esc(inviterName)}</b> invited you to the device <b>${esc(deviceName)}</b> on ${BRAND}, the IoT platform for monitoring and controlling connected devices.`],
        details: [
          ["Device", esc(deviceName)],
          ["Your role", `${esc(role.charAt(0).toUpperCase() + role.slice(1))} <span style="color:${C.muted}">(you can ${can})</span>`],
          ["Invited by", esc(inviterName)],
        ],
        button: { label: accountExists ? "Accept invitation" : "Create account & accept", url },
        notice: accountExists
          ? "Sign in with this email address to accept."
          : `New to ${BRAND}? The link lets you create a free account with this email address, and the device appears right away.`,
        outro: ["The invitation expires in 7 days. If you don't know the sender, you can ignore this email."],
        footerNote: `You received this because someone invited this address to ${BRAND}.`,
      }),
    };
  },

  /* ───────────── Admin actions (category "account", always sent) ───────────── */

  deviceLocked: ({ name, deviceId, deviceName, reason }) => ({
    subject: `${deviceName} was locked by an administrator`,
    ...layout({
      preheader: "Your device was locked by an administrator.",
      title: "Your device was locked",
      intro: [`Hi ${esc(name)},`, `An administrator locked <b>${esc(deviceName)}</b>. While it's locked, controls, automations and schedules can't change it.`],
      details: [["Device", esc(deviceName)], ["Reason", esc(reason || "Not given")]],
      tone: "warn",
      notice: "If you think this is a mistake, reply to this email.",
      footerNote: "This is a notice about your account and can't be turned off.",
    }),
  }),

  deviceUnlocked: ({ name, deviceId, deviceName }) => ({
    subject: `${deviceName} was unlocked`,
    ...layout({
      preheader: "Your device can be controlled again.",
      title: "Your device was unlocked",
      intro: [`Hi ${esc(name)},`, `<b>${esc(deviceName)}</b> was unlocked by an administrator. Controls, automations and schedules work again.`],
      tone: "ok",
      button: { label: "Open device", url: appUrl(`/devices/${encodeURIComponent(deviceId)}`) },
      footerNote: "This is a notice about your account and can't be turned off.",
    }),
  }),

  deviceTransferredAway: ({ name, deviceId, deviceName }) => ({
    subject: `${deviceName} was removed from your account`,
    ...layout({
      preheader: "A device was moved to another account.",
      title: "A device was removed from your account",
      intro: [`Hi ${esc(name)},`, `An administrator moved <b>${esc(deviceName)}</b> (${esc(deviceId)}) to another account. Your automations and schedules for it were removed.`],
      notice: "If you didn't expect this, reply to this email.",
      tone: "warn",
      footerNote: "This is a notice about your account and can't be turned off.",
    }),
  }),

  deviceTransferredIn: ({ name, deviceId }) => ({
    subject: `A device was added to your ${BRAND} account`,
    ...layout({
      preheader: `Device ${deviceId} is now yours.`,
      title: "A device was added to your account",
      intro: [`Hi ${esc(name)},`, `An administrator moved device <b>${esc(deviceId)}</b> to your account. It now appears in your dashboard.`],
      tone: "ok",
      button: { label: "Open device", url: appUrl(`/devices/${encodeURIComponent(deviceId)}`) },
      footerNote: "This is a notice about your account and can't be turned off.",
    }),
  }),

  accountSuspended: ({ name }) => ({
    subject: `Your ${BRAND} account was suspended`,
    ...layout({
      preheader: "Your account was suspended by an administrator.",
      title: "Your account was suspended",
      intro: [`Hi ${esc(name)},`, "An administrator suspended your account. You can't sign in, and your devices' automations stay as they are until it's reactivated."],
      notice: "If you think this is a mistake, reply to this email.",
      tone: "warn",
      footerNote: "This is a notice about your account and can't be turned off.",
    }),
  }),

  accountReactivated: ({ name }) => ({
    subject: `Your ${BRAND} account is active again`,
    ...layout({
      preheader: "You can sign in again.",
      title: "Your account is active again",
      intro: [`Hi ${esc(name)},`, "An administrator reactivated your account. You can sign in again."],
      tone: "ok",
      button: { label: `Open ${BRAND}`, url: appUrl("/dashboard") },
      footerNote: "This is a notice about your account and can't be turned off.",
    }),
  }),

  adminPasswordReset: ({ name }) => ({
    subject: `Your ${BRAND} password was reset by an administrator`,
    ...layout({
      preheader: "Security notice: an administrator set a new password.",
      title: "An administrator reset your password",
      intro: [`Hi ${esc(name)},`, "An administrator set a new password for your account, and every signed-in session was logged out. Ask your administrator for the new password, or choose your own with \"Forgot password\" on the login page."],
      tone: "warn",
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
