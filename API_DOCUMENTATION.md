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

## 4. Automation Engine

Polling-based rules to trigger actions based on sensor changes.

### Create Flow
`POST /api/automation/flows`

**Body:**
```json
{
  "name": "Intelligent Fan",
  "deviceId": "SENSOR_HUB_01",
  "intervalSec": 30,
  "metricPath": "data.temp",
  "condition": {
    "operator": ">",
    "value": 30
  },
  "action": {
    "deviceId": "ACTUATOR_HUB_02",
    "actuatorKey": "fan",
    "setValue": true
  },
  "cooldownSec": 300,
  "ui_metadata": { "x": 100, "y": 200 }
}
```
**Notes:** 
- If `condition` is omitted, `deltaThreshold` is used as a fallback.
- `action.deviceId` allows triggering an actuator on a different hub than the sensor.
- `ui_metadata` is an opaque object used for storing canvas layout positions.

### List Flows
`GET /api/automation/flows`

### Update / Delete Flow
`PUT /api/automation/flows/:id` (partial update, the result is re-validated) · `DELETE /api/automation/flows/:id`

### Get Flow Logs
`GET /api/automation/flows/:id/logs?limit=20`
Returns the recent execution history for one of **your** flows (max 500). Logs are kept for 30 days.

**Validation rules (create and update):**
- `deviceId` and `action.deviceId` must both be devices **you own**, otherwise `404`.
- `action.actuatorKey` must exist in the target device's config.
- `intervalSec` is clamped to 5–86400 (default 60); `cooldownSec` to 0–604800 (default 60).
- `condition.operator` must be one of `>`, `<`, `>=`, `<=`, `==`, `!=`.
- If the metric is missing from the latest telemetry, the flow is skipped (it never triggers).

---

## 5. MQTT Protocol (Device Side)

Devices communicate with the server using the `ts/` prefix.

### Device Configuration
**Topic:** `ts/<deviceId>/config` (Publish)
Devices should publish their hardware configuration here. This defines what actuators and sensors are available.

- **Ownership is set by the first config** (`device.user_id`). Later configs cannot change the owner; only an admin transfer can.
- Each re-publish (e.g. after a reboot) resets the listed actuators in `device_control` to their config definition.
- Admin lockout survives config re-publishes.
- Payloads must be a JSON object, max 64 KB.

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
Periodic sensor readings or status updates. The server sets `deviceId` and `createdAt` itself; values for these in the payload are ignored.

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
Devices should subscribe to this topic to receive state changes from the platform. Messages are sent with QoS 1 and the **Retain** flag. The server republishes every device's state whenever it (re)connects to the broker.

**Response Example:**
```json
{
  "actuators": {
    "fan": { "status": true, "speed": 100 },
    "light": { "status": false }
  }
}
```

---

## 6. Platform Systems & Reliability Features

### A. Offline Device Protection
- **Behavior**: Before executing any automation flow or scheduled task, the engine verifies the device's connectivity status based on its latest `telemetry` timestamp.
- **Protection**: If a device is detected as `OFFLINE` (no telemetry within `DEVICE_OFFLINE_THRESHOLD_SEC`, default 300s, or no telemetry at all), automation flows and schedule **start** actions are skipped and logged.
- **Schedule end actions always apply**, even while the device is offline: the retained control message turns the actuator off as soon as the device reconnects.
- **Admin lockout** blocks user control, automation and schedules for that device.
- **Frontend Benefit**: Prevents "ghost execution" bugs, false control triggers, and UI state desynchronization when devices are powered off or disconnected from the network.

### B. Telemetry Retention & Database Optimization
- **Behavior**:
  - `device_telemetry` entries automatically expire and are purged after 7 days via a MongoDB TTL index on `createdAt`.
  - Automatic full database backups are executed weekly (every Sunday at 02:00 AM) to preserve historical snapshots.
- **Frontend Benefit**: Keeps `GET /api/devices/:deviceId/telemetry` queries lightning-fast (<50ms). Telemetry charts and dashboard graphs render smoothly without lag or high memory overhead from bloated database collections.

### C. MQTT Resilience & Real-Time Sync
- **Behavior**: Auto-reconnection, retained QoS 1 control messages on `ts/<deviceId>/control`, and a full republish of every device's desired state on every reconnect, so commands made during a broker outage are delivered when it returns.
- **Frontend Benefit**: Ensures manual control toggles issued via `POST /api/devices/:deviceId/control` reliably reach hardware and sync back to the UI in real time.

---

## Error Codes
- `400`: Bad Request (Invalid parameters)
- `401`: Unauthorized (missing, invalid or revoked token)
- `403`: Forbidden (account suspended, or device locked out by admin)
- `404`: Not Found (resource does not exist **or is not yours**: devices you don't own are reported as not found)
- `429`: Too many login/registration attempts (see `Retry-After` header)
- `409`: Conflict (Duplicate entry)
- `500`: Internal Server Error (details are logged server-side, not returned)

