const express = require("express");
const router = express.Router();
const gameController = require("../controllers/gameController");
const auth = require("../middleware/auth");
const { validateGameCreation } = require("../middleware/validation");

// Public routes (no auth required for game state)
router.get("/current", gameController.getCurrentGameState);
router.get("/history", gameController.getRoundHistory);
router.get("/round/:roundId", gameController.getRoundDetails);

// Protected routes (require authentication)
router.get("/my-history", auth, gameController.getPlayerHistory);

module.exports = router;