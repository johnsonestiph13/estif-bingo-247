module.exports = {
    // Game timing
    SELECTION_SECONDS: parseInt(process.env.SELECTION_SECONDS) || 50,
    DRAW_INTERVAL_MS: parseInt(process.env.DRAW_INTERVAL_MS) || 4000,
    NEXT_ROUND_DELAY_SECONDS: parseInt(process.env.NEXT_ROUND_DELAY_SECONDS) || 6,
    
    // Betting
    DEFAULT_BET_AMOUNT: parseInt(process.env.DEFAULT_BET_AMOUNT) || 10,
    DEFAULT_WIN_PERCENTAGE: parseInt(process.env.DEFAULT_WIN_PERCENTAGE) || 75,
    MAX_CARTELAS_PER_PLAYER: 2,
    
    // Game phases
    GAME_PHASES: {
        WAITING: 'waiting',      // Between rounds
        SELECTION: 'selection',  // 50 seconds to select cartelas
        COUNTDOWN: 'countdown',  // Final countdown
        ACTIVE: 'active',        // Drawing numbers
        ENDED: 'ended'           // Round finished
    },
    
    // Number range
    MIN_NUMBER: 1,
    MAX_NUMBER: 75,
    TOTAL_NUMBERS: 75,
    
    // Cartela range
    MIN_CARTELA: 1,
    MAX_CARTELA: 400,
    TOTAL_CARTELAS: 400
};