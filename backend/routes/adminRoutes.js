const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const adminAuth = require("../middleware/adminAuth");

router.get("/players", adminAuth, adminController.getAllPlayers);
router.post("/create-player", adminAuth, adminController.createPlayer);
router.post("/update-balance", adminAuth, adminController.updatePlayerBalance);
router.post("/toggle-player", adminAuth, adminController.togglePlayerStatus);
router.get("/stats", adminAuth, adminController.getGameStats);

module.exports = router;