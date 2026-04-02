const { pool } = require("../config/database");

// Get user balance
exports.getBalance = async (req, res) => {
    const userId = req.user.userId;
    
    try {
        const result = await pool().query(
            "SELECT balance, total_won, total_played, games_won FROM users WHERE user_id = $1",
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        
        res.json({
            balance: parseFloat(result.rows[0].balance),
            totalWon: parseFloat(result.rows[0].total_won),
            totalPlayed: result.rows[0].total_played,
            gamesWon: result.rows[0].games_won
        });
    } catch (error) {
        console.error("Get balance error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Add balance (deposit)
exports.addBalance = async (req, res) => {
    const userId = req.user.userId;
    const { amount, description } = req.body;
    
    if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
    }
    
    const client = await pool().connect();
    
    try {
        await client.query("BEGIN");
        
        // Get current balance
        const userResult = await client.query(
            "SELECT balance FROM users WHERE user_id = $1 FOR UPDATE",
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "User not found" });
        }
        
        const currentBalance = parseFloat(userResult.rows[0].balance);
        const newBalance = currentBalance + amount;
        
        // Update balance
        await client.query(
            "UPDATE users SET balance = $1 WHERE user_id = $2",
            [newBalance, userId]
        );
        
        // Record transaction
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, 'deposit', amount, currentBalance, newBalance, description || 'Balance deposit']
        );
        
        await client.query("COMMIT");
        
        res.json({
            success: true,
            newBalance,
            message: `Added ${amount} ETB to your balance`
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Add balance error:", error);
        res.status(500).json({ message: "Server error" });
    } finally {
        client.release();
    }
};

// Get transaction history
exports.getTransactionHistory = async (req, res) => {
    const userId = req.user.userId;
    const { limit = 50, offset = 0 } = req.query;
    
    try {
        const result = await pool().query(
            `SELECT transaction_id, type, amount, balance_before, balance_after, 
                    description, created_at
             FROM transactions 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2 OFFSET $3`,
            [userId, parseInt(limit), parseInt(offset)]
        );
        
        const countResult = await pool().query(
            "SELECT COUNT(*) as total FROM transactions WHERE user_id = $1",
            [userId]
        );
        
        res.json({
            transactions: result.rows,
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error("Get transaction history error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Withdraw balance
exports.withdrawBalance = async (req, res) => {
    const userId = req.user.userId;
    const { amount, description } = req.body;
    
    if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
    }
    
    const client = await pool().connect();
    
    try {
        await client.query("BEGIN");
        
        const userResult = await client.query(
            "SELECT balance FROM users WHERE user_id = $1 FOR UPDATE",
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "User not found" });
        }
        
        const currentBalance = parseFloat(userResult.rows[0].balance);
        
        if (currentBalance < amount) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Insufficient balance" });
        }
        
        const newBalance = currentBalance - amount;
        
        await client.query(
            "UPDATE users SET balance = $1 WHERE user_id = $2",
            [newBalance, userId]
        );
        
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, 'withdraw', amount, currentBalance, newBalance, description || 'Balance withdrawal']
        );
        
        await client.query("COMMIT");
        
        res.json({
            success: true,
            newBalance,
            message: `Withdrawn ${amount} ETB from your balance`
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Withdraw balance error:", error);
        res.status(500).json({ message: "Server error" });
    } finally {
        client.release();
    }
};