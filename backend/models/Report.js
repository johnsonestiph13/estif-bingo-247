// Report model
const ReportModel = {
    tableName: "daily_reports",
    fields: {
        report_id: "SERIAL PRIMARY KEY",
        report_date: "DATE UNIQUE NOT NULL",
        total_rounds: "INTEGER DEFAULT 0",
        total_players: "INTEGER DEFAULT 0",
        total_bet: "DECIMAL(10,2) DEFAULT 0",
        total_won: "DECIMAL(10,2) DEFAULT 0",
        total_commission: "DECIMAL(10,2) DEFAULT 0",
        report_data: "JSONB",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    
    // Report types
    types: {
        DAILY: "daily",
        WEEKLY: "weekly",
        MONTHLY: "monthly",
        CUSTOM: "custom"
    },
    
    // Generate report summary
    generateSummary: (data) => {
        return {
            totalRounds: data.total_rounds || 0,
            totalPlayers: data.total_players || 0,
            totalBet: parseFloat(data.total_bet || 0),
            totalWon: parseFloat(data.total_won || 0),
            totalCommission: parseFloat(data.total_commission || 0),
            platformRevenue: parseFloat(data.total_bet || 0) - parseFloat(data.total_won || 0),
            averagePlayersPerRound: data.total_rounds > 0 
                ? Math.round((data.total_players || 0) / data.total_rounds) 
                : 0,
            averageBetPerRound: data.total_rounds > 0 
                ? parseFloat((data.total_bet || 0) / data.total_rounds).toFixed(2) 
                : 0
        };
    }
};

module.exports = ReportModel;