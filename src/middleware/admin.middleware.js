function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Access denied. Admins only." });
    }
    next();
}

module.exports = { requireAdmin };
