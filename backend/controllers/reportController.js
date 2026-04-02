const { pool } = require("../config/database");

// Get daily report
exports.getDailyReport = async (req, res) => {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    try {
        const result = await pool().query(
            `SELECT 
                COUNT(*) as total_rounds,
                COALESCE(SUM(total_players), 0) as total_players,
                COALESCE(SUM(total_bet), 0) as total_bet,
                COALESCE(SUM(winner_amount), 0) as total_won,
                COALESCE(SUM(admin_commission), 0) as total_commission
             FROM game_rounds 
             WHERE DATE(created_at) = $1`,
            [targetDate]
        );
        
        // Get detailed breakdown
        const roundsResult = await pool().query(
            `SELECT round_number, total_players, total_bet, winner_amount, 
                    admin_commission, winners, status, created_at
             FROM game_rounds 
             WHERE DATE(created_at) = $1
             ORDER BY round_number DESC`,
            [targetDate]
        );
        
        res.json({
            date: targetDate,
            summary: result.rows[0],
            rounds: roundsResult.rows
        });
    } catch (error) {
        console.error("Get daily report error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get weekly report
exports.getWeeklyReport = async (req, res) => {
    const { year, week } = req.query;
    const targetYear = year || new Date().getFullYear();
    const targetWeek = week || getWeekNumber(new Date());
    
    try {
        const result = await pool().query(
            `SELECT 
                EXTRACT(YEAR FROM created_at) as year,
                EXTRACT(WEEK FROM created_at) as week,
                COUNT(*) as total_rounds,
                COALESCE(SUM(total_players), 0) as total_players,
                COALESCE(SUM(total_bet), 0) as total_bet,
                COALESCE(SUM(winner_amount), 0) as total_won,
                COALESCE(SUM(admin_commission), 0) as total_commission
             FROM game_rounds 
             WHERE EXTRACT(YEAR FROM created_at) = $1 
               AND EXTRACT(WEEK FROM created_at) = $2
             GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(WEEK FROM created_at)`,
            [parseInt(targetYear), parseInt(targetWeek)]
        );
        
        res.json({
            year: parseInt(targetYear),
            week: parseInt(targetWeek),
            ...(result.rows[0] || { total_rounds: 0, total_players: 0, total_bet: 0, total_won: 0, total_commission: 0 })
        });
    } catch (error) {
        console.error("Get weekly report error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get monthly report
exports.getMonthlyReport = async (req, res) => {
    const { year, month } = req.query;
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || new Date().getMonth() + 1;
    
    try {
        const result = await pool().query(
            `SELECT 
                EXTRACT(YEAR FROM created_at) as year,
                EXTRACT(MONTH FROM created_at) as month,
                COUNT(*) as total_rounds,
                COALESCE(SUM(total_players), 0) as total_players,
                COALESCE(SUM(total_bet), 0) as total_bet,
                COALESCE(SUM(winner_amount), 0) as total_won,
                COALESCE(SUM(admin_commission), 0) as total_commission
             FROM game_rounds 
             WHERE EXTRACT(YEAR FROM created_at) = $1 
               AND EXTRACT(MONTH FROM created_at) = $2
             GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)`,
            [parseInt(targetYear), parseInt(targetMonth)]
        );
        
        // Get daily breakdown for the month
        const dailyResult = await pool().query(
            `SELECT 
                DATE(created_at) as date,
                COUNT(*) as rounds,
                COALESCE(SUM(total_bet), 0) as total_bet,
                COALESCE(SUM(winner_amount), 0) as total_won
             FROM game_rounds 
             WHERE EXTRACT(YEAR FROM created_at) = $1 
               AND EXTRACT(MONTH FROM created_at) = $2
             GROUP BY DATE(created_at)
             ORDER BY date DESC`,
            [parseInt(targetYear), parseInt(targetMonth)]
        );
        
        res.json({
            year: parseInt(targetYear),
            month: parseInt(targetMonth),
            summary: result.rows[0] || { total_rounds: 0, total_players: 0, total_bet: 0, total_won: 0, total_commission: 0 },
            daily: dailyResult.rows
        });
    } catch (error) {
        console.error("Get monthly report error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get date range report
exports.getDateRangeReport = async (req, res) => {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
        return res.status(400).json({ message: "Start date and end date are required" });
    }
    
    try {
        const result = await pool().query(
            `SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_rounds,
                COALESCE(SUM(total_players), 0) as total_players,
                COALESCE(SUM(total_bet), 0) as total_bet,
                COALESCE(SUM(winner_amount), 0) as total_won,
                COALESCE(SUM(admin_commission), 0) as total_commission
             FROM game_rounds 
             WHERE DATE(created_at) BETWEEN $1 AND $2
             GROUP BY DATE(created_at)
             ORDER BY date DESC`,
            [startDate, endDate]
        );
        
        // Calculate totals
        const totals = result.rows.reduce((acc, row) => {
            acc.total_rounds += parseInt(row.total_rounds);
            acc.total_players += parseInt(row.total_players);
            acc.total_bet += parseFloat(row.total_bet);
            acc.total_won += parseFloat(row.total_won);
            acc.total_commission += parseFloat(row.total_commission);
            return acc;
        }, { total_rounds: 0, total_players: 0, total_bet: 0, total_won: 0, total_commission: 0 });
        
        res.json({
            start_date: startDate,
            end_date: endDate,
            daily_data: result.rows,
            totals
        });
    } catch (error) {
        console.error("Get date range report error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get top players report
exports.getTopPlayersReport = async (req, res) => {
    const { limit = 10, sortBy = 'total_won' } = req.query;
    
    try {
        const result = await pool().query(
            `SELECT user_id, username, full_name, balance, total_won, 
                    total_played, games_won, created_at
             FROM users 
             WHERE role = 'player'
             ORDER BY ${sortBy} DESC 
             LIMIT $1`,
            [parseInt(limit)]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error("Get top players report error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Helper function to get week number
function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}