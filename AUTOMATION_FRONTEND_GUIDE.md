# Automation Engine v1: Visual Designer Integration Guide

This guide defines the interface between the **React Flow Visual Canvas** and the **Express Backend**.

## 1. Core Data Structure
The frontend should manage the following object structure for every automation flow.

### Automation Flow Object
| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | string | Name of the automation (e.g. "Greenhouse Temp") |
| `deviceId` | string | **Sensor Hub ID.** Provides the telemetry data. |
| `enabled` | boolean | Global toggle for the flow. |
| `intervalSec` | number | Polling rate in seconds (minimum 5s). |
| `metricPath` | string | JSON path to monitor (e.g. `sensors.temp`). |
| `deltaThreshold`| number | (Optional) Fallback: Trigger if change > this value. |
| **`condition`** | object | **NEW.** Logical rule for triggering. |
| `condition.operator`| string | One of: `>`, `<`, `>=`, `<=`, `==`, `!=`. |
| `condition.value`| number | The target value to compare against. |
| `cooldownSec` | number | Seconds to wait before re-triggering. |
| **`action`** | object | Target command details. |
| `action.deviceId` | string | **Actuator Hub ID.** (Can be different hub). |
| `action.actuatorKey`| string | Name of pin/channel (e.g. `relay1`). |
| `action.setValue` | mixed | The command to send (e.g `true`, `1`, `"ON"`). |
| **`ui_metadata`** | object | **IMPORTANT.** Persist nodes/edges coordinates here. |

---

## 2. API Reference

### Create a Flow
`POST /api/automation/flows`
- **Frontend sends**: All fields (including `ui_metadata`). **Do not send `_id`**.
- **Backend returns**: `{ ok: true, flow: { ...object_with_id } }`
- **Tip**: Update your local state with the returned `flow` to get the generated `_id`.

### Update a Flow
`PUT /api/automation/flows/:id`
- **Frontend sends**: Any fields that changed.
- **Backend Note**: The backend will automatically ignore `_id` and `user_id` if you send them in the body, preventing "Immutable Field" errors.
- **Response**: `{ ok: true, flow: { ...updated_object } }`

### List Flows
`GET /api/automation/flows`
- **Response**: `{ ok: true, flows: [...] }`

### Delete Flow
`DELETE /api/automation/flows/:id`
- **Response**: `{ ok: true }`

---

## 3. Integration Rules for Visual Designer

### A. The "Auto Mode" Prerequisite
The backend worker will **only** execute commands if the target actuator is set to `auto` in the device configuration.
- **UI Logic**: When setting up an action node, display a warning: *"Ensure this actuator is in AUTO mode in the Device Panel."*

### B. Canvas Persistence (`ui_metadata`)
To prevent nodes from moving to `(0,0)` on every refresh:
1.  Store your React Flow `nodes` and `edges` inside the `ui_metadata` object.
2.  Send the entire object during `PUT` calls.
3.  The backend stores this as an opaque JSON object.

### C. Standardized Commands
Standardize on the field name **`setValue`** for the command payload. This ensures compatibility with the Execution History logs.

### D. Multi-Hub Logic
The designer now allows cross-device triggering. 
- The top-level `deviceId` remains the **Sensor**.
- The `action.deviceId` is the **Actuator**.
- If the user selects the same hub for both, just set them both to the same ID.

### E. Algebraic Conditions
The backend now supports explicit comparison logic.
- **Node Configuration**: Give users a dropdown for operators (`>`, `<`, `==`, etc.).
- **Fallback**: If the `condition` object is missing, the backend defaults to the `deltaThreshold` logic (triggering if the value *changes* by more than the threshold).
- **Recommendation**: For most automations (e.g., "If Temp > 30"), use the `condition` object. Use `deltaThreshold` only for "Change Detector" style rules.

---

## 4. Error Handling
The backend will never return an empty `{}` for errors. You should expect:
```json
{
  "ok": false, 
  "error": "Detailed description of what went wrong"
}
```
Use this `error` string to show a Toast notification on the frontend.

---

## 5. Backend System Resiliency & Frontend Benefits

| System Feature | How the Backend Operates | How it Helps Frontend Developers |
| :--- | :--- | :--- |
| **Offline Device Protection** | Checks device telemetry freshness before triggering automations or schedules. If a device has missed telemetry beyond the timeout threshold, execution is automatically skipped and logged (`⏭️ [AUTOMATION] Device XXX is OFFLINE...`). | **Prevents UI State Mismatches & Ghost Triggers:** The frontend can display standard `Online`/`Offline` status badges. You don't need to write complex frontend checks to suppress automation calls for offline hardware—the backend guarantees offline devices won't execute phantom commands. |
| **7-Day Telemetry TTL & Auto-Backup** | Automatically purges `device_telemetry` records older than 7 days using MongoDB TTL indexes while running weekly full database backups every Sunday at 02:00 AM. | **Blazing-Fast Charts & Responsive Analytics:** Keeps `GET /api/devices/:deviceId/telemetry` endpoint responses fast (<50ms). Re-rendering telemetry charts (Recharts / Chart.js) remains instant without browser memory strain or API timeouts. |
| **MQTT Connection Resilience** | Backend MQTT client uses auto-reconnect backoff and publishes control states with the **Retain** flag. | **Reliable Real-Time UI Toggles:** Manual toggle switches in your React UI (`POST /api/devices/:deviceId/control`) will reliably reach hardware and reflect immediate status updates when connection restores. |

