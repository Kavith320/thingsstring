# Sharing, Device Alerts & Activity: Frontend Guide

This guide covers device sharing by email invitation, roles, personal offline alerts per device, and the device activity history.

All `/api/...` routes need `Authorization: Bearer <token>` unless marked **no login**.

**Errors:** `{ ok: false, error, code? }`.
- `404`: the device doesn't exist, or the user has no access to it.
- `403` with `code: "DEVICE_ROLE_TOO_LOW"`: the user's role isn't high enough. Hide or disable those buttons.
- `403` with `code: "EMAIL_NOT_VERIFIED"`: the user must verify their email first. Show the verify banner.

---

## 1. Roles

| | Viewer | Operator | Manager | Owner |
|---|:-:|:-:|:-:|:-:|
| See the device, live data, graphs, map, CSV export | ✅ | ✅ | ✅ | ✅ |
| Own name/icon/colour, own groups, own offline alerts | ✅ | ✅ | ✅ | ✅ |
| Switch actuators (`POST /control`) | | ✅ | ✅ | ✅ |
| Schedules and automations that switch this device | | | ✅ | ✅ |
| See members, invite or remove viewers and operators, activity history | | | ✅ | ✅ |
| Invite or remove managers, change any role | | | | ✅ |

- Alert-only automation rules ("email me if…") only need **viewer** access to the sensor device.
- The owner is the account that set up the device. Only an admin can transfer ownership.

**Every device in `GET /api/devices` and `GET /api/devices/:id` now has:**
```json
"role": "operator",
"sharedBy": { "name": "Kavith", "email": "k@example.com" }
```
`sharedBy` is `null` for devices the user owns. Use it to build a **"Shared with me"** section, and use `role` to show or hide buttons.

**Shared users only ever see the devices shared with them.**

---

## 2. Members and invitations (device settings → "Sharing")

### `GET /api/devices/:deviceId/members` (manager+)
```json
{ "ok": true, "deviceId": "d1", "yourRole": "owner",
  "owner":   { "userId": "…", "name": "Kavith", "email": "k@example.com", "avatar": null },
  "members": [ { "userId": "…", "name": "Bob", "email": "bob@x.com", "avatar": null, "role": "operator", "since": "…" } ],
  "invites": [ { "id": "…", "email": "new@x.com", "role": "viewer", "invitedBy": "Kavith", "createdAt": "…", "expiresAt": "…" } ] }
```

### `POST /api/devices/:deviceId/invites` `{ email, role }` (manager+, **verified email required**)
- `role` is `viewer`, `operator` or `manager`. Managers can only invite viewers and operators.
- Sends the invitation email. The link is valid for **7 days**.
- Inviting the same email again **replaces** the old invite (use this as "Resend").
- `409` means that person already has access; change their role instead.

**Limits:**
- 25 people (members plus pending invites) per device.
- **20 invitations per user per day.**
- `503` when the day's email quota is used up.

| Action | Request |
|---|---|
| Cancel a pending invite | `DELETE /api/devices/:deviceId/invites/:inviteId` |
| Change a role | `PATCH /api/devices/:deviceId/members/:userId` `{ role }`. Lowering a manager pauses their schedules and automations on this device. |
| Remove someone | `DELETE /api/devices/:deviceId/members/:userId` |
| **Leave** a shared device | `DELETE /api/devices/:deviceId/members/<my own userId>` |

**When someone is removed or leaves:**
- Their access ends everywhere immediately.
- Their schedules and automation rules on that device are **disabled, not deleted**, with `disabledReason`.
- Their alerts, personal settings and group membership for the device are removed.

---

## 3. Accepting an invitation (the `/invite` page)

The email links to `APP_URL/invite?token=…`. Build this page:

1. **On load,** call `POST /api/invites/lookup` `{ token }` (**no login**):
   ```json
   { "ok": true, "invite": { "email": "new@x.com", "role": "viewer", "deviceId": "d1", "deviceName": "Barn Pump",
     "invitedBy": "Kavith", "expiresAt": "…", "accountExists": false } }
   ```
   Show "**Kavith** invited you to **Barn Pump** as **Viewer**". If the call returns `400`, show "This invitation is invalid or has expired".
2. **`accountExists: false`** (a new person): show a **Create account** form with the email **pre-filled and locked**. Send:
   ```json
   POST /api/auth/register { "name": "…", "email": "new@x.com", "password": "…", "inviteToken": "<token>" }
   ```
   The response has `token`, `user` (with `emailVerified: true`) and `invite: { deviceId, role }`. **Store the token and go straight to the device.** No verification email is needed, because the link already proved the inbox.
3. **`accountExists: true`:** ask the user to **sign in** (Google works too), then call `POST /api/invites/accept` `{ token }`, which returns `{ ok, deviceId, role }`.
   - If they're signed in to a different account, they get `403` "This invitation was sent to …". Offer "Sign out and switch account".
   - Accepting by link also marks the account's email as verified.

**In-app list (optional):**
- `GET /api/invites` lists the pending invitations for the signed-in user's **verified** email.
- `POST /api/invites/:id/accept` and `POST /api/invites/:id/decline` accept or decline them. Accepting this way needs a verified email.

---

## 4. Offline alerts per device (device settings → "Alerts")

Settings are **personal**: each member decides for themselves. They're **off by default**.

```json
GET /api/devices/:deviceId/alerts
{ "ok": true, "deviceId": "d1", "alerts": { "offline": { "enabled": false, "afterMin": 10 }, "updatedAt": null } }

PUT /api/devices/:deviceId/alerts
{ "offline": { "enabled": true, "afterMin": 30 } }
```
- `afterMin` is a whole number of minutes from **2 to 1440**, meaning "email me after N minutes without data".
- Suggested UI: a toggle plus a select with 5 / 10 / 15 / 30 / 60 minutes, 3 h, 6 h, 12 h and 24 h.

**How alerts are sent:**
- One email when the device goes offline, and one "back online" email when it returns.
- At most one offline email per device per user every 30 minutes.
- Turning alerts on while the device is already offline doesn't alert for that outage.
- If every device stops reporting at the same time, that's treated as a server outage and no alerts are sent.

**Turning them off:**
- The email's **"Turn off these emails"** link opens `APP_URL/unsubscribe?token=…`. Calling `POST /api/auth/unsubscribe` `{ token }` (**no login**) turns off alerts **for that device only**. The response includes `deviceId`.
- `PATCH /api/me/notifications { deviceOffline: false }` is a **master switch** that stops all offline alerts for the user.

---

## 5. Activity history (manager+)

`GET /api/devices/:deviceId/activity?limit=50&before=<ISO>&action=<prefix>`
```json
{ "ok": true, "count": 2, "nextBefore": "2026-11-08T10:00:00.000Z", "activity": [
  { "ts": "…", "action": "control.update",
    "actor": { "type": "user", "id": "…", "email": "bob@x.com", "name": "Bob" },
    "details": { "actuators": { "relay1": { "state": "ON" } } } },
  { "ts": "…", "action": "control.update",
    "actor": { "type": "automation", "id": "<flowId>", "name": "Too hot" },
    "details": { "actuators": { "relay1": { "value": true } }, "reading": { "temperature": 41.2 } } } ] }
```
- **Actors:** `user`, `admin`, `automation` (with the rule name) or `schedule` (with the schedule name).
- **Actions:** `control.update`, `schedule.create|update|delete`, `automation.create|update|delete`, `share.invite|accept|decline|role|remove|leave|invite.cancel`, `telemetry.export`, `admin.lock|unlock`.
- **Paging:** pass `nextBefore` as `before` to load older entries.
- **Filtering:** `action=share` returns only sharing events.
- History is kept for **90 days** (`ACTIVITY_TTL_DAYS`).

---

## 6. Schedules on shared devices
- `GET /api/schedules/devices/:id/schedules` lists **all** schedules on the device, from every member. Every role can see them, so people can tell who scheduled what (`user_id`).
- Managers and the owner can create, edit and delete any schedule on the device.
- A disabled schedule may have `disabledReason` (e.g. "access removed"). Turning it back on (`enabled: true`) clears it.
