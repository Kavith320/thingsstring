// src/controllers/email.controller.js
// Account operations that go through email: verify, forgot/reset password, change email.
const bcrypt = require("bcrypt");
const User = require("../models/User");
const { getDb } = require("../db/mongo");
const { sendServerError } = require("../utils/http");
const { enqueueEmail } = require("../email/outbox");
const { createToken, consumeToken, revokeTokens } = require("../services/emailTokens");
const { buildAppToken, userPayload, SALT_ROUNDS } = require("./auth.controller");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const isSuspended = (u) => u.isActive === false || u.status === "disabled";
const bad = (res, error, status = 400) => res.status(status).json({ ok: false, error });

/** Queue a verification email for a user (used by register and "resend"). */
async function queueVerificationEmail(user) {
  const db = getDb();
  const token = await createToken(db, { userId: user._id, purpose: "verifyEmail" });
  await enqueueEmail(db, { to: user.email, template: "verifyEmail", data: { name: user.name, token } });
}

// POST /api/auth/verify-email/send   (logged in) — resend the verification link
async function resendVerification(req, res) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return bad(res, "User not found", 404);
    if (user.emailVerified) return bad(res, "Email is already verified");
    await queueVerificationEmail(user);
    return res.json({ ok: true, message: `Verification email sent to ${user.email}` });
  } catch (e) {
    return sendServerError(res, e, "resend verification");
  }
}

// POST /api/auth/verify-email  { token }   (no login needed: the link may be opened on another device)
async function verifyEmail(req, res) {
  try {
    const t = await consumeToken(getDb(), req.body?.token, "verifyEmail");
    if (!t) return bad(res, "This link is invalid or has expired. Request a new one.");
    const user = await User.findByIdAndUpdate(t.userId, { $set: { emailVerified: true } }, { new: true });
    if (!user) return bad(res, "This link is invalid or has expired. Request a new one.");
    return res.json({ ok: true, message: "Email verified", user: userPayload(user) });
  } catch (e) {
    return sendServerError(res, e, "verify email");
  }
}

// POST /api/auth/forgot-password  { email }
// Always answers the same way, so it can't be used to find out which emails have accounts.
async function forgotPassword(req, res) {
  const generic = { ok: true, message: "If an account exists for that email, a reset link has been sent." };
  try {
    const email = normEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) return bad(res, "Invalid email address");

    const user = await User.findOne({ email });
    if (user && !isSuspended(user)) {
      const db = getDb();
      const token = await createToken(db, { userId: user._id, purpose: "resetPassword" });
      await enqueueEmail(db, { to: user.email, template: "resetPassword", data: { name: user.name, token } });
    }
    return res.json(generic);
  } catch (e) {
    return sendServerError(res, e, "forgot password");
  }
}

// POST /api/auth/reset-password  { token, newPassword }
// Logs out every session; returns a fresh token so the user is signed in straight away.
async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body || {};
    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      return bad(res, "'newPassword' must be 8-128 characters");
    }
    const db = getDb();
    const t = await consumeToken(db, token, "resetPassword");
    if (!t) return bad(res, "This link is invalid or has expired. Request a new one.");

    const user = await User.findById(t.userId);
    if (!user || isSuspended(user)) return bad(res, "This link is invalid or has expired. Request a new one.");

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.emailVerified = true; // they just proved they read this inbox
    await user.save();
    await revokeTokens(db, user._id, "resetPassword");
    await enqueueEmail(db, { to: user.email, template: "passwordChanged", data: { name: user.name } });

    return res.json({ ok: true, message: "Password updated", token: buildAppToken(user), user: userPayload(user) });
  } catch (e) {
    return sendServerError(res, e, "reset password");
  }
}

// POST /api/me/email  { newEmail, currentPassword }   (logged in)
// Sends a confirmation link to the new address; nothing changes until it is clicked.
async function requestEmailChange(req, res) {
  try {
    const { currentPassword } = req.body || {};
    const newEmail = normEmail(req.body?.newEmail);
    if (!EMAIL_RE.test(newEmail) || newEmail.length > 254) return bad(res, "Invalid email address");

    const user = await User.findById(req.user.id);
    if (!user) return bad(res, "User not found", 404);
    if (!user.passwordHash) return bad(res, "Set a password first (PUT /api/me/password), then change your email");
    if (typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return bad(res, "Current password is incorrect");
    }
    if (newEmail === user.email) return bad(res, "That is already your email");
    if (await User.exists({ email: newEmail })) return bad(res, "That email is already used by another account", 409);

    const db = getDb();
    const token = await createToken(db, { userId: user._id, purpose: "changeEmail", data: { newEmail } });
    await enqueueEmail(db, { to: newEmail, template: "confirmEmailChange", data: { name: user.name, newEmail, token } });
    return res.json({ ok: true, message: `Confirmation link sent to ${newEmail}` });
  } catch (e) {
    return sendServerError(res, e, "request email change");
  }
}

// POST /api/auth/confirm-email  { token }
async function confirmEmailChange(req, res) {
  try {
    const db = getDb();
    const t = await consumeToken(db, req.body?.token, "changeEmail");
    const newEmail = t?.data?.newEmail;
    if (!t || !newEmail) return bad(res, "This link is invalid or has expired.");

    const user = await User.findById(t.userId);
    if (!user || isSuspended(user)) return bad(res, "This link is invalid or has expired.");
    if (await User.exists({ email: newEmail, _id: { $ne: user._id } })) {
      return bad(res, "That email is already used by another account", 409);
    }

    const oldEmail = user.email;
    user.email = newEmail;
    user.emailVerified = true;
    try {
      await user.save();
    } catch (e) {
      if (e?.code === 11000) return bad(res, "That email is already used by another account", 409);
      throw e;
    }
    await enqueueEmail(db, { to: oldEmail, template: "emailChanged", data: { name: user.name, newEmail } });
    return res.json({ ok: true, message: "Email changed", user: userPayload(user) });
  } catch (e) {
    return sendServerError(res, e, "confirm email change");
  }
}

module.exports = {
  queueVerificationEmail,
  resendVerification,
  verifyEmail,
  forgotPassword,
  resetPassword,
  requestEmailChange,
  confirmEmailChange,
};
