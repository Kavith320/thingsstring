# ThingsString Backend

IoT backend: REST API, MQTT device gateway, schedules and automation rules, on MongoDB.

## Processes

| Process | Production command | Role |
|---|---|---|
| API | `npm start` | REST API. **The only process that talks to MQTT**: stores device config/telemetry and publishes `device_control` changes to `ts/<id>/control`. |
| Scheduler | `npm run start:worker` | Runs schedules and the weekly backup + telemetry cleanup. Writes `device_control` only. |
| Automation | `npm run start:automation` | Evaluates automation flows. Writes `device_control` only. |

Run exactly **one** API process. The workers need the API running to reach devices.
`npm run dev`, `npm run worker` and `npm run automation-worker` are the nodemon versions for development.

## Setup

```bash
npm ci
cp .env.example .env   # fill it in
node scripts/create-admin.js you@example.com 'a-long-unique-password'
npm start
```

## Tests

```bash
npm test
```

Tests use a throwaway in-memory MongoDB (downloaded on first run) and never read `.env`.

## Running a local copy next to production

Use a **different `MQTT_CLIENT_ID`** and, ideally, a separate database and broker login. With the same client id the broker disconnects production; with the same broker and database a local copy also stores device data and sends commands to real devices.

## Docs

- [API_DOCUMENTATION.md](API_DOCUMENTATION.md): user API and MQTT protocol
- [API_ADMIN.md](API_ADMIN.md): admin API
- [AUTOMATION_FRONTEND_GUIDE.md](AUTOMATION_FRONTEND_GUIDE.md): automation flow editor integration
