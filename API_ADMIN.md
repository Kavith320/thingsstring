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

**Response:**
```json
{
  "ok": true,
  "control": { ... }
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

### Force Reset User Password
`POST /api/admin/users/:userId/reset-password`

**Body:**
```json
{ "newPassword": "newSecurePassword123" }
```

## 7. Emergency & Mass Control Features

### Device Lockout / Unlock
`POST /api/admin/devices/:deviceId/lockout`

Locks or unlocks a device (prevents non-admin interactions on malfunctioning devices).

**Body:**
```json
{ "disabled": true, "reason": "High power consumption spike detected" }
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

## Usage

To create the first admin user, run:
```bash
node scripts/create-admin.js <email> <password>
```
Example:
```bash
node scripts/create-admin.js admin@thingsstring.com supersecret
```
