const { pool } = require("../config/database");
const constants = require("../config/constants");

// Get current game state
exports.getCurrentGameState = async (req, res) => {
    try {
        const result = await pool().query(
            `SELECT round_id, round_number, status, start_time, end_time,
                    winner_amount, total_players, total_bet, winners, drawn_numbers,
                    win_percentage, created_at
             FROM game_rounds 
             WHERE status IN ('selection', 'countdown', 'active')
             ORDER BY round_id DESC LIMIT 1`
        );
        
        if (result.rows.length === 0) {
            return res.json({
                status: 'waiting',
                message: 'No active game. Next round starting soon.'
            });
        }
        
        const round = result.rows[0];
        res.json({
            roundId: round.round_id,
            roundNumber: round.round_number,
            status: round.status,
            startTime: round.start_time,
            totalPlayers: round.total_players,
            totalBet: parseFloat(round.total_bet),
            winnerAmount: parseFloat(round.winner_amount),
            winners: round.winners,
            drawnNumbers: round.drawn_numbers || [],
            winPercentage: round.win_percentage
        });
    } catch (error) {
        console.error("Get current game state error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get round history
exports.getRoundHistory = async (req, res) => {
    const { limit = 20, offset = 0 } = req.query;
    
    try {
        const result = await pool().query(
            `SELECT round_id, round_number, status, start_time, end_time,
                    winner_amount, total_players, total_bet, winners,
                    win_percentage, created_at
             FROM game_rounds 
             WHERE status = 'ended'
             ORDER BY round_id DESC 
             LIMIT $1 OFFSET $2`,
            [parseInt(limit), parseInt(offset)]
        );
        
        const countResult = await pool().query(
            "SELECT COUNT(*) as total FROM game_rounds WHERE status = 'ended'"
        );
        
        res.json({
            rounds: result.rows,
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error("Get round history error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get round details
exports.getRoundDetails = async (req, res) => {
    const { roundId } = req.params;
    
    try {
        const roundResult = await pool().query(
            `SELECT * FROM game_rounds WHERE round_id = $1`,
            [roundId]
        );
        
        if (roundResult.rows.length === 0) {
            return res.status(404).json({ message: "Round not found" });
        }
        
        const participantsResult = await pool().query(
            `SELECT u.username, u.user_id, rp.selected_cartelas, rp.bet_amount, 
                    rp.is_winner, rp.win_amount, rp.joined_at
             FROM round_participants rp
             JOIN users u ON rp.user_id = u.user_id
             WHERE rp.round_id = $1
             ORDER BY rp.is_winner DESC, rp.win_amount DESC`,
            [roundId]
        );
        
        res.json({
            round: roundResult.rows[0],
            participants: participantsResult.rows
        });
    } catch (error) {
        console.error("Get round details error:", error);
        res.status(500).json({ message: "Server error" });
    }
};

// Get player's game history
exports.getPlayerHistory = async (req, res) => {
    const userId = req.user.userId;
    const { limit = 20, offset = 0 } = req.query;
    
    try {
        const result = await pool().query(
            `SELECT rp.round_id, gr.round_number, rp.selected_cartelas, 
                    rp.bet_amount, rp.is_winner, rp.win_amount, rp.joined_at,
                    gr.winner_amount as total_winner_amount, gr.total_players
             FROM round_participants rp
             JOIN game_rounds gr ON rp.round_id = gr.round_id
             WHERE rp.user_id = $1
             ORDER BY rp.joined_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, parseInt(limit), parseInt(offset)]
        );
        
        const countResult = await pool().query(
            "SELECT COUNT(*) as total FROM round_participants WHERE user_id = $1",
            [userId]
        );
        
        res.json({
            history: result.rows,
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error("Get player history error:", error);
        res.status(500).json({ message: "Server error" });
    }
};