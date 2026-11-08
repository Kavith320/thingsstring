// src/controllers/customize.controller.js
// Dashboard personalisation: device display settings, device groups, dashboard
// layout, the device map and custom icon uploads. All per user.

const { getDb } = require("../db/mongo");
const { getDeviceStatus } = require("../services/deviceState");
const { serializeUi, validateUiPatch, iconRefsIn } = require("../services/deviceUi");
const { logActivity, actorFromReq } = require("../services/activity");
const { requireDeviceRole, accessibleDevices } = require("../services/deviceAccess");
const { saveImage, deleteFiles } = require("../services/fileStore");
const { sendServerError, parseObjectId, isPlainObject } = require("../utils/http");
const {
  fail,
  reqString,
  optColor,
  parseIconRef,
  assertOwnFiles,
  requireObject,
  sendIfValidation,
} = require("../utils/validate");

const MAX_GROUPS = 100;
const MAX_GROUP_DEVICES = 500;
const MAX_ICONS = 50;
const MAX_LAYOUT_BYTES = 256 * 1024;

function handle(res, e, ctx) {
  if (sendIfValidation(res, e)) return;
  sendServerError(res, e, ctx);
}

const notFound = (res, what = "Device") => res.status(404).json({ ok: false, error: `${what} not found` });

/* ───────────────────────── Device display settings ───────────────────────── */

// GET /api/devices/:deviceId/ui
async function getDeviceUi(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const access = await requireDeviceRole(db, deviceId, req.user.id, "viewer");
    if (access.error) return notFound(res);
    const doc = await db.collection("device_ui").findOne({ _id: deviceId });
    return res.json({ ok: true, deviceId, role: access.role, canEdit: ["owner", "manager"].includes(access.role), ui: serializeUi(doc) });
  } catch (e) {
    return handle(res, e, "get device ui");
  }
}

// PATCH /api/devices/:deviceId/ui   (owner or manager; everyone with access sees the result)
async function updateDeviceUi(req, res) {
  try {
    const db = getDb();
    const { deviceId } = req.params;
    const access = await requireDeviceRole(db, deviceId, req.user.id, "manager");
    if (access.error) {
      return access.status === 404 ? notFound(res) : res.status(403).json({ ok: false, error: access.error, code: access.code });
    }

    const { $set, iconRefs } = validateUiPatch(req.body);
    // New uploaded icons must be the editor's own; icons already on the device may stay
    // (e.g. a manager renaming a device whose icon the owner uploaded)
    const col = db.collection("device_ui");
    const current = await col.findOne({ _id: deviceId });
    const kept = iconRefsIn(current);
    await assertOwnFiles(db, req.user.id, iconRefs.filter((r) => !kept.has(r.value)), "icon");

    const doc = await col.findOneAndUpdate(
      { _id: deviceId },
      { $set: { ...$set, deviceId, updatedBy: req.user.id, updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" }
    );
    await logActivity(db, { deviceId, actor: actorFromReq(req), action: "settings.update", details: { changed: Object.keys($set) } });
    return res.json({ ok: true, deviceId, ui: serializeUi(doc) });
  } catch (e) {
    return handle(res, e, "update device ui");
  }
}

// GET /api/devices/map — devices that have a location, for the map view
async function getDeviceMap(req, res) {
  try {
    const db = getDb();
    const roles = await accessibleDevices(db, req.user.id);
    const mine = await db
      .collection("device_ui")
      .find({ _id: { $in: [...roles.keys()] }, location: { $ne: null } })
      .toArray();
    const statuses = await Promise.all(mine.map((d) => getDeviceStatus(db, d.deviceId)));

    const devices = mine.map((d, i) => ({
      deviceId: d.deviceId,
      role: roles.get(d.deviceId),
      displayName: d.displayName || null,
      icon: d.icon || null,
      color: d.color || null,
      location: d.location,
      status: statuses[i],
    }));
    return res.json({ ok: true, count: devices.length, devices });
  } catch (e) {
    return handle(res, e, "device map");
  }
}

/* ───────────────────────────────── Groups ───────────────────────────────── */

function serializeGroup(g, ownedIds) {
  return {
    id: g._id,
    name: g.name,
    icon: g.icon || null,
    color: g.color || null,
    order: g.order ?? 0,
    collapsed: !!g.collapsed,
    deviceIds: ownedIds ? g.deviceIds.filter((id) => ownedIds.has(id)) : g.deviceIds,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** Every device the user can see (owned or shared): groups may hold any of them. */
async function ownedDeviceIdSet(db, userId) {
  return new Set((await accessibleDevices(db, userId)).keys());
}

/** Validate group fields; `partial` for PATCH. Returns { fields, iconRefs }. */
async function validateGroup(db, userId, body, { partial }) {
  requireObject(body);
  const fields = {};
  const iconRefs = [];

  if (!partial || body.name !== undefined) fields.name = reqString(body.name, "name", { max: 60 });
  if (body.icon !== undefined) {
    const icon = parseIconRef(body.icon, "icon");
    iconRefs.push({ ...icon, field: "icon" });
    fields.icon = icon.value;
  }
  if (body.color !== undefined) fields.color = optColor(body.color, "color");
  if (body.collapsed !== undefined) {
    if (typeof body.collapsed !== "boolean") fail("'collapsed' must be true or false");
    fields.collapsed = body.collapsed;
  }
  if (body.order !== undefined) {
    if (!Number.isInteger(body.order) || body.order < 0 || body.order > 100000) fail("'order' must be an integer 0-100000");
    fields.order = body.order;
  }
  if (body.deviceIds !== undefined) {
    const ids = body.deviceIds;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !x)) fail("'deviceIds' must be an array of device ids");
    if (ids.length > MAX_GROUP_DEVICES) fail(`A group can hold at most ${MAX_GROUP_DEVICES} devices`);
    const unique = [...new Set(ids)];
    const owned = await ownedDeviceIdSet(db, userId);
    const bad = unique.find((id) => !owned.has(id));
    if (bad) fail(`Device '${bad}' not found`);
    fields.deviceIds = unique;
  }

  await assertOwnFiles(db, userId, iconRefs, "icon");
  return fields;
}

// GET /api/groups
async function listGroups(req, res) {
  try {
    const db = getDb();
    const [groups, owned] = await Promise.all([
      db.collection("device_groups").find({ user_id: req.user.id }).sort({ order: 1, createdAt: 1 }).toArray(),
      ownedDeviceIdSet(db, req.user.id),
    ]);
    return res.json({ ok: true, count: groups.length, groups: groups.map((g) => serializeGroup(g, owned)) });
  } catch (e) {
    return handle(res, e, "list groups");
  }
}

// POST /api/groups  { name, icon?, color?, deviceIds?, order?, collapsed? }
async function createGroup(req, res) {
  try {
    const db = getDb();
    const col = db.collection("device_groups");
    const count = await col.countDocuments({ user_id: req.user.id });
    if (count >= MAX_GROUPS) fail(`You can have at most ${MAX_GROUPS} groups`);

    const fields = await validateGroup(db, req.user.id, req.body, { partial: false });
    const now = new Date();
    const doc = {
      user_id: req.user.id,
      icon: null,
      color: null,
      collapsed: false,
      deviceIds: [],
      order: count,
      ...fields,
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await col.insertOne(doc);
    return res.status(201).json({ ok: true, group: serializeGroup({ ...doc, _id: insertedId }) });
  } catch (e) {
    return handle(res, e, "create group");
  }
}

// PATCH /api/groups/:groupId
async function updateGroup(req, res) {
  try {
    const db = getDb();
    const id = parseObjectId(req.params.groupId);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid group id" });

    const fields = await validateGroup(db, req.user.id, req.body, { partial: true });
    if (!Object.keys(fields).length) fail("Nothing to update");

    const group = await db
      .collection("device_groups")
      .findOneAndUpdate({ _id: id, user_id: req.user.id }, { $set: { ...fields, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!group) return notFound(res, "Group");
    return res.json({ ok: true, group: serializeGroup(group) });
  } catch (e) {
    return handle(res, e, "update group");
  }
}

// DELETE /api/groups/:groupId  (the devices themselves are not touched)
async function deleteGroup(req, res) {
  try {
    const id = parseObjectId(req.params.groupId);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid group id" });
    const r = await getDb().collection("device_groups").deleteOne({ _id: id, user_id: req.user.id });
    if (!r.deletedCount) return notFound(res, "Group");
    return res.json({ ok: true });
  } catch (e) {
    return handle(res, e, "delete group");
  }
}

// PUT /api/groups/order  { groupIds: [...] }  — drag-and-drop reorder in one call
async function reorderGroups(req, res) {
  try {
    const { groupIds } = requireObject(req.body);
    if (!Array.isArray(groupIds) || groupIds.length > MAX_GROUPS) fail("'groupIds' must be an array of group ids");
    const ids = groupIds.map((g) => parseObjectId(g));
    if (ids.some((x) => !x)) fail("'groupIds' contains an invalid id");

    const col = getDb().collection("device_groups");
    if (ids.length) {
      await col.bulkWrite(
        ids.map((_id, order) => ({ updateOne: { filter: { _id, user_id: req.user.id }, update: { $set: { order } } } }))
      );
    }
    return listGroups(req, res);
  } catch (e) {
    return handle(res, e, "reorder groups");
  }
}

/* ─────────────────────────────── Dashboard ─────────────────────────────── */

// GET /api/dashboard
async function getDashboard(req, res) {
  try {
    const doc = await getDb().collection("dashboards").findOne({ _id: req.user.id });
    return res.json({
      ok: true,
      layout: doc ? JSON.parse(doc.layoutJson) : null,
      updatedAt: doc?.updatedAt || null,
    });
  } catch (e) {
    return handle(res, e, "get dashboard");
  }
}

// PUT /api/dashboard  { layout: <any JSON object or array> }
// The layout is the frontend's own format (e.g. react-grid-layout items); the
// server stores it as-is (as a JSON string, so its keys never reach a query).
async function saveDashboard(req, res) {
  try {
    const { layout } = requireObject(req.body);
    if (!isPlainObject(layout) && !Array.isArray(layout)) fail("'layout' must be a JSON object or array");
    const layoutJson = JSON.stringify(layout);
    if (Buffer.byteLength(layoutJson) > MAX_LAYOUT_BYTES) fail("'layout' is larger than 256 KB");

    const updatedAt = new Date();
    await getDb()
      .collection("dashboards")
      .updateOne({ _id: req.user.id }, { $set: { layoutJson, updatedAt } }, { upsert: true });
    return res.json({ ok: true, layout, updatedAt });
  } catch (e) {
    return handle(res, e, "save dashboard");
  }
}

/* ─────────────────────────────── Custom icons ─────────────────────────────── */

const iconOf = (f) => ({ id: f._id, ref: `file:${f._id}`, url: `/files/${f._id}`, mime: f.mime, size: f.size, createdAt: f.createdAt });

// GET /api/files/icons
async function listIcons(req, res) {
  try {
    const files = await getDb().collection("files").find({ user_id: req.user.id, kind: "icon" }).sort({ createdAt: -1 }).toArray();
    return res.json({ ok: true, count: files.length, icons: files.map(iconOf) });
  } catch (e) {
    return handle(res, e, "list icons");
  }
}

// POST /api/files/icons  (raw image body)
async function uploadIcon(req, res) {
  try {
    const db = getDb();
    const count = await db.collection("files").countDocuments({ user_id: req.user.id, kind: "icon" });
    if (count >= MAX_ICONS) fail(`You can upload at most ${MAX_ICONS} icons; delete one first`);
    const file = await saveImage(db, req.body, { userId: req.user.id, kind: "icon" });
    return res.status(201).json({ ok: true, icon: iconOf(file) });
  } catch (e) {
    return handle(res, e, "upload icon");
  }
}

// DELETE /api/files/icons/:fileId  (cards/groups still using it fall back to no icon)
async function deleteIcon(req, res) {
  try {
    const { fileId } = req.params;
    if (!/^[a-f0-9]{32}$/.test(fileId)) return notFound(res, "Icon");
    const n = await deleteFiles(getDb(), { _id: fileId, user_id: req.user.id, kind: "icon" });
    if (!n) return notFound(res, "Icon");
    return res.json({ ok: true });
  } catch (e) {
    return handle(res, e, "delete icon");
  }
}

module.exports = {
  getDeviceUi,
  updateDeviceUi,
  getDeviceMap,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  getDashboard,
  saveDashboard,
  listIcons,
  uploadIcon,
  deleteIcon,
};
