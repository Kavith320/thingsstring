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

### Create a Flow (Algebraic Condition)
**POST** `/api/automation/flows`
```json
{
  "name": "Temperature Alert",
  "deviceId": "SENSOR_HUB_01",
  "intervalSec": 10,
  "metricPath": "data.temperature",
  "condition": {
    "operator": ">",
    "value": 35
  },
  "action": {
    "deviceId": "ACTUATOR_HUB_02",
    "actuatorKey": "buzzer",
    "setValue": true
  },
  "cooldownSec": 300
}
```

### List Flows
**GET** `/api/automation/flows`

### Flow Logic
1. **Poll**: The worker fetches the latest telemetry for the source `deviceId` every `intervalSec`.
2. **Evaluate**: 
   - If a `condition` object exists, it compares `currentValue` against `condition.value` using `condition.operator` (`>`, `<`, `==`, etc.).
   - If no condition exists, it calculates `delta = abs(currentValue - lastValue)` and triggers if `delta > deltaThreshold`.
3. **Control**: 
   - It checks if the target actuator (on `action.deviceId`) is in `auto` mode in `device_control`.
   - If yes, it updates the specific `actuatorKey` to `setValue`.
4. **Log**: Every execution (skipped or ran) is recorded in `automation_flow_logs`.

## Database Collections
- `automation_flows`: Flow definitions.
- `automation_flow_state`: Stores `lastValue` and `lastActionTs` for each flow.
- `automation_flow_logs`: History of flow executions.
- `automation_jobs`: Agenda job definitions for the automation worker.
