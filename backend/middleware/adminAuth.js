const jwt = require("jsonwebtoken");
const { pool } = require("../config/database");

module.exports = async (req, res, next) => {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    
    if (!token) {
        return res.status(401).json({ message: "Access denied" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        const [users] = await pool.execute(
            "SELECT role FROM users WHERE user_id = ?",
            [decoded.userId]
        );
        
        if (users.length === 0 || users[0].role !== 'admin') {
            return res.status(403).json({ message: "Admin access required" });
        }
        
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: "Invalid token" });
    }
};