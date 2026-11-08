// src/controllers/profile.controller.js — the logged-in user's own profile (/api/me)
const bcrypt = require("bcrypt");
const moment = require("moment-timezone");
const User = require("../models/User");
const { getDb } = require("../db/mongo");
const { sendServerError } = require("../utils/http");
const { buildAppToken, preferencesOf, SALT_ROUNDS } = require("./auth.controller");
const { saveImage, deleteFiles, fileIdFromRef } = require("../services/fileStore");
const { enqueueEmail } = require("../email/outbox");
const { notificationsOf, verifyUnsubscribeToken, OPTIONAL_CATEGORIES } = require("../email/notify");
const {
  fail,
  optString,
  reqString,
  optColor,
  optEnum,
  parseIconRef,
  assertOwnFiles,
  requireObject,
  sendIfValidation,
} = require("../utils/validate");

function profileOf(user) {
  return {
    id: user._id,
    userId8: user.userId8,
    name: user.name,
    email: user.email,
    emailVerified: !!user.emailVerified,
    role: user.role,
    authProvider: user.authProvider,
    hasPassword: !!user.passwordHash,
    phone: user.phone || null,
    organization: user.organization || null,
    country: user.country || null,
    bio: user.bio || null,
    avatar: user.avatar || null,
    preferences: preferencesOf(user),
    notifications: notificationsOf(user),
    createdAt: user.createdAt,
  };
}

async function loadUser(req) {
  const user = await User.findById(req.user.id);
  if (!user) fail("User not found");
  return user;
}

/** Remove the user's previous uploaded avatar if it is no longer in use. */
async function dropOldAvatar(userId, oldRef, newRef) {
  const oldId = fileIdFromRef(oldRef);
  if (oldId && oldRef !== newRef) await deleteFiles(getDb(), { _id: oldId, user_id: String(userId), kind: "avatar" });
}

function handle(res, e, ctx) {
  if (sendIfValidation(res, e)) return;
  sendServerError(res, e, ctx);
}

// GET /api/me
async function getProfile(req, res) {
  try {
    return res.json({ ok: true, user: profileOf(await loadUser(req)) });
  } catch (e) {
    return handle(res, e, "get profile");
  }
}

const PROFILE_FIELDS = {
  name: (v) => reqString(v, "name", { max: 60 }),
  phone: (v) =>
    optString(v, "phone", { max: 30, pattern: /^\+?[0-9 ()-]{3,30}$/, patternMsg: "'phone' may contain digits, spaces, ( ) - and a leading +" }),
  organization: (v) => optString(v, "organization", { max: 100 }),
  country: (v) => optString(v, "country", { max: 60 }),
  bio: (v) => optString(v, "bio", { max: 300 }),
};

// PATCH /api/me  { name?, phone?, organization?, country?, bio?, avatar? }
async function updateProfile(req, res) {
  try {
    const body = requireObject(req.body);
    const $set = {};
    for (const [k, check] of Object.entries(PROFILE_FIELDS)) {
      if (body[k] !== undefined) $set[k] = check(body[k]);
    }

    if (body.avatar !== undefined) {
      const ref = parseIconRef(body.avatar, "avatar");
      await assertOwnFiles(getDb(), req.user.id, [{ ...ref, field: "avatar" }], "avatar");
      $set.avatar = ref.value;
    }
    if (!Object.keys($set).length) fail("Nothing to update");

    const before = await loadUser(req);
    const user = await User.findByIdAndUpdate(req.user.id, { $set }, { new: true, runValidators: true });
    if ($set.avatar !== undefined) await dropOldAvatar(req.user.id, before.avatar, $set.avatar);

    return res.json({ ok: true, user: profileOf(user) });
  } catch (e) {
    return handle(res, e, "update profile");
  }
}

const PREFERENCE_FIELDS = {
  theme: (v) => optEnum(v, "theme", ["light", "dark", "system"]),
  accentColor: (v) => optColor(v, "accentColor"),
  language: (v) =>
    reqString(v, "language", { max: 16, pattern: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, patternMsg: "'language' must be a code like en or si-LK" }),
  timezone: (v) => {
    const tz = optString(v, "timezone", { max: 64 });
    if (tz && !moment.tz.zone(tz)) fail(`Unknown timezone '${tz}'`);
    return tz;
  },
  units: (v) => optEnum(v, "units", ["metric", "imperial"]),
};

// PATCH /api/me/preferences  { theme?, accentColor?, language?, timezone?, units? }
async function updatePreferences(req, res) {
  try {
    const body = requireObject(req.body);
    const $set = {};
    for (const [k, check] of Object.entries(PREFERENCE_FIELDS)) {
      if (body[k] !== undefined) $set[`preferences.${k}`] = check(body[k]);
    }
    if (!Object.keys($set).length) fail("Nothing to update");

    const user = await User.findByIdAndUpdate(req.user.id, { $set }, { new: true, runValidators: true });
    if (!user) fail("User not found");
    return res.json({ ok: true, preferences: preferencesOf(user) });
  } catch (e) {
    return handle(res, e, "update preferences");
  }
}

// PUT /api/me/password  { currentPassword, newPassword }
// Logs out every other session; the response carries a fresh token for this one.
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = requireObject(req.body);
    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      fail("'newPassword' must be 8-128 characters");
    }

    const user = await loadUser(req);
    if (user.passwordHash) {
      // Google-only accounts have no password yet and may set one directly.
      const ok = typeof currentPassword === "string" && (await bcrypt.compare(currentPassword, user.passwordHash));
      if (!ok) fail("Current password is incorrect");
    }

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await enqueueEmail(getDb(), { to: user.email, template: "passwordChanged", data: { name: user.name } }).catch((e) =>
      console.error("❌ Could not queue password-changed email:", e.message)
    );

    return res.json({ ok: true, message: "Password changed. Other sessions were logged out.", token: buildAppToken(user) });
  } catch (e) {
    return handle(res, e, "change password");
  }
}

// PUT /api/me/avatar  (raw image body: PNG, JPEG or WebP, max 2 MB)
async function uploadAvatar(req, res) {
  try {
    const db = getDb();
    const before = await loadUser(req);
    const file = await saveImage(db, req.body, { userId: req.user.id, kind: "avatar" });
    const ref = `file:${file._id}`;
    const user = await User.findByIdAndUpdate(req.user.id, { $set: { avatar: ref } }, { new: true });
    await dropOldAvatar(req.user.id, before.avatar, ref);
    return res.json({ ok: true, user: profileOf(user), file: { id: file._id, url: `/files/${file._id}` } });
  } catch (e) {
    return handle(res, e, "upload avatar");
  }
}

// DELETE /api/me/avatar
async function removeAvatar(req, res) {
  try {
    const before = await loadUser(req);
    const user = await User.findByIdAndUpdate(req.user.id, { $set: { avatar: null } }, { new: true });
    await dropOldAvatar(req.user.id, before.avatar, null);
    return res.json({ ok: true, user: profileOf(user) });
  } catch (e) {
    return handle(res, e, "remove avatar");
  }
}

// GET /api/me/notifications
async function getNotifications(req, res) {
  try {
    return res.json({ ok: true, notifications: notificationsOf(await loadUser(req)) });
  } catch (e) {
    return handle(res, e, "get notifications");
  }
}

// PATCH /api/me/notifications  { deviceOffline?: bool, automation?: bool }
async function updateNotifications(req, res) {
  try {
    const body = requireObject(req.body);
    const $set = {};
    for (const k of OPTIONAL_CATEGORIES) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== "boolean") fail(`'${k}' must be true or false`);
      $set[`notifications.${k}`] = body[k];
    }
    if (!Object.keys($set).length) fail(`Nothing to update (fields: ${OPTIONAL_CATEGORIES.join(", ")})`);
    const user = await User.findByIdAndUpdate(req.user.id, { $set }, { new: true });
    if (!user) fail("User not found");
    return res.json({ ok: true, notifications: notificationsOf(user) });
  } catch (e) {
    return handle(res, e, "update notifications");
  }
}

// POST /api/auth/unsubscribe  { token }   (no login: opened from the email link)
async function unsubscribe(req, res) {
  try {
    const t = verifyUnsubscribeToken(req.body?.token);
    if (!t) return res.status(400).json({ ok: false, error: "This unsubscribe link is invalid" });
    if (t.deviceId) {
      // Offline alerts are per device: the link turns off just this device's alerts
      const r = await getDb()
        .collection("device_alerts")
        .updateOne({ _id: `${t.userId}:${t.deviceId}` }, { $set: { "offline.enabled": false, state: null, updatedAt: new Date() } });
      return res.json({ ok: true, category: t.category, deviceId: t.deviceId, changed: r.modifiedCount > 0 });
    }
    const user = await User.findByIdAndUpdate(t.userId, { $set: { [`notifications.${t.category}`]: false } }, { new: true });
    if (!user) return res.status(400).json({ ok: false, error: "This unsubscribe link is invalid" });
    return res.json({ ok: true, category: t.category, notifications: notificationsOf(user) });
  } catch (e) {
    return handle(res, e, "unsubscribe");
  }
}

module.exports = {
  getNotifications,
  updateNotifications,
  unsubscribe,
  getProfile, updateProfile, updatePreferences, changePassword, uploadAvatar, removeAvatar };
