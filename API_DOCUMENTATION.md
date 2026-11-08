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
`GET /api/devices/:deviceId/telemetry`

The endpoint has two modes.

**1. Latest readings (live polling):** `?limit=N`
Returns the newest `N` raw telemetry documents, **newest first**. `limit` is 1–500, default 50.

```json
{ "ok": true, "deviceId": "device_123", "count": 20, "telemetry": [ { "_id": "...", "deviceId": "device_123", "createdAt": "2026-11-08T10:00:05.000Z", "temperature": 24.5, "fw": "1.0.0" } ] }
```

**2. Time range (graphs):** `?from=<date>&to=<date>&maxPoints=<n>`

| Param | Required | Description |
|---|---|---|
| `from` | yes (turns on range mode) | Start of the range: ISO 8601 (`2026-11-08T00:00:00Z`) or epoch milliseconds. |
| `to` | no | End of the range, same formats. Defaults to now. |
| `maxPoints` | no | Most points to return. 10–5000, default 1000. |

`limit` is ignored in range mode. Invalid dates, `from` after `to`, or `to` without `from` return `400`.

- If the range holds `maxPoints` documents or fewer, they are returned **raw**, **oldest first**, with every field.
- If it holds more, the server **downsamples**: the range is split into equal time buckets of `bucketMs = ceil((to - from) / maxPoints)` milliseconds, starting at `from`, and each bucket becomes one point. A point contains the **average of every top-level numeric field**, plus `createdAt` (the bucket start) and `count` (readings in the bucket). Strings, booleans and nested objects (e.g. `actuators`) are left out. Empty buckets are omitted, so gaps mean the device sent nothing.

Example: `GET /api/devices/device_123/telemetry?from=2026-11-07T10:00:00Z&to=2026-11-08T10:00:00Z&maxPoints=500`

```json
{
  "ok": true,
  "deviceId": "device_123",
  "count": 500,
  "downsampled": true,
  "bucketMs": 172800,
  "from": "2026-11-07T10:00:00.000Z",
  "to": "2026-11-08T10:00:00.000Z",
  "retentionDays": 7,
  "telemetry": [
    { "createdAt": "2026-11-07T10:00:00.000Z", "count": 35, "temperature": 24.31, "humidity": 60.2, "rssi": -47.1 },
    { "createdAt": "2026-11-07T10:02:52.800Z", "count": 34, "temperature": 24.36, "humidity": 60.0, "rssi": -46.8 }
  ]
}
```

`downsampled` is `false` and `bucketMs` is `null` when raw documents are returned. `retentionDays` is how long telemetry is kept (older readings no longer exist), so a "30d" or "All" view can never show more than this.

### Download Telemetry as CSV
`GET /api/devices/:deviceId/telemetry/export`

Downloads the device's raw readings as a CSV file, **oldest first**.

| Param | Required | Description |
|---|---|---|
| `from` | no | Start (ISO 8601 or epoch ms). Omit to export everything still stored (see `retentionDays`). |
| `to` | no | End, same formats. Defaults to now. |

- Columns: `createdAt` (ISO, UTC) first, then every field the device has ever sent in the range, sorted by name. Nested objects become dotted columns (`actuators.relay1.state`); arrays are written as JSON. A reading without a field leaves that cell empty.
- The file is UTF-8 with a BOM, so it opens correctly in Excel. Text cells that start with `=`, `+`, `-` or `@` get a leading `'` so spreadsheets never run them as formulas.
- Response headers: `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="<deviceId>_telemetry_<time>.csv"`.
- Errors are JSON: `400` (bad dates), `401`, `404` (not your device), `429` (more than 10 exports per user in 10 minutes).

The endpoint needs the `Authorization` header, so a plain `<a href>` link won't work. Download it with `fetch`:

```js
async function downloadCsv(deviceId, token, { from, to } = {}) {
  const qs = new URLSearchParams();
  if (from) qs.set("from", new Date(from).toISOString());
  if (to) qs.set("to", new Date(to).toISOString());
  const res = await fetch(`${API}/api/devices/${deviceId}/telemetry/export?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error((await res.json()).error);
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition"))?.[1] || "telemetry.csv";
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}
```

### Update Device Control (Command)
`POST /api/devices/:deviceId/control`
Updates the desired state of actuators on a device.

**Body:**
```json
{
  "actuators": {
    "fan": { "state": "ON", "auto": false }
  }
}
```
**Notes:**
- Actuator names must exist in the device's configuration. Field names inside an actuator are free-form: the backend stores whatever fields you send (`state`, `auto`, `speed`, ...) and the device firmware decides what they mean. Field names may not contain `.` or start with `$`.
- `auto: false` switches the actuator to manual mode, so automation flows and schedules leave it alone.
- The change is saved and published as a retained message to `ts/:deviceId/control` via MQTT.
- Returns `403` if an admin has locked the device.

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
    { "actuator": "fan", "set": { "state": "ON" } }
  ],
  "duration_sec": 3600,
  "end_actions": [
    { "actuator": "fan", "set": { "state": "OFF" } }
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
    "fan": { "type": "relay", "default": { "state": "OFF", "auto": true }, "state": "ON", "auto": false }
  }
}
```
The payload is the device's whole control document: each actuator's definition from its config plus the fields set through the API.

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

