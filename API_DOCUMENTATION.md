# ThingsString API Documentation

Welcome to the ThingsString API documentation. This document covers the REST API endpoints and MQTT communication protocol for the ThingsString IoT platform.

## Base URL
- **Production:** `https://api.thingsstring.com` (Example)
- **Local Development:** `http://localhost:4000`

---

## 1. Authentication

All private routes require a `Bearer <token>` in the `Authorization` header.

### Register
`POST /api/auth/register`

**Body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword"
}
```

**Response (201):**
```json
{
  "ok": true,
  "token": "JWT_TOKEN_HERE",
  "user": {
    "id": "mongo_id",
    "userId8": "8_char_user_id",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "user",
    "authProvider": "local"
  }
}
```

### Login
`POST /api/auth/login`

**Body:**
```json
{
  "email": "john@example.com",
  "password": "securepassword"
}
```

**Response (200):** Same as Register.

### Google Authentication
`POST /api/auth/google`

**Body:**
```json
{
  "credential": "GOOGLE_ID_TOKEN"
}
```

### Get Current User
`GET /api/auth/me`
Requires Authorization Header.

---

## 2. Device Management

### List My Devices
`GET /api/devices`
Returns all devices owned by the authenticated user, including their current config, last telemetry, and control state.

**Response (200):**
```json
{
  "ok": true,
  "count": 1,
  "devices": [
    {
      "deviceId": "device_123",
      "config": { ... },
      "last_telemetry": { ... },
      "control": { ... }
    }
  ]
}
```

### Get Device by ID
`GET /api/devices/:deviceId`

### Get Device Telemetry History
`GET /api/devices/:deviceId/telemetry?limit=50`
Query Params: `limit` (max 500, default 50).

### Update Device Control (Command)
`POST /api/devices/:deviceId/control`
Updates the desired state of actuators on a device.

**Body:**
```json
{
  "actuators": {
    "fan": {
      "status": true,
      "speed": 100
    },
    "light": {
      "status": false
    }
  }
}
```
**Note:** Actuator names must exist in the device's configuration. This will publish a retained message to `ts/:deviceId/control` via MQTT.

---

## 3. Scheduling

### Create Schedule
`POST /api/schedules/devices/:deviceId/schedules`

**Body:**
```json
{
  "name": "Morning Fan",
  "cron": "0 8 * * *",
  "timezone": "UTC",
  "enabled": true,
  "actions": [
    { "actuator": "fan", "set": { "status": true } }
  ],
  "duration_sec": 3600,
  "end_actions": [
    { "actuator": "fan", "set": { "status": false } }
  ]
}
```

### List schedules for a Device
`GET /api/schedules/devices/:deviceId/schedules`

### Update Schedule
`PUT /api/schedules/:scheduleId`

### Delete Schedule
`DELETE /api/schedules/:scheduleId`

---

## 5. Automation Engine

Polling-based rules to trigger actions based on sensor changes.

### Create Flow
`POST /api/automation/flows`

**Body:**
```json
{
  "name": "Temp Trigger",
  "deviceId": "ESP32_01",
  "intervalSec": 10,
  "metricPath": "data.temp",
  "deltaThreshold": 1.0,
  "action": {
    "actuatorKey": "fan",
    "setValue": true
  },
  "cooldownSec": 60
}
```

### List Flows
`GET /api/automation/flows`

### Get Flow Logs
`GET /api/automation/flows/:id/logs`
Returns the recent execution history for a specific flow.

---

## 6. MQTT Protocol (Device Side)

Devices communicate with the server using the `ts/` prefix.

### Device Configuration
**Topic:** `ts/<deviceId>/config` (Publish)
Devices should publish their hardware configuration here. This defines what actuators and sensors are available.

**Payload Example:**
```json
{
  "version": "1.0.0",
  "actuators": {
    "fan": { "status": false, "speed": 0 },
    "light": { "status": false }
  },
  "sensors": ["temperature", "humidity"]
}
```

### Telemetry Data
**Topic:** `ts/<deviceId>/telemetry` (Publish)
Periodic sensor readings or status updates.

**Payload Example:**
```json
{
  "temperature": 24.5,
  "humidity": 60,
  "rssi": -45
}
```

### Control Commands
**Topic:** `ts/<deviceId>/control` (Subscribe)
Devices should subscribe to this topic to receive state changes from the platform. These messages are sent with the **Retain** flag by the server.

**Response Example:**
```json
{
  "_id": "device_123",
  "actuators": {
    "fan": { "status": true, "speed": 100 },
    "light": { "status": false }
  }
}
```

---

## Error Codes
- `400`: Bad Request (Invalid parameters)
- `401`: Unauthorized (Missing or invalid token)
- `403`: Forbidden (User does not own the device)
- `404`: Not Found (Device or Schedule does not exist)
- `409`: Conflict (Duplicate entry)
- `500`: Internal Server Error
