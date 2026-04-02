const express = require("express");
const router = express.Router();
const reportController = require("../controllers/reportController");
const adminAuth = require("../middleware/adminAuth");

router.get("/daily", adminAuth, reportController.getDailyReport);
router.get("/weekly", adminAuth, reportController.getWeeklyReport);
router.get("/monthly", adminAuth, reportController.getMonthlyReport);
router.get("/range", adminAuth, reportController.getDateRangeReport);

module.exports = router;