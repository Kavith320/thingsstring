const router = require("express").Router();
const { requireAuth } = require("../middleware/auth.middleware");
const {
    createFlow,
    listFlows,
    getFlow,
    updateFlow,
    deleteFlow,
    getFlowLogs
} = require("../controllers/automation.controller");

// All routes require authentication
router.use(requireAuth);

router.post("/flows", createFlow);
router.get("/flows", listFlows);
router.get("/flows/:id", getFlow);
router.put("/flows/:id", updateFlow);
router.delete("/flows/:id", deleteFlow);
router.get("/flows/:id/logs", getFlowLogs);

module.exports = router;
