# Admin API Documentation

This section provides details on the Admin API for managing the entire system.
These endpoints are prefixed with `/api/admin`.

## Authentication

All admin routes require a valid JWT token in the `Authorization` header, and the user must have the role `admin`.

```
Authorization: Bearer <token>
```

## 1. System Statistics

### Get System Stats
`GET /api/admin/stats`

Returns counts of users, devices, telemetry records, and schedules.

**Response:**
```json
{
  "ok": true,
  "stats": {
    "users": 10,
    "devices": 5,
    "telemetry_records": 1250,
    "schedules": 3
  }
}
```

## 2. User Management

### List All Users
`GET /api/admin/users`

Returns a list of all registered users.

**Response:**
```json
{
  "ok": true,
  "count": 10,
  "users": [
    {
      "_id": "...",
      "userId8": "12345678",
      "name": "John Doe",
      "email": "john@example.com",
      "role": "user",
      ...
    }
  ]
}
```

### Delete User
`DELETE /api/admin/users/:userId`

Deletes a user by their MongoDB `_id`. THIS IS DESTRUCTIVE.
It will also delete:
- All devices owned by the user
- All telemetry data for those devices
- All schedules created by the user

**Response:**
```json
{
  "ok": true,
  "message": "User, devices, and schedules deleted"
}
```

## 3. Device Management

### List All Devices
`GET /api/admin/devices`

Returns a list of all devices in the system (from `device_config` collection).

**Response:**
```json
{
  "ok": true,
  "count": 5,
  "devices": [
    {
      "_id": "device_id_123",
      "device": { "user_id": "...", ... },
      "actuators": { ... },
      "sensors": [ ... ]
    }
  ]
}
```

### Delete Device
`DELETE /api/admin/devices/:deviceId`

Deletes a device by its ID.
It removes entries from `device_config`, `device_telemetry`, and `device_control`.

**Response:**
```
{
  "ok": true,
  "message": "Device deleted successfully"
}
```

### Get Device Details
`GET /api/admin/devices/:deviceId`

Returns full details for a device, including:
- **Config**: The hardware configuration (actuators, sensors).
- **Control**: The current control state of actuators.
- **Telemetry History**: The last 50 telemetry readings.

**Response:**
```json
{
  "ok": true,
  "device": {
    "config": { ... },
    "control": { ... },
    "telemetry_history": [ ... ]
  }
}
```

### Control Device (Admin Override)
`POST /api/admin/devices/:deviceId/control`

Allows an admin to manually control a device's actuators. This pushes a retained message to the MQTT topic `ts/:deviceId/control`.

**Body:**
```json
{
  "actuators": {
    "fan": { "status": true, "speed": 100 },
    "light": { "status": false }
  }
}
```

**Payload Validation Rules:**
- `actuators` MUST be an object.
- Each key in `actuators` must exist in the target device's hardware configuration (`config.actuators`).
- Each actuator patch value MUST be an object containing key-value updates.

**Response (200 OK):**
```json
{
  "ok": true,
  "control": { ... }
}
```

**Error Response (400 Bad Request):**
```json
{
  "ok": false,
  "error": "Invalid patch for actuator 'fan'"
}
```

### Get Device Telemetry History
`GET /api/admin/devices/:deviceId/telemetry`

Query Parameters:
- `start` (optional): Filter records created after this time (ISO 8601 or timestamp).
- `end` (optional): Filter records created before this time (ISO 8601 or timestamp).
- `limit` (optional): Max records to return (default 100, max 5000).

**Example:** `/api/admin/devices/123/telemetry?start=2024-01-01T00:00:00Z&limit=1000`

**Response:**
```json
{
  "ok": true,
  "deviceId": "123",
  "count": 100,
  "telemetry": [ ... ]
}
```

## 4. Schedule Management

### List All Schedules
`GET /api/admin/schedules`

Returns all schedules in the system.

**Response:**
```json
{
  "ok": true,
  "count": 3,
  "schedules": [ ... ]
}
```

### Delete Schedule
`DELETE /api/admin/schedules/:scheduleId`

Deletes a schedule by its ID.

**Response:**
```json
{
  "ok": true,
  "message": "Schedule deleted successfully"
}
```

## 5. System Health & Infrastructure Diagnostics

### Get System Health
`GET /api/admin/health`

Returns process memory, Node.js uptime, MongoDB stats, and MQTT connection status.

**Response:**
```json
{
  "ok": true,
  "health": {
    "status": "healthy",
    "uptimeSeconds": 86400,
    "memory": { "rssMB": 65, "heapUsedMB": 42, "heapTotalMB": 80 },
    "mongo": { "connected": true, "dataSizeMB": 12, "storageSizeMB": 20, "collections": 11, "objectsCount": 1450 },
    "mqtt": { "connected": true }
  }
}
```

## 6. Advanced User Management & Access Control

### Update User Role
`PUT /api/admin/users/:userId/role`

**Body:**
```json
{ "role": "admin" } // or "user"
```

### Set User Status (Account Suspension)
`PUT /api/admin/users/:userId/status`

Blocks or re-enables a user account without deleting historical data.

**Body:**
```json
{ "status": "disabled" } // or "active"
```

**Response:**
```json
{
  "ok": true,
  "message": "User status set to disabled",
  "user": { "id": "...", "email": "user@example.com", "status": "disabled" }
}
```

### Force Reset User Password
`POST /api/admin/users/:userId/reset-password`

**Body:**
```json
{ "newPassword": "newSecurePassword123" }
```

## 7. Device Transfer & Ownership Management

### Transfer Device Ownership
`PUT /api/admin/devices/:deviceId/transfer`

Reassigns a device from its current owner to another registered user (by `_id` or `userId8`).

**Body:**
```json
{ "targetUserId": "8_char_userId8_or_mongo_id" }
```

**Response:**
```json
{
  "ok": true,
  "message": "Device device_123 transferred to user newowner@example.com",
  "deviceId": "device_123",
  "newOwner": { "id": "...", "email": "newowner@example.com" }
}
```

## 8. Automation Flow Oversight & Management

### List All Automation Flows
`GET /api/admin/automation/flows`

Returns all automation rules across all users, enriched with owner details.

### Toggle Automation Flow Status
`PUT /api/admin/automation/flows/:flowId/toggle`

**Body:**
```json
{ "enabled": false }
```

### Delete Automation Flow
`DELETE /api/admin/automation/flows/:flowId`

Admin force-delete of any user's automation flow.

### Global Automation Execution Logs
`GET /api/admin/automation/logs?status=ran&limit=100`

Query parameters: `flowId`, `deviceId` (matches the sensor or the target device), `status` (`ran` / `skipped` / `error`, case-insensitive), `limit` (default 100, max 1000). Newest first. Logs are kept for 30 days.

## 9. On-Demand Maintenance & System Operations

### Trigger On-Demand Database Backup
`POST /api/admin/maintenance/backup`

Executes full MongoDB database dump backup.

### Trigger On-Demand Telemetry Cleanup
`POST /api/admin/maintenance/clean-telemetry`

**Body:**
```json
{ "daysToKeep": 7 }
```

### Send the Weekly Report Now
`POST /api/admin/maintenance/weekly-report`

**Body (optional):** `{ "userId": "<mongo id>" }` sends the report to that user only, e.g. to check it before Sunday. With no body, every user gets one.

The report also goes out automatically every week, **before** the backup. The backup always runs, even if the reports fail. A user gets at most one report per week, so running this again in the same week sends nothing new.

**Response:** `{ ok, users, queued, skipped, errors }`

### Email Quota Usage
`GET /api/admin/email/stats` returns `{ limit, reserved, sent24h, queued, remaining, alertsAllowed, sendingAllowed, failed24h, sentByCategory }`.

## 10. Audit Logging System

### Get Admin Audit Logs
`GET /api/admin/audit-logs?limit=100`

Query parameters: `action`, `adminEmail`, `targetId`, `limit`. Returns full history of administrative operations.

---

## 11. Emergency & Mass Control Features

### Device Lockout / Unlock
`POST /api/admin/devices/:deviceId/lockout`

Locks or unlocks a device (prevents non-admin interactions on malfunctioning devices).

**Lockout Request Body:**
```json
{ "disabled": true, "reason": "High power consumption spike detected" }
```

**Unlock Request Body:**
```json
{ "disabled": false }
```

**Toggle Mode (Omitting `disabled` flips the current lockout state):**
```json
{}
```

**Response (Unlock):**
```json
{
  "ok": true,
  "message": "Device device_123 has been UNLOCKED",
  "deviceId": "device_123",
  "isDisabled": false
}
```

### Broadcast Emergency Mass Control
`POST /api/admin/broadcast/control`

Sends a control command to ALL devices (or a filtered group of devices) simultaneously over MQTT.

**Body:**
```json
{
  "actuators": { "light": { "status": false }, "main_relay": { "status": false } },
  "filter": {} // optional MongoDB filter query
}
```

**Payload Validation Rules:**
- `actuators` MUST be an object containing actuator patch objects.
- `filter` (optional) can be any valid MongoDB query filter to target specific devices.

**Response (200 OK):**
```json
{
  "ok": true,
  "message": "Broadcast control command sent to 5 devices",
  "affectedCount": 5
}
```

## 12. Safety Rules & Audit Coverage

- Every admin action that changes data is written to `admin_audit_logs` (role, status, password reset, deletes, control, lockout, transfer, broadcast, flows, maintenance).
- An admin cannot demote, disable or delete **themselves**, and the **last active admin** cannot be demoted, disabled or deleted.
- Changing a user's role or resetting their password **logs that user out everywhere** (existing tokens are revoked).
- Deleting a user or device also deletes the automation flows that use those devices.
- Transferring a device to a new owner deletes the previous owner's flows and schedules for that device.
- Broadcast `filter` may not use `$where`, `$function`, `$accumulator` or `$expr`.
- Passwords (reset and registration) must be 8–128 characters.

## 13. Backups

Backups are written to `BACKUP_DIR` (default `./backups`) as `full_db_backup_<timestamp>/<collection>.jsonl`, one document per line in Extended JSON (types preserved). Only the newest `BACKUP_KEEP` (default 8) are kept. Restore a collection with:

```bash
mongoimport --uri "$MONGO_URI" --collection device_config --file device_config.jsonl
```

Backups contain password hashes: keep the folder private.

## Usage

To create the first admin user, run:
```bash
node scripts/create-admin.js <email> <password>
```
Example:
```bash
node scripts/create-admin.js admin@thingsstring.com 'a-long-unique-password'
```

