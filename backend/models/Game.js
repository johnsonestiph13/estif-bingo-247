// Game model (database schema reference)
const GameModel = {
    tableName: "game_rounds",
    fields: {
        round_id: "SERIAL PRIMARY KEY",
        round_number: "INTEGER NOT NULL",
        status: "VARCHAR(20) DEFAULT 'waiting'",
        start_time: "TIMESTAMP",
        end_time: "TIMESTAMP",
        winner_amount: "DECIMAL(10,2) DEFAULT 0",
        admin_commission: "DECIMAL(10,2) DEFAULT 0",
        total_players: "INTEGER DEFAULT 0",
        total_bet: "DECIMAL(10,2) DEFAULT 0",
        winners: "JSONB",
        drawn_numbers: "JSONB",
        win_percentage: "INTEGER DEFAULT 75",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    
    // Game phases
    phases: {
        WAITING: "waiting",
        SELECTION: "selection",
        COUNTDOWN: "countdown",
        ACTIVE: "active",
        ENDED: "ended"
    },
    
    // Calculate winner reward
    calculateReward: (totalPlayers, winPercentage, betAmount = 10) => {
        const totalPool = totalPlayers * betAmount;
        const winnerReward = (totalPool * winPercentage) / 100;
        const adminCommission = totalPool - winnerReward;
        
        return { totalPool, winnerReward, adminCommission };
    }
};

module.exports = GameModel;