const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const auth = require("../middleware/auth");

router.post("/login", authController.login);
router.post("/admin-login", authController.adminLogin);
router.post("/change-password", auth, authController.changePassword);

module.exports = router;