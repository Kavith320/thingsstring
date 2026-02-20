# Automation Engine: Frontend Development Guide

This guide provides the necessary information to build a frontend interface for the ThingsString Automation Engine.

## Base URL
All automation endpoints are prefixed with: `/api/automation`

## Data Models

### Automation Flow Object
```json
{
  "_id": "string (ObjectId)",
  "user_id": "string",
  "name": "string",
  "deviceId": "string",
  "enabled": "boolean",
  "intervalSec": "number (5-3600)",
  "metricPath": "string (dot-notation, e.g., 'data.temp')",
  "deltaThreshold": "number (positive)",
  "action": {
    "actuatorKey": "string (must exist in device_config)",
    "setValue": "boolean | number"
  },
  "cooldownSec": "number (seconds)",
  "createdAt": "date",
  "updatedAt": "date"
}
```

### Flow Log Object
```json
{
  "_id": "string",
  "flowId": "string",
  "ts": "date",
  "status": "ran | skipped | error",
  "reason": "string (optional)",
  "currentValue": "number",
  "previousValue": "number",
  "delta": "number",
  "action": "object (if triggered)"
}
```

## API Endpoints

### 1. List All Flows
`GET /api/automation/flows`
- **Auth**: Bearer Token required.
- **Response**: `{ ok: true, flows: [...] }`

### 2. Create Flow
`POST /api/automation/flows`
- **Body**: 
  ```json
  {
    "name": "My Flow",
    "deviceId": "ESP32_01",
    "intervalSec": 30,
    "metricPath": "temp",
    "deltaThreshold": 1.5,
    "action": {
      "actuatorKey": "relay1",
      "setValue": true
    },
    "cooldownSec": 60
  }
  ```
- **Response**: `{ ok: true, flowId: "..." }`

### 3. Update Flow
`PUT /api/automation/flows/:id`
- **Body**: Any subset of flow fields.
- **Response**: `{ ok: true, flow: { ...updatedFlow } }`

### 4. Delete Flow
`DELETE /api/automation/flows/:id`
- **Response**: `{ ok: true }`

### 5. Get Flow Logs
`GET /api/automation/flows/:id/logs?limit=20`
- **Auth**: Bearer Token required.
- **Response**: `{ ok: true, logs: [...] }`

---

## Frontend Implementation Tips

### 1. Device & Actuator Selection
- Use `GET /api/devices` to fetch the user's devices.
- When a user selects a `deviceId`, look into its `config.actuators` to populate the `actuatorKey` dropdown.
- **Crucial**: Inform the user that the actuator must have `auto: true` in its configuration for the automation to work.

### 2. Metric Path Helper
- The `metricPath` is a dot-notation string used to extract values from the telemetry payload.
- **Suggestion**: Show the user a sample of the "Latest Telemetry" for the selected device so they know what keys are available (e.g., `temp`, `data.humidity`, `vcc`).

### 3. Delta Threshold Explanation
- Explain that the automation triggers only when the difference between the *new* value and the *last processed* value exceeds the `deltaThreshold`.

### 4. Monitoring
- Use the `/logs` endpoint to show a "Last Run" status and a history table in the UI. This helps users verify if their thresholds are too high or if cooldowns are preventing actions.

### 5. Manual vs Auto Toggle
- Since the automation engine only writes to actuators in `auto` mode, provide a way for users to toggle the actuator's mode (this is usually done via the existing `/api/devices/:deviceId/control` endpoint).

## JS Fetch Example
```javascript
const createFlow = async (flowData, token) => {
  const response = await fetch('/api/automation/flows', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(flowData)
  });
  return response.json();
};
```
