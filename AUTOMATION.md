# Automation Engine v1

This add-on implements a polling-based automation engine for ThingsString.

## Components
1. **API**: REST endpoints under `/api/automation/flows` to manage automation rules.
2. **Worker**: A background process (`src/automation/worker.js`) that runs flows using Agenda.

## Running the Automation Worker
To start the automation worker in dev mode:
```bash
npm run automation-worker
```

In production:
```bash
node src/automation/worker.js
```

## API Usage Examples

### Create a Flow
**POST** `/api/automation/flows`
```json
{
  "name": "Temperature Control",
  "deviceId": "ESP32_01",
  "intervalSec": 10,
  "metricPath": "data.temperature",
  "deltaThreshold": 0.5,
  "action": {
    "actuatorKey": "fan",
    "setValue": true
  },
  "cooldownSec": 300
}
```

### List Flows
**GET** `/api/automation/flows`

### Flow Logic
- The worker polls the latest telemetry for the specified `deviceId` every `intervalSec`.
- It extracts the value from the telemetry payload using `metricPath`.
- It calculates `delta = abs(currentValue - lastValue)`.
- If `delta > deltaThreshold` AND `cooldownSec` has passed:
  - It checks if the actuator is in `auto` mode in `device_control`.
  - If yes, it updates `device_control.actuators.<actuatorKey>.value` to `setValue`.
- All actions are logged in the `automation_flow_logs` collection.

## Database Collections
- `automation_flows`: Flow definitions.
- `automation_flow_state`: Stores `lastValue` and `lastActionTs` for each flow.
- `automation_flow_logs`: History of flow executions.
- `automation_jobs`: Agenda job definitions for the automation worker.
