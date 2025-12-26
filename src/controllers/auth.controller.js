// src/controllers/auth.controller.js
const bcrypt = require("bcrypt");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");
const { generateUniqueUserId8 } = require("../utils/userId");

const SALT_ROUNDS = 10;

async function register(req, res) {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ ok: false, error: "name, email, password required" });
    }

    const existing = await User.findOne({ email: email.toLowerCase() }).lean();
    if (existing) {
      return res.status(409).json({ ok: false, error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // ✅ generate unique 8-digit user id
    const userId8 = await generateUniqueUserId8();

    const user = await User.create({
      userId8,
      name,
      email: email.toLowerCase(),
      passwordHash,
    });

    const token = signToken({
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      userId8: user.userId8,
    });

    return res.status(201).json({
      ok: true,
      token,
      user: {
        id: user._id,
        userId8: user.userId8,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (e) {
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

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const token = signToken({
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      userId8: user.userId8,
    });

    return res.json({
      ok: true,
      token,
      user: {
        id: user._id,
        userId8: user.userId8,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function me(req, res) {
  return res.json({ ok: true, user: req.user });
}

module.exports = { register, login, me };
