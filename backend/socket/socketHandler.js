const { pool } = require("../config/database");
const constants = require("../config/constants");

// Global game state - 24/7 continuous
let currentRound = {
    roundId: null,
    roundNumber: 0,
    status: constants.GAME_PHASES.WAITING,
    selectionEndTime: null,
    drawnNumbers: [],
    players: new Map(),  // socketId -> player data
    winners: [],
    timer: null,
    drawInterval: null,
    nextRoundTimeout: null
};

// Initialize or load current round from database
async function initializeOrLoadCurrentRound() {
    try {
        const [rounds] = await pool.execute(
            `SELECT * FROM game_rounds 
             WHERE status IN ('selection', 'countdown', 'active') 
             ORDER BY round_id DESC LIMIT 1`
        );
        
        if (rounds.length > 0) {
            const round = rounds[0];
            currentRound.roundId = round.round_id;
            currentRound.roundNumber = round.round_number;
            currentRound.status = round.status;
            currentRound.drawnNumbers = JSON.parse(round.drawn_numbers || '[]');
            
            console.log(`Loaded existing round ${currentRound.roundNumber} with status ${currentRound.status}`);
            
            // Resume timers if needed
            if (currentRound.status === constants.GAME_PHASES.SELECTION) {
                startSelectionTimer();
            } else if (currentRound.status === constants.GAME_PHASES.ACTIVE) {
                startDrawingTimer();
            }
        } else {
            // Start first round
            await startNewRound();
        }
    } catch (error) {
        console.error("Error loading current round:", error);
        await startNewRound();
    }
}

// Start a new round
async function startNewRound() {
    try {
        // Get next round number
        const [maxRound] = await pool.execute(
            "SELECT COALESCE(MAX(round_number), 0) + 1 as next_round FROM game_rounds"
        );
        const roundNumber = maxRound[0].next_round;
        
        // Create round in database
        const [result] = await pool.execute(
            `INSERT INTO game_rounds (round_number, status, win_percentage) 
             VALUES (?, 'selection', ?)`,
            [roundNumber, constants.DEFAULT_WIN_PERCENTAGE]
        );
        
        currentRound.roundId = result.insertId;
        currentRound.roundNumber = roundNumber;
        currentRound.status = constants.GAME_PHASES.SELECTION;
        currentRound.drawnNumbers = [];
        currentRound.players.clear();
        currentRound.winners = [];
        
        // Set selection end time (50 seconds from now)
        currentRound.selectionEndTime = Date.now() + (constants.SELECTION_SECONDS * 1000);
        
        console.log(`Started new round ${roundNumber} - Selection phase (${constants.SELECTION_SECONDS}s)`);
        
        // Start selection timer
        startSelectionTimer();
        
    } catch (error) {
        console.error("Error starting new round:", error);
    }
}

// Start selection timer (50 seconds for cartela selection)
function startSelectionTimer() {
    if (currentRound.timer) clearInterval(currentRound.timer);
    
    currentRound.timer = setInterval(async () => {
        const now = Date.now();
        const timeLeft = Math.max(0, Math.ceil((currentRound.selectionEndTime - now) / 1000));
        
        // Broadcast time left to all players
        io.emit('selectionTimeLeft', { seconds: timeLeft, round: currentRound.roundNumber });
        
        if (timeLeft <= 0) {
            // Selection phase ended, move to active game
            clearInterval(currentRound.timer);
            currentRound.timer = null;
            await startActiveGame();
        }
    }, 1000);
}

// Start active game (drawing numbers)
async function startActiveGame() {
    currentRound.status = constants.GAME_PHASES.ACTIVE;
    
    // Update database
    await pool.execute(
        "UPDATE game_rounds SET status = 'active', start_time = NOW() WHERE round_id = ?",
        [currentRound.roundId]
    );
    
    // Calculate total players and bets
    const playersWithCartelas = Array.from(currentRound.players.values())
        .filter(p => p.selectedCartelas && p.selectedCartelas.length > 0);
    
    const totalPlayers = playersWithCartelas.length;
    const totalBet = totalPlayers * constants.DEFAULT_BET_AMOUNT;
    
    await pool.execute(
        "UPDATE game_rounds SET total_players = ?, total_bet = ? WHERE round_id = ?",
        [totalPlayers, totalBet, currentRound.roundId]
    );
    
    io.emit('gameState', {
        status: constants.GAME_PHASES.ACTIVE,
        round: currentRound.roundNumber,
        totalPlayers,
        totalBet,
        message: `Game started! ${totalPlayers} players participating.`
    });
    
    // Start drawing numbers
    startDrawingTimer();
}

// Start drawing numbers (every 4 seconds)
function startDrawingTimer() {
    if (currentRound.drawInterval) clearInterval(currentRound.drawInterval);
    
    // Create shuffled numbers 1-75
    const numbers = Array.from({ length: constants.TOTAL_NUMBERS }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    
    let index = 0;
    
    currentRound.drawInterval = setInterval(async () => {
        if (currentRound.status !== constants.GAME_PHASES.ACTIVE) {
            clearInterval(currentRound.drawInterval);
            return;
        }
        
        if (index >= numbers.length) {
            // No more numbers - end round with no winners
            await endRound([]);
            return;
        }
        
        const number = numbers[index++];
        currentRound.drawnNumbers.push(number);
        
        // Update database
        await pool.execute(
            "UPDATE game_rounds SET drawn_numbers = ? WHERE round_id = ?",
            [JSON.stringify(currentRound.drawnNumbers), currentRound.roundId]
        );
        
        // Emit drawn number
        io.emit('numberDrawn', { number, round: currentRound.roundNumber, drawnCount: currentRound.drawnNumbers.length });
        
        // Check for winners
        const winners = [];
        for (const [socketId, player] of currentRound.players) {
            if (player.selectedCartelas && 
                player.selectedCartelas.length > 0 && 
                player.selectedCartelas.includes(number) && 
                !currentRound.winners.includes(player.userId)) {
                winners.push({
                    userId: player.userId,
                    username: player.username,
                    selectedCartelas: player.selectedCartelas
                });
            }
        }
        
        if (winners.length > 0) {
            await endRound(winners);
        }
    }, constants.DRAW_INTERVAL_MS);
}

// End round and distribute rewards
async function endRound(winners) {
    if (currentRound.status === constants.GAME_PHASES.ENDED) return;
    
    // Stop drawing
    if (currentRound.drawInterval) {
        clearInterval(currentRound.drawInterval);
        currentRound.drawInterval = null;
    }
    
    currentRound.status = constants.GAME_PHASES.ENDED;
    currentRound.winners = winners.map(w => w.userId);
    
    // Calculate rewards
    const playersWithCartelas = Array.from(currentRound.players.values())
        .filter(p => p.selectedCartelas && p.selectedCartelas.length > 0);
    
    const totalPlayers = playersWithCartelas.length;
    const totalPool = totalPlayers * constants.DEFAULT_BET_AMOUNT;
    const winnerReward = winners.length > 0 ? (totalPool * constants.DEFAULT_WIN_PERCENTAGE) / 100 : 0;
    const adminCommission = totalPool - winnerReward;
    const perWinnerReward = winners.length > 0 ? winnerReward / winners.length : 0;
    
    // Update winners in database
    for (const winner of winners) {
        await pool.execute(
            `UPDATE users SET 
                balance = balance + ?,
                total_won = total_won + ?,
                games_won = games_won + 1,
                total_played = total_played + 1
             WHERE user_id = ?`,
            [perWinnerReward, perWinnerReward, winner.userId]
        );
        
        await pool.execute(
            `INSERT INTO round_participants (round_id, user_id, selected_cartelas, is_winner, win_amount, bet_amount)
             VALUES (?, ?, ?, TRUE, ?, ?)`,
            [currentRound.roundId, winner.userId, JSON.stringify(winner.selectedCartelas), perWinnerReward, constants.DEFAULT_BET_AMOUNT * winner.selectedCartelas.length]
        );
        
        await pool.execute(
            `INSERT INTO transactions (user_id, round_id, type, amount, description)
             VALUES (?, ?, 'win', ?, ?)`,
            [winner.userId, currentRound.roundId, perWinnerReward, `Won round ${currentRound.roundNumber}`]
        );
    }
    
    // Update non-winners
    for (const [socketId, player] of currentRound.players) {
        if (!currentRound.winners.includes(player.userId) && player.selectedCartelas.length > 0) {
            await pool.execute(
                `INSERT INTO round_participants (round_id, user_id, selected_cartelas, is_winner, bet_amount)
                 VALUES (?, ?, ?, FALSE, ?)`,
                [currentRound.roundId, player.userId, JSON.stringify(player.selectedCartelas), constants.DEFAULT_BET_AMOUNT * player.selectedCartelas.length]
            );
        }
    }
    
    // Update round record
    await pool.execute(
        `UPDATE game_rounds SET 
            status = 'ended', 
            end_time = NOW(),
            winners = ?,
            winner_amount = ?,
            admin_commission = ?
         WHERE round_id = ?`,
        [JSON.stringify(currentRound.winners), winnerReward, adminCommission, currentRound.roundId]
    );
    
    // Emit winner announcement
    const winnerNames = winners.map(w => w.username).join(', ');
    io.emit('roundEnded', {
        winners: currentRound.winners,
        winnerNames: winnerNames || 'No winners',
        winnerReward: perWinnerReward,
        totalPool,
        round: currentRound.roundNumber,
        nextRoundIn: constants.NEXT_ROUND_DELAY_SECONDS,
        message: winners.length > 0 
            ? `🎉 BINGO! Winner(s): ${winnerNames} 🎉 Each wins ${perWinnerReward.toFixed(2)} ETB!`
            : 'No winners this round!'
    });
    
    // Schedule next round
    scheduleNextRound();
}

// Schedule next round after delay
function scheduleNextRound() {
    if (currentRound.nextRoundTimeout) clearTimeout(currentRound.nextRoundTimeout);
    
    io.emit('nextRoundCountdown', { seconds: constants.NEXT_ROUND_DELAY_SECONDS });
    
    currentRound.nextRoundTimeout = setTimeout(async () => {
        await startNewRound();
    }, constants.NEXT_ROUND_DELAY_SECONDS * 1000);
}

// Socket.IO connection handler
function socketHandler(io) {
    io.on("connection", async (socket) => {
        console.log(`Player connected: ${socket.id}`);
        
        // Send current game state immediately
        const timeLeft = currentRound.status === constants.GAME_PHASES.SELECTION
            ? Math.max(0, Math.ceil((currentRound.selectionEndTime - Date.now()) / 1000))
            : 0;
        
        socket.emit('currentGameState', {
            status: currentRound.status,
            round: currentRound.roundNumber,
            timeLeft: timeLeft,
            drawnNumbers: currentRound.drawnNumbers,
            selectionSeconds: constants.SELECTION_SECONDS,
            nextRoundDelay: constants.NEXT_ROUND_DELAY_SECONDS
        });
        
        // Handle player registration
        socket.on("register", async (data) => {
            const { userId, token } = data;
            
            try {
                const [users] = await pool.execute(
                    "SELECT user_id, username, balance FROM users WHERE user_id = ? AND is_active = TRUE",
                    [userId]
                );
                
                if (users.length === 0) {
                    socket.emit("error", "User not found or inactive");
                    return;
                }
                
                const user = users[0];
                
                // Store player in current round
                currentRound.players.set(socket.id, {
                    socketId: socket.id,
                    userId: user.user_id,
                    username: user.username,
                    balance: user.balance,
                    selectedCartelas: [],
                    joinedAt: Date.now()
                });
                
                socket.emit("registered", {
                    userId: user.user_id,
                    username: user.username,
                    balance: user.balance,
                    currentRound: currentRound.roundNumber,
                    gameStatus: currentRound.status,
                    timeLeft: currentRound.status === constants.GAME_PHASES.SELECTION 
                        ? Math.max(0, Math.ceil((currentRound.selectionEndTime - Date.now()) / 1000))
                        : 0
                });
                
                // Send current game state
                socket.emit("gameStateUpdate", {
                    status: currentRound.status,
                    round: currentRound.roundNumber,
                    drawnNumbers: currentRound.drawnNumbers,
                    winners: currentRound.winners
                });
                
            } catch (error) {
                console.error("Registration error:", error);
                socket.emit("error", "Registration failed");
            }
        });
        
        // Handle cartela selection
        socket.on("selectCartela", async (data) => {
            const { cartelaNumber } = data;
            const player = currentRound.players.get(socket.id);
            
            if (!player) {
                socket.emit("error", "Not registered");
                return;
            }
            
            // Only allow selection during selection phase
            if (currentRound.status !== constants.GAME_PHASES.SELECTION) {
                socket.emit("error", `Cannot select now. Game status: ${currentRound.status}`);
                return;
            }
            
            if (player.selectedCartelas.length >= constants.MAX_CARTELAS_PER_PLAYER) {
                socket.emit("error", `Maximum ${constants.MAX_CARTELAS_PER_PLAYER} cartelas allowed`);
                return;
            }
            
            if (player.selectedCartelas.includes(cartelaNumber)) {
                socket.emit("error", "Cartela already selected");
                return;
            }
            
            if (player.balance < constants.DEFAULT_BET_AMOUNT) {
                socket.emit("error", `Insufficient balance! Need ${constants.DEFAULT_BET_AMOUNT} ETB`);
                return;
            }
            
            // Deduct balance
            player.balance -= constants.DEFAULT_BET_AMOUNT;
            player.selectedCartelas.push(cartelaNumber);
            
            // Update database
            await pool.execute(
                "UPDATE users SET balance = balance - ? WHERE user_id = ?",
                [constants.DEFAULT_BET_AMOUNT, player.userId]
            );
            
            await pool.execute(
                `INSERT INTO transactions (user_id, round_id, type, amount, description)
                 VALUES (?, ?, 'bet', ?, ?)`,
                [player.userId, currentRound.roundId, constants.DEFAULT_BET_AMOUNT, `Selected cartela ${cartelaNumber} - Round ${currentRound.roundNumber}`]
            );
            
            socket.emit("selectionConfirmed", {
                cartela: cartelaNumber,
                selectedCount: player.selectedCartelas.length,
                remainingBalance: player.balance,
                maxAllowed: constants.MAX_CARTELAS_PER_PLAYER
            });
            
            // Broadcast to all players
            io.emit("playerSelectionUpdate", {
                userId: player.userId,
                username: player.username,
                selectedCount: player.selectedCartelas.length
            });
        });
        
        // Handle cartela deselection
        socket.on("deselectCartela", async (data) => {
            const { cartelaNumber } = data;
            const player = currentRound.players.get(socket.id);
            
            if (!player) return;
            
            if (currentRound.status !== constants.GAME_PHASES.SELECTION) {
                socket.emit("error", "Cannot deselect after game started");
                return;
            }
            
            const index = player.selectedCartelas.indexOf(cartelaNumber);
            if (index !== -1) {
                player.selectedCartelas.splice(index, 1);
                player.balance += constants.DEFAULT_BET_AMOUNT;
                
                await pool.execute(
                    "UPDATE users SET balance = balance + ? WHERE user_id = ?",
                    [constants.DEFAULT_BET_AMOUNT, player.userId]
                );
                
                socket.emit("selectionUpdated", {
                    selectedCartelas: player.selectedCartelas,
                    balance: player.balance
                });
            }
        });
        
        // Get player status
        socket.on("getStatus", () => {
            const player = currentRound.players.get(socket.id);
            if (player) {
                socket.emit("playerStatus", {
                    balance: player.balance,
                    selectedCartelas: player.selectedCartelas,
                    round: currentRound.roundNumber,
                    gameStatus: currentRound.status,
                    timeLeft: currentRound.status === constants.GAME_PHASES.SELECTION
                        ? Math.max(0, Math.ceil((currentRound.selectionEndTime - Date.now()) / 1000))
                        : 0
                });
            }
        });
        
        // Disconnect
        socket.on("disconnect", () => {
            console.log(`Player disconnected: ${socket.id}`);
            currentRound.players.delete(socket.id);
        });
    });
}

// Initialize game on server start
initializeOrLoadCurrentRound();

module.exports = { socketHandler };