# Wall display: frontend guide

A wall display is a full-screen, read-only dashboard for a TV or monitor. The owner builds it while logged in, then opens it on any screen through a **public link** that needs no login. Each user has **one wall and one link**.

## 1. Security model

| Rule | How |
|---|---|
| The link can only look | No public route writes anything. Controls are never exposed. |
| Only what's on a tile is sent | The screen gets tile labels, values and device *aliases* (`d1`, `d2`). It never gets device IDs, telemetry keys, the owner's details, locations, schedules or other readings. |
| Only devices you own or manage | `PUT /api/wall` refuses other devices (`403 WALL_DEVICE_NOT_ALLOWED`). This is re-checked while screens are open: a lost device shows as "Not available". |
| Unguessable link | 256-bit random token. It is stored as a SHA-256 hash (for lookup) and AES-256-GCM encrypted (so the owner can copy it again). A database copy alone gives no working link. |
| Token out of logs | The frontend puts it after `#` (`/w#<token>`), so it never reaches the web host. |
| Sessions, not tokens | A screen swaps the token (and PIN) for a signed 30-day session, sent as `Authorization: Wall <session>`. Regenerating or turning off the link, or changing the PIN, ends every session and open stream at once. |
| PIN (optional) | 4 to 8 digits, bcrypt-hashed. After 10 wrong PINs within 15 min, the wall locks for the rest of that window (`429 WALL_PIN_LOCKED`). |
| Abuse limits | Link creation needs a verified email. Rate limits per IP; at most 20 screens per wall, 10 per IP, 500 in total (`WALL_MAX_SCREENS`, `WALL_MAX_SCREENS_PER_IP`, `WALL_MAX_STREAMS`). |
| Account | A disabled or deleted account's link stops. Deleting a user deletes their wall. |

`WALL_SECRET` (optional) sets the key used for link encryption and session signing; it defaults to `JWT_SECRET`. Changing either key logs out every screen; the owner sees "make a new link".

## 2. Owner API (logged in)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/wall` | `{ saved, wall: {title, display, pages}, link: {token, createdAt} \| {token:null, unreadable:true} \| null, pin: {enabled, updatedAt}, screens, lastViewedAt, updatedAt }`. A default wall comes back when none is saved yet. |
| PUT | `/api/wall` | Body `{ title, display, pages }`, validated (400 with a message); unknown fields are dropped. Open screens update right away. |
| POST | `/api/wall/link` | Creates the link, or replaces it (the old one stops). Needs a verified email (`EMAIL_NOT_VERIFIED`). Returns the same shape as GET. |
| DELETE | `/api/wall/link` | Turns the link off. |
| PUT | `/api/wall/pin` | `{ pin: "482913" }`. Every screen must enter the new PIN. |
| DELETE | `/api/wall/pin` | Removes the PIN. |

### Wall shape

```jsonc
{
  "title": "Greenhouse",                          // ≤ 80
  "display": {
    "theme": "dark",                              // auto | light | dark
    "accent": "#22c55e",                          // or null
    "columns": 4,                                 // 2-8
    "textScale": 1,                               // 0.75-2
    "rotateSec": 0,                               // 0 = off, else 5-3600
    "showClock": true, "showFeed": true, "highlightSec": 6, "burnInShift": true,
    "sound": { "enabled": false, "on": "all", "tone": "chime", "volume": 0.6 },   // on: all|alerts, tone: chime|beep|soft
    "voice": { "enabled": false, "on": "all",
               "engine": "natural",                      // natural = Piper voice in the browser | browser = the screen's own voices
               "naturalVoice": "en_US-hfc_female-medium", "volume": 1,
               "rate": 1, "pitch": 1, "lang": "en-GB", "voiceName": null },   // rate/pitch/lang/voiceName: browser engine
    "quietHours": { "enabled": false, "from": "22:00", "to": "06:00" }
  },
  "pages": [                                      // 1-10 pages, ≤ 48 tiles each, ≤ 50 devices in total
    { "id": "p1", "title": "Main", "tiles": [
      { "id": "t1", "type": "sensor", "deviceId": "…", "key": "env.soil", "label": "Soil", "unit": "%",
        "style": "number|gauge|chart", "decimals": 1, "min": 0, "max": 100,
        "warn": { "below": 35 }, "critical": { "below": 30, "above": 80 },
        "size": "s|m|l|t", "icon": "lucide:sprout", "color": "#22c55e", "announce": true },
      { "id": "t2", "type": "actuator", "deviceId": "…", "key": "pump" },
      { "id": "t3", "type": "status", "deviceId": "…" },
      { "id": "t4", "type": "clock" },
      { "id": "t5", "type": "text", "text": "Call 077…" }        // ≤ 300
    ]}
  ]
}
```

Sizes: `s` 1×1, `m` 2×1, `l` 2×2, `t` 1×2.

## 3. Public API (no login)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/public/wall/session` | `{ token, pin? }` → `{ session, expiresAt, title }`. Errors: `404 WALL_NOT_FOUND`, `401 WALL_PIN_REQUIRED`, `401 WALL_PIN_WRONG` (`attemptsLeft`), `429 WALL_PIN_LOCKED`. |
| GET | `/api/public/wall/stream` | Server-Sent Events. Header `Authorization: Wall <session>`. `401 WALL_SESSION_INVALID`: get a new session. `404`: the link is gone. `429/503 WALL_BUSY`. |
| GET | `/api/public/wall/snapshot` | The same data once, for screens that can't stream (cached 3 s). |

### Snapshot

```jsonc
{
  "wall": { "title", "display", "pages": [{ "id", "title", "tiles": [{ "id", "type", "label", "unit", "dev": "d1", … }] }] },
  "devices": { "d1": { "name": "North greenhouse", "online": true, "lastSeen": "ISO" } },
  "values":  { "t1": 31.5, "t2": { "on": true, "auto": false } },
  "history": { "t1": [[ms, value], …] },          // chart tiles: last hour, ≤ 60 points
  "offlineAfterSec": 300, "serverTime": "ISO"
}
```

Labels and units are filled in from the device's display settings when the tile has none. A tile the owner can no longer publish comes back as `{ id, type, size, label, unavailable: true }`.

### Stream events

- `snapshot`: the whole thing (on connect, and after the owner edits the wall).
- `update`: `{ values: {tileId: v}, devices: {d1: {...}}, points: {tileId: [ms, v]}, at }`. Only what changed. Sent on new telemetry (MQTT), actuator changes from any process (change stream), and devices going offline (checked every 10 s).
- `revoked`: `{ reason: "link" | "pin" | "expired" | "account" }`, then the stream closes. On `pin` or `expired`, get a new session (prompting for the PIN). On the others, show "not available".
- A `: ping` comment every 20 s keeps proxies from closing the connection.

Reconnect after a dropped stream (it sends `retry: 5000`). Values are re-checked against the database every minute while screens are open.
