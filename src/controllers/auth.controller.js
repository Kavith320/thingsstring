const bcrypt = require("bcrypt");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");
const { generateUniqueUserId8 } = require("../utils/userId");
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const SALT_ROUNDS = 10;

function buildAppToken(user) {
  return signToken({
    sub: user._id.toString(),
    email: user.email,
    role: user.role,
    userId8: user.userId8, // ✅ ALWAYS in JWT for IoT
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
  };
}

async function register(req, res) {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ ok: false, error: "name, email, password required" });
    }

    const exists = await User.findOne({ email: email.toLowerCase() }).lean();
    if (exists) {
      return res.status(409).json({ ok: false, error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId8 = await generateUniqueUserId8();

    const user = await User.create({
      userId8,
      name,
      email: email.toLowerCase(),
      passwordHash,
      authProvider: "local",
      emailVerified: false,
    });

    const token = buildAppToken(user);

    return res.status(201).json({
      ok: true,
      token,
      user: userPayload(user),
    });
  } catch (e) {
    // handle duplicate key race condition
    if (e && e.code === 11000) {
      return res.status(409).json({ ok: false, error: "Email or userId already exists" });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email, password required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    // ✅ IMPORTANT: if Google-only account tries password login
    if (!user.passwordHash) {
      return res.status(401).json({ ok: false, error: "This account uses Google sign-in" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    // ✅ Safety: if old users exist without userId8, assign it
    if (!user.userId8) {
      user.userId8 = await generateUniqueUserId8();
      await user.save();
    }

    const token = buildAppToken(user);
    return res.json({ ok: true, token, user: userPayload(user) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function me(req, res) {
  return res.json({ ok: true, user: req.user });
}

async function googleAuth(req, res) {
  try {
    const { credential } = req.body || {};
    if (!credential) {
      return res.status(400).json({ ok: false, error: "credential (Google ID token) required" });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = (payload?.email || "").toLowerCase();
    const name = payload?.name || "Google User";
    const googleId = payload?.sub;
    const emailVerified = !!payload?.email_verified;

    if (!email || !googleId) return res.status(401).json({ ok: false, error: "Invalid Google token" });
    if (!emailVerified) return res.status(401).json({ ok: false, error: "Google email not verified" });

    let user = await User.findOne({ email });

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
      // ✅ Ensure userId8 exists for old users
      const update = {};
      if (!user.userId8) update.userId8 = await generateUniqueUserId8();
      if (!user.googleId) update.googleId = googleId;
      if (!user.emailVerified) update.emailVerified = true;

      // If they have no passwordHash, mark provider as google
      if (!user.passwordHash) update.authProvider = "google";

      if (Object.keys(update).length) {
        await User.updateOne({ _id: user._id }, { $set: update });
        user = await User.findById(user._id);
      }
    }

    const token = buildAppToken(user);
    return res.json({ ok: true, token, user: userPayload(user) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { register, login, me, googleAuth };
