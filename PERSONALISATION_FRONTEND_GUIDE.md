# Personalisation API: Frontend Guide

This guide covers the user profile, app preferences, dashboard customisation (device names, icons, colours, visible and pinned values), device groups, dashboard layout, the device map and image uploads.

Every `/api/...` route needs `Authorization: Bearer <token>`. Errors look like `{ "ok": false, "error": "<message>" }`:
- `400`: invalid input. The message names the field.
- `404`: not found, or not yours.
- `413`: request too large.
- `429`: too many uploads (see the `Retry-After` header).

---

## 1. Icons and colours: shared formats

**Colour:** a hex string, `#rgb`, `#rrggbb` or `#rrggbbaa` (e.g. `"#22c55e"`). Use `null` for no colour.

**Icon reference:** one string, used everywhere an `icon` or `avatar` appears:

| Format | Meaning | How to render |
|---|---|---|
| `"<set>:<name>"` e.g. `"mdi:water-pump"`, `"avatar:robot-3"` | An icon from a set **the frontend ships** | Look it up in your icon library. The backend only checks the format: `set` is `[a-z0-9-]` up to 20 characters, `name` is `[a-z0-9-]` up to 60. |
| `"emoji:🌱"` | An emoji | Show the emoji |
| `"file:<id>"` | An image the user uploaded | `<img src="${API}/files/<id>">` |
| `null` | No icon | Your default |

Built-in avatars are an icon set of your choice, e.g. `avatar:robot-1` … `avatar:robot-12`. Ship the images in the frontend and save the name.

---

## 2. Profile: `/api/me`

### `GET /api/me`
```json
{ "ok": true, "user": {
  "id": "…", "userId8": "AB12CD34", "name": "Kavith", "email": "k@example.com",
  "emailVerified": false, "role": "user", "authProvider": "local", "hasPassword": true,
  "phone": null, "organization": null, "country": null, "bio": null,
  "avatar": "avatar:robot-3",
  "preferences": { "theme": "system", "accentColor": null, "language": "en", "timezone": null, "units": "metric" },
  "createdAt": "…" } }
```
Login, register and Google sign-in responses also include `avatar` and `preferences`, so the app can apply the theme straight after login.

### `PATCH /api/me`: edit info
Send only the fields that change. `""` or `null` clears an optional field.

| Field | Rules |
|---|---|
| `name` | required if sent, up to 60 characters |
| `phone` | digits, spaces, `( ) -`, optional leading `+`, up to 30 characters |
| `organization` | up to 100 characters |
| `country` | up to 60 characters |
| `bio` | up to 300 characters |
| `avatar` | an icon reference (see §1). Use `PUT /api/me/avatar` to upload a photo. |

`email` and `role` can't be changed here and are ignored. Returns `{ ok, user }`.

### `PATCH /api/me/preferences`: theme and app settings
| Field | Values |
|---|---|
| `theme` | `"light"`, `"dark"`, `"system"` |
| `accentColor` | hex colour or `null` |
| `language` | e.g. `"en"`, `"si"`, `"si-LK"` |
| `timezone` | IANA name, e.g. `"Asia/Colombo"`, or `null` |
| `units` | `"metric"`, `"imperial"` |

Returns `{ ok, preferences }`.

### `PUT /api/me/password`
```json
{ "currentPassword": "old", "newPassword": "at-least-8-chars" }
```
- `currentPassword` isn't needed when `hasPassword` is `false` (Google-only accounts setting a password for the first time).
- On success, **every other session is logged out**. The response contains a new `token`: **replace the stored token with it**.
- A wrong current password returns `400`.
- Limit: 10 attempts per 15 minutes.

### `PUT /api/me/avatar`: upload a profile picture
Send the **raw image bytes** as the body, not a form:
```js
await fetch(`${API}/api/me/avatar`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type },
  body: file, // a File from <input type="file">, or a Blob from a canvas
});
```
- PNG, JPEG or WebP only, up to 2 MB. The server checks the actual bytes, so a renamed file is rejected. SVG isn't accepted, because it can contain scripts.
- **Resize before uploading** (e.g. 256×256 on a canvas). The server stores the image as sent.
- Returns `{ ok, user, file: { id, url } }`. The previous uploaded avatar is deleted.

### `DELETE /api/me/avatar`
Removes the avatar and deletes the uploaded file.

---

## 3. Device display settings

These settings **belong to the device**: everyone it's shared with sees the same name, icon, colour, value layout and location. The **owner and managers** can change them; viewers and operators see them read-only (`GET …/ui` returns `canEdit`). They are kept separate from the firmware config, so **a device reboot never resets them**. When an admin transfers a device to another user, the new owner starts with clean settings.

`GET /api/devices` and `GET /api/devices/:deviceId` now also return two objects for every device:
```json
"status": { "online": true, "lastSeen": "2026-11-08T10:00:05.000Z" },
"ui": {
  "displayName": "Greenhouse Pump",
  "description": null,
  "icon": "mdi:water-pump",
  "color": "#22c55e",
  "sensors": [
    { "key": "temperature", "label": "Temp", "unit": "°C", "icon": null, "color": null, "visible": true, "pinned": true },
    { "key": "rssi", "label": null, "unit": null, "icon": null, "color": null, "visible": false, "pinned": false }
  ],
  "actuators": [
    { "key": "relay1", "label": "Pump", "icon": "emoji:💧", "color": null, "visible": true, "pinned": true }
  ],
  "location": { "lat": 6.9271, "lng": 79.8612, "label": "Colombo farm", "address": null },
  "updatedAt": "…"
}
```
A device that was never customised gets the same shape filled with `null` and `[]`.

**How to use it:**
- **Name:** show `ui.displayName || deviceId`.
- **Order = priority:** the order of `sensors` / `actuators` is the order to show them in. Drag-and-drop reordering = save the array in the new order.
- `visible: false` means hide it on the device page.
- `pinned: true` means show it on the dashboard card. Show pinned values in array order and limit how many fit.
- **Values not listed** (new telemetry fields, new actuators) aren't customised yet. Show them after the listed ones as visible and not pinned, or hide them; that's your choice.
- `sensors[].key` is the telemetry field name and may be a nested path like `data.temp`. `actuators[].key` is the actuator name from the device config.
- **Hiding is display only.** Automations, schedules, the CSV export and the API still see every value.

### `PATCH /api/devices/:deviceId/ui`
Send only the fields that change. Each field you send **replaces** the stored one, and `null` clears it. Arrays are replaced whole, so always send the full `sensors` or `actuators` list.
```json
{
  "displayName": "Greenhouse Pump",
  "icon": "mdi:water-pump",
  "color": "#22c55e",
  "sensors": [{ "key": "temperature", "label": "Temp", "unit": "°C", "pinned": true }, { "key": "rssi", "visible": false }],
  "actuators": [{ "key": "relay1", "label": "Pump" }],
  "location": { "lat": 6.9271, "lng": 79.8612, "label": "Colombo farm" }
}
```
**Limits:**
- `displayName` up to 60 characters, `description` up to 300.
- Up to 100 sensors and 100 actuators.
- Labels up to 40 characters, units up to 16.
- `lat` -90..90, `lng` -180..180.
- Entries with `visible` or `pinned` left out default to `true` and `false`.

Returns `{ ok, deviceId, ui }`. `GET /api/devices/:deviceId/ui` returns the same.

### `GET /api/devices/map`: map view
Lists only the devices that have a location:
```json
{ "ok": true, "count": 1, "devices": [
  { "deviceId": "d1", "displayName": "Greenhouse Pump", "icon": "mdi:water-pump", "color": "#22c55e",
    "location": { "lat": 6.9271, "lng": 79.8612, "label": "Colombo farm", "address": null },
    "status": { "online": true, "lastSeen": "…" } } ] }
```
- **Rendering:** with Leaflet + OpenStreetMap tiles, colour each marker by `color` and grey it out when `status.online` is false.
- **Picking a location:** let the user tap the map, or call `navigator.geolocation.getCurrentPosition` from the phone next to the device, then save it with `PATCH …/ui { location }`.

---

## 4. Device groups: `/api/groups`

A group is a named area on the dashboard, e.g. "Greenhouse" or "Barn", with its own icon and colour. A device can be in several groups. Deleting a group doesn't touch its devices.

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/groups` | Lists groups, sorted by `order` |
| `POST` | `/api/groups` | `{ name, icon?, color?, deviceIds?, order?, collapsed? }` returns `201 { group }` |
| `PATCH` | `/api/groups/:id` | any of the fields above |
| `PUT` | `/api/groups/order` | `{ groupIds: [id, id, …] }`: saves a drag-and-drop order in one call, returns the list |
| `DELETE` | `/api/groups/:id` | — |

```json
{ "id": "…", "name": "Greenhouse", "icon": "mdi:sprout", "color": "#16a34a", "order": 0,
  "collapsed": false, "deviceIds": ["d1", "d2"], "createdAt": "…", "updatedAt": "…" }
```
**Rules:**
- `name` up to 60 characters.
- `deviceIds` must be your own devices (otherwise `400`). Duplicates are removed, and the stored order is the order of devices inside the group.
- Up to 100 groups and 500 devices per group.
- `collapsed` is there for remembering a folded section.

Devices in no group are "ungrouped". Work that out on the frontend from `GET /api/devices`.

---

## 5. Dashboard layout: `/api/dashboard`

This stores the dashboard grid **in your own format**. The server saves it exactly as sent and returns it unchanged. With `react-grid-layout`, for example:

```json
PUT /api/dashboard
{ "layout": { "lg": [{ "i": "d1", "x": 0, "y": 0, "w": 4, "h": 2 }], "sm": [ … ], "version": 1 } }
```
- `GET /api/dashboard` returns `{ ok, layout, updatedAt }`. `layout` is `null` until the first save.
- `layout` must be an object or array, up to 256 KB.
- Include a `version` number of your own, so you can migrate old layouts when your format changes.
- Save after a drag ends, with a debounce of about 1 second, not on every move.

---

## 6. Custom icon uploads: `/api/files/icons`

These are for device, sensor, actuator and group icons.

| Method | Path | |
|---|---|---|
| `POST` | `/api/files/icons` | Raw image body, same rules and `fetch` as the avatar upload. Returns `201 { icon: { id, ref, url, mime, size, createdAt } }`. |
| `GET` | `/api/files/icons` | Your uploaded icons, newest first |
| `DELETE` | `/api/files/icons/:id` | Deletes it. Anything still using it should fall back to your default icon. |

- Use `icon.ref` (`"file:<id>"`) as the `icon` value anywhere.
- You can only use **your own** uploaded icons.
- Limits: 50 icons per user, and 30 uploads per 10 minutes.
- Resize icons to about 128×128 before uploading.

## 7. Serving uploaded images: `GET /files/:id`

- **No login is needed**, so these links work directly in `<img src>`.
- The id is 128 bits of randomness, so links can't be guessed. Anyone who has the link can view the image, as with most image hosts.
- Responses are cached permanently: an id always means the same image, and a new upload gets a new id.
