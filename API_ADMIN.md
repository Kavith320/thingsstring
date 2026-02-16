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

## usage

To create the first admin user, run:
```bash
node scripts/create-admin.js <email> <password>
```
Example:
```bash
node scripts/create-admin.js admin@thingsstring.com supersecret
```
