const bcrypt = require("bcrypt");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");
const { generateUniqueUserId8 } = require("../utils/userId");
const { sendServerError } = require("../utils/http");
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Used to make failed logins for unknown emails take as long as wrong passwords
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser", SALT_ROUNDS);

function buildAppToken(user) {
  return signToken({
    sub: user._id.toString(),
    email: user.email,
    role: user.role,
    userId8: user.userId8, // ✅ ALWAYS in JWT for IoT
    tv: user.tokenVersion || 0,
  });
}

function userPayload(user) {
  return {
    id: user._id,
    userId8: user.userId8, // ✅ ALWAYS returned
    name: user.name,
    email: user.email,
    role: user.role,
    authProvider: user.authProvider,
    emailVerified: !!user.emailVerified,
    avatar: user.avatar || null,
    preferences: preferencesOf(user),
  };
}

const DEFAULT_PREFERENCES = { theme: "system", accentColor: null, language: "en", timezone: null, units: "metric" };

function preferencesOf(user) {
  const p = user.preferences || {};
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_PREFERENCES)) out[k] = p[k] ?? def;
  return out;
}

function isSuspended(user) {
  return user.isActive === false || user.status === "disabled";
}

async function register(req, res) {
  try {
    const { name, email, password } = req.body || {};

    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string" || !name.trim()) {
      return res.status(400).json({ ok: false, error: "name, email, password required" });
    }
    const normEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normEmail) || normEmail.length > 254) {
      return res.status(400).json({ ok: false, error: "Invalid email address" });
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
      return res
        .status(400)
        .json({ ok: false, error: `Password must be ${MIN_PASSWORD_LENGTH}-128 characters` });
    }

    const exists = await User.findOne({ email: normEmail }).lean();
    if (exists) {
      return res.status(409).json({ ok: false, error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId8 = await generateUniqueUserId8();

    const user = await User.create({
      userId8,
      name: name.trim().slice(0, 100),
      email: normEmail,
      passwordHash,
      authProvider: "local",
      emailVerified: false,
    });

    // Lazy require: email.controller imports this file
    await require("./email.controller")
      .queueVerificationEmail(user)
      .catch((e) => console.error("❌ Could not queue verification email:", e.message));

    return res.status(201).json({ ok: true, token: buildAppToken(user), user: userPayload(user) });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ ok: false, error: "Email or userId already exists" });
    }
    return sendServerError(res, e, "register");
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      return res.status(400).json({ ok: false, error: "email, password required" });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    // Google-only account trying password login
    if (!user.passwordHash) {
      return res.status(401).json({ ok: false, error: "This account uses Google sign-in" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    if (isSuspended(user)) {
      return res.status(403).json({ ok: false, error: "User account is suspended" });
    }

    // Safety: if old users exist without userId8, assign it
    if (!user.userId8) {
      user.userId8 = await generateUniqueUserId8();
      await user.save();
    }

    return res.json({ ok: true, token: buildAppToken(user), user: userPayload(user) });
  } catch (e) {
    return sendServerError(res, e, "login");
  }
}

function me(req, res) {
  return res.json({ ok: true, user: req.user });
}

async function googleAuth(req, res) {
  const { credential } = req.body || {};
  if (typeof credential !== "string" || !credential) {
    return res.status(400).json({ ok: false, error: "credential (Google ID token) required" });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid Google token" });
  }

  try {
    const email = (payload?.email || "").toLowerCase();
    const name = payload?.name || "Google User";
    const googleId = payload?.sub;
    const emailVerified = !!payload?.email_verified;

    if (!email || !googleId) return res.status(401).json({ ok: false, error: "Invalid Google token" });
    if (!emailVerified) return res.status(401).json({ ok: false, error: "Google email not verified" });

    // The Google account id is the stable link (it survives an email change in ThingsString)
    let user = (await User.findOne({ googleId })) || (await User.findOne({ email }));

    if (!user) {
      const userId8 = await generateUniqueUserId8();
      user = await User.create({
        userId8,
        name,
        email,
        googleId,
        authProvider: "google",
        emailVerified: true,
      });
    } else {
      if (isSuspended(user)) {
        return res.status(403).json({ ok: false, error: "User account is suspended" });
      }
      if (user.googleId && user.googleId !== googleId) {
        return res.status(409).json({ ok: false, error: "Account is linked to a different Google account" });
      }

      const $set = {};
      const $inc = {};
      if (!user.userId8) $set.userId8 = await generateUniqueUserId8();
      if (!user.googleId) $set.googleId = googleId;

      if (!user.emailVerified) {
        // The email was never proven by whoever set the password. Google has now proven
        // this person owns the address, so the unverified password is removed and all
        // existing sessions are revoked. This blocks "register someone's email first,
        // wait for them to sign in with Google" account takeover. The user can keep
        // signing in with Google; an admin can set a new password if they want one.
        $set.emailVerified = true;
        if (user.passwordHash) {
          $set.passwordHash = null;
          $inc.tokenVersion = 1;
        }
      }

      if (!user.passwordHash || $set.passwordHash === null) $set.authProvider = "google";

      if (Object.keys($set).length || Object.keys($inc).length) {
        const update = { $set };
        if (Object.keys($inc).length) update.$inc = $inc;
        user = await User.findByIdAndUpdate(user._id, update, { new: true });
      }
    }

    return res.json({ ok: true, token: buildAppToken(user), user: userPayload(user) });
  } catch (e) {
    return sendServerError(res, e, "google auth");
  }
}

module.exports = { register, login, me, googleAuth, buildAppToken, userPayload, preferencesOf, SALT_ROUNDS };
