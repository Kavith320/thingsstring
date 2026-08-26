// src/services/auditLogger.js
const { getDb } = require("../db/mongo");

/**
 * Log an administrative action into the `admin_audit_logs` collection.
 * 
 * @param {Object} params
 * @param {string} params.adminId - MongoDB _id of the performing admin
 * @param {string} params.adminEmail - Email of the performing admin
 * @param {string} params.action - Action identifier (e.g., 'USER_ROLE_UPDATE', 'DEVICE_TRANSFER')
 * @param {string} [params.targetId] - ID of the target resource (userId, deviceId, flowId, etc.)
 * @param {Object} [params.details] - Additional contextual metadata
 * @param {Object} [params.req] - Express request object for IP and User-Agent logging
 */
async function logAdminAction({ adminId, adminEmail, action, targetId = null, details = {}, req = null }) {
  try {
    const db = getDb();
    const auditCol = db.collection("admin_audit_logs");

    const logEntry = {
      adminId: String(adminId),
      adminEmail: adminEmail || "system",
      action,
      targetId: targetId ? String(targetId) : null,
      details,
      ip: req ? (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null) : null,
      userAgent: req ? req.headers["user-agent"] : null,
      timestamp: new Date(),
    };

    await auditCol.insertOne(logEntry);
    return logEntry;
  } catch (e) {
    console.error("❌ Failed to record admin audit log:", e.message);
    // Non-blocking error: do not crash main flow if audit logging fails
    return null;
  }
}

module.exports = { logAdminAction };
