const express = require("express");
const router = express.Router();
const balanceController = require("../controllers/balanceController");
const auth = require("../middleware/auth");

router.get("/", auth, balanceController.getBalance);
router.post("/add", auth, balanceController.addBalance);

module.exports = router;