const { pool } = require("../config/database");
const bcrypt = require("bcryptjs");
const constants = require("../config/constants");

// Get all players
exports.getAllPlayers = async (req, res) => {
    try {
        const [players] = await pool.execute(
            `SELECT user_id, username, email, full_name, phone, 
                    balance, total_won, total_played, games_won, 
                    is_active, created_at, last_seen
             FROM users 
             WHERE role = 'player' 
             ORDER BY created_at DESC`
        );
        res.json(players);
    } catch (error) {
        console.error("Get players error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Create new player
exports.createPlayer = async (req, res) => {
    const { username, email, password, full_name, phone, initialBalance } = req.body;

    try {
        const [existing] = await pool.execute(
            "SELECT user_id FROM users WHERE email = ? OR username = ?",
            [email, username]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({ message: "User already exists" });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await pool.execute(
            `INSERT INTO users (username, email, password_hash, full_name, phone, balance, role)
             VALUES (?, ?, ?, ?, ?, ?, 'player')`,
            [username, email, hashedPassword, full_name, phone, initialBalance || 0]
        );
        
        res.json({ success: true, message: "Player created successfully" });
    } catch (error) {
        console.error("Create player error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Update player balance
exports.updatePlayerBalance = async (req, res) => {
    const { userId, amount, type, description } = req.body;

    try {
        const [users] = await pool.execute(
            "SELECT balance FROM users WHERE user_id = ?",
            [userId]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ message: "Player not found" });
        }
        
        const currentBalance = users[0].balance;
        const newBalance = type === 'add' ? currentBalance + amount : currentBalance - amount;
        
        if (newBalance < 0) {
            return res.status(400).json({ message: "Insufficient balance" });
        }
        
        await pool.execute(
            "UPDATE users SET balance = ? WHERE user_id = ?",
            [newBalance, userId]
        );
        
        await pool.execute(
            `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, type === 'add' ? 'deposit' : 'withdraw', amount, currentBalance, newBalance, description]
        );
        
        res.json({ success: true, newBalance });
    } catch (error) {
        console.error("Update balance error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Toggle player status
exports.togglePlayerStatus = async (req, res) => {
    const { userId, isActive } = req.body;

    try {
        await pool.execute(
            "UPDATE users SET is_active = ? WHERE user_id = ?",
            [isActive, userId]
        );
        
        res.json({ success: true, message: `Player ${isActive ? 'enabled' : 'disabled'}` });
    } catch (error) {
        console.error("Toggle player error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get game stats
exports.getGameStats = async (req, res) => {
    try {
        const [stats] = await pool.execute(
            `SELECT 
                COUNT(*) as total_rounds,
                COALESCE(SUM(total_players), 0) as total_players,
                COALESCE(SUM(total_bet), 0) as total_bet,
                COALESCE(SUM(winner_amount), 0) as total_won,
                COALESCE(SUM(admin_commission), 0) as total_commission
             FROM game_rounds`
        );
        
        const [activePlayers] = await pool.execute(
            "SELECT COUNT(*) as online FROM users WHERE role = 'player' AND last_seen > DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
        );
        
        res.json({
            totalRounds: stats[0].total_rounds,
            totalPlayers: stats[0].total_players,
            totalBet: stats[0].total_bet,
            totalWon: stats[0].total_won,
            totalCommission: stats[0].total_commission,
            onlinePlayers: activePlayers[0].online
        });
    } catch (error) {
        console.error("Get stats error:", error);
        res.status(500).json({ message: "Server error" });
    }
};