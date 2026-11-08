# ThingsString Backend

IoT backend: REST API, MQTT device gateway, schedules and automation rules, on MongoDB.

## Processes

| Process | Production command | Role |
|---|---|---|
| API | `npm start` | REST API. **The only process that talks to MQTT**: stores device config/telemetry and publishes `device_control` changes to `ts/<id>/control`. |
| Scheduler | `npm run start:worker` | Runs schedules and the weekly backup + telemetry cleanup, and **sends queued emails** (`email_outbox`). Writes `device_control` only. |
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

## Email (Brevo)

1. In Brevo: add and authenticate the domain `thingsstring.com` (copy the DNS records it shows into your DNS, "DNS only"), then create an SMTP key under **SMTP & API**.
2. Put the `SMTP_*`, `MAIL_FROM`, `MAIL_REPLY_TO` and `APP_URL` lines from `.env.example` into `.env` on the server.
3. `npm run email:test -- you@example.com` sends one test email directly.
4. `pm2 restart thingsstring-scheduler --update-env`. The scheduler sends queued emails every 5 s; its log shows `📧 SMTP ready` or the error.

Emails are queued in `email_outbox` and retried after 1, 5 and 30 minutes. The message body is erased once sent, and rows are deleted after 30 days. Failed rows keep `lastError`.

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
- [SHARING_FRONTEND_GUIDE.md](SHARING_FRONTEND_GUIDE.md): sharing by invitation, roles, per-device alerts, activity history
- [PERSONALISATION_FRONTEND_GUIDE.md](PERSONALISATION_FRONTEND_GUIDE.md): profile, theme, device names/icons/colours, groups, dashboard layout, map, uploads
