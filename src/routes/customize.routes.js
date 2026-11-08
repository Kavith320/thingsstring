// Groups (/api/groups), dashboard layout (/api/dashboard) and custom icons (/api/files/icons)
const express = require("express");
const { requireAuth } = require("../middleware/auth.middleware");
const { rateLimit } = require("../middleware/rateLimit");
const { MAX_IMAGE_BYTES } = require("../services/fileStore");
const c = require("../controllers/customize.controller");

const uploadLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  key: (req) => `upload:user:${req.user.id}`,
  message: "Too many uploads, please wait a few minutes",
});
const rawImage = express.raw({ type: "*/*", limit: MAX_IMAGE_BYTES });

const groups = express.Router();
groups.get("/", requireAuth, c.listGroups);
groups.post("/", requireAuth, c.createGroup);
groups.put("/order", requireAuth, c.reorderGroups);
groups.patch("/:groupId", requireAuth, c.updateGroup);
groups.delete("/:groupId", requireAuth, c.deleteGroup);

const dashboard = express.Router();
dashboard.get("/", requireAuth, c.getDashboard);
dashboard.put("/", requireAuth, c.saveDashboard);

const files = express.Router();
files.get("/icons", requireAuth, c.listIcons);
files.post("/icons", requireAuth, uploadLimit, rawImage, c.uploadIcon);
files.delete("/icons/:fileId", requireAuth, c.deleteIcon);

module.exports = { groups, dashboard, files };
