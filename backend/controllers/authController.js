const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const { pool } = require("../config/database");

const generateToken = (userId, role) => {
    return jwt.sign(
        { userId, role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );
};

// Player/User login
exports.login = async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
        const [users] = await pool.execute(
            "SELECT * FROM users WHERE email = ? OR username = ?",
            [email, email]
        );

        if (users.length === 0) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        const user = users[0];
        
        if (!user.is_active) {
            return res.status(403).json({ message: "Account disabled. Contact admin." });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        await pool.execute(
            "UPDATE users SET last_seen = NOW() WHERE user_id = ?",
            [user.user_id]
        );

        const token = generateToken(user.user_id, user.role);

        res.json({
            success: true,
            token,
            user: {
                id: user.user_id,
                username: user.username,
                email: user.email,
                role: user.role,
                balance: user.balance
            }
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Admin login
exports.adminLogin = async (req, res) => {
    const { email, password } = req.body;

    try {
        const [users] = await pool.execute(
            "SELECT * FROM users WHERE email = ? AND role = 'admin'",
            [email]
        );

        if (users.length === 0) {
            return res.status(401).json({ message: "Invalid admin credentials" });
        }

        const admin = users[0];
        const isValidPassword = await bcrypt.compare(password, admin.password_hash);

        if (!isValidPassword) {
            return res.status(401).json({ message: "Invalid admin credentials" });
        }

        const token = generateToken(admin.user_id, 'admin');

        res.json({
            success: true,
            token,
            admin: {
                id: admin.user_id,
                email: admin.email,
                username: admin.username
            }
        });
    } catch (error) {
        console.error("Admin login error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Change password
exports.changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    try {
        const [users] = await pool.execute(
            "SELECT password_hash FROM users WHERE user_id = ?",
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const isValid = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isValid) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.execute(
            "UPDATE users SET password_hash = ? WHERE user_id = ?",
            [hashedPassword, userId]
        );

        res.json({ success: true, message: "Password changed successfully" });
    } catch (error) {
        console.error("Change password error:", error);
        res.status(500).json({ message: "Server error" });
    }
};