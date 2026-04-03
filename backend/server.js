const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

// ==================== GAME CONSTANTS ====================
const SELECTION_TIME = 50;        // seconds to select cartelas
const DRAW_INTERVAL = 4000;       // milliseconds between number draws
const NEXT_ROUND_DELAY = 6000;    // milliseconds before next round
const BET_AMOUNT = 10;            // ETB per cartela
const WIN_PERCENTAGE = 75;        // % of pool to winners
const MAX_CARTELAS = 2;           // max cartelas per player

// ==================== GAME STATE (24/7 Continuous) ====================
let gameState = {
    status: 'selection',     // selection, active, ended
    round: 1,
    timer: SELECTION_TIME,
    drawnNumbers: [],
    winners: [],
    players: new Map(),      // socketId -> player object
    totalBet: 0,
    winnerReward: 0
};

// Timers
let selectionTimer = null;
let drawTimer = null;
let nextRoundTimer = null;

// ==================== HELPER FUNCTIONS ====================

// Get BINGO letter for a number (1-75)
function getBingoLetter(num) {
    if (num <= 15) return "B";
    if (num <= 30) return "I";
    if (num <= 45) return "N";
    if (num <= 60) return "G";
    return "O";
}

// Get column color class
function getColumnColor(letter) {
    const colors = {
        'B': '#ff6b6b',
        'I': '#4ecdc4',
        'N': '#ffe66d',
        'G': '#95e77e',
        'O': '#ff9f43'
    };
    return colors[letter] || '#ffffff';
}

// Format time (seconds to MM:SS)
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Broadcast game state to all connected clients
function broadcastGameState() {
    const playersList = Array.from(gameState.players.values()).map(p => ({
        username: p.username,
        selectedCount: p.selectedCartelas.length,
        balance: p.balance
    }));
    
    io.emit('gameState', {
        status: gameState.status,
        round: gameState.round,
        timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers,
        playersCount: gameState.players.size,
        players: playersList
    });
}

// Broadcast timer update
function broadcastTimer() {
    io.emit('timerUpdate', {
        seconds: gameState.timer,
        round: gameState.round,
        formatted: formatTime(gameState.timer)
    });
}

// ==================== GAME CORE FUNCTIONS ====================

// Start the selection timer (50 seconds)
function startSelectionTimer() {
    if (selectionTimer) clearInterval(selectionTimer);
    
    gameState.status = 'selection';
    gameState.timer = SELECTION_TIME;
    
    broadcastGameState();
    broadcastTimer();
    
    selectionTimer = setInterval(() => {
        if (gameState.status !== 'selection') {
            clearInterval(selectionTimer);
            selectionTimer = null;
            return;
        }
        
        gameState.timer--;
        broadcastTimer();
        
        // Warning when 10 seconds left
        if (gameState.timer === 10) {
            io.emit('warning', { message: '⚠️ Only 10 seconds left to select cartelas!', type: 'warning' });
        }
        
        // Time's up - start the game
        if (gameState.timer <= 0) {
            clearInterval(selectionTimer);
            selectionTimer = null;
            startActiveGame();
        }
    }, 1000);
}

// Start the active game (drawing numbers)
function startActiveGame() {
    gameState.status = 'active';
    gameState.drawnNumbers = [];
    gameState.winners = [];
    
    // Calculate total bets
    let totalPlayers = 0;
    let totalCartelas = 0;
    
    for (const [socketId, player] of gameState.players) {
        if (player.selectedCartelas.length > 0) {
            totalPlayers++;
            totalCartelas += player.selectedCartelas.length;
        }
    }
    
    gameState.totalBet = totalCartelas * BET_AMOUNT;
    gameState.winnerReward = (gameState.totalBet * WIN_PERCENTAGE) / 100;
    
    broadcastGameState();
    io.emit('gameStarted', {
        round: gameState.round,
        totalPlayers,
        totalCartelas,
        totalBet: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        message: `🎲 Game started! ${totalPlayers} players, ${totalCartelas} cartelas. Total pool: ${gameState.totalBet} ETB`
    });
    
    // Create shuffled numbers 1-75
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    
    let index = 0;
    
    drawTimer = setInterval(() => {
        if (gameState.status !== 'active') {
            clearInterval(drawTimer);
            drawTimer = null;
            return;
        }
        
        if (index >= numbers.length) {
            // No more numbers - end round with no winners
            endRound([]);
            return;
        }
        
        const number = numbers[index++];
        gameState.drawnNumbers.push(number);
        const letter = getBingoLetter(number);
        
        // Emit the drawn number with audio trigger
        io.emit('numberDrawn', {
            number,
            letter,
            drawnCount: gameState.drawnNumbers.length,
            remaining: 75 - gameState.drawnNumbers.length
        });
        
        broadcastGameState();
        
        // Check for winners (simplified - players win if any of their cartelas match the drawn number)
        // In a full implementation, you'd check the actual cartela grid
        const newWinners = [];
        
        for (const [socketId, player] of gameState.players) {
            if (player.selectedCartelas.length > 0 && 
                !gameState.winners.includes(socketId)) {
                // For now, any player with selected cartelas wins when a number is drawn
                // In production, check if the drawn number is in their cartela grid
                newWinners.push(socketId);
            }
        }
        
        if (newWinners.length > 0 && gameState.winners.length === 0) {
            // First winners of the round
            endRound(newWinners);
        }
    }, DRAW_INTERVAL);
}

// End the round and distribute rewards
function endRound(winnerSocketIds) {
    if (gameState.status !== 'active') return;
    
    // Stop draw timer
    if (drawTimer) {
        clearInterval(drawTimer);
        drawTimer = null;
    }
    
    gameState.status = 'ended';
    gameState.winners = winnerSocketIds;
    
    // Calculate rewards
    const winnerCount = winnerSocketIds.length;
    const perWinnerReward = winnerCount > 0 ? gameState.winnerReward / winnerCount : 0;
    
    // Update winner balances
    const winnerNames = [];
    for (const socketId of winnerSocketIds) {
        const player = gameState.players.get(socketId);
        if (player) {
            player.balance += perWinnerReward;
            player.totalWon = (player.totalWon || 0) + perWinnerReward;
            player.gamesWon = (player.gamesWon || 0) + 1;
            winnerNames.push(player.username);
            
            // Notify individual winner
            io.to(socketId).emit('youWon', {
                amount: perWinnerReward,
                message: `🎉 Congratulations! You won ${perWinnerReward.toFixed(2)} ETB!`
            });
        }
    }
    
    // Update total played for all players
    for (const [socketId, player] of gameState.players) {
        if (player.selectedCartelas.length > 0) {
            player.totalPlayed = (player.totalPlayed || 0) + 1;
        }
    }
    
    // Broadcast round end
    io.emit('roundEnded', {
        winners: winnerNames,
        winnerCount,
        winnerReward: perWinnerReward,
        totalPool: gameState.totalBet,
        adminCommission: gameState.totalBet - gameState.winnerReward,
        round: gameState.round,
        message: winnerCount > 0 
            ? `🎉 BINGO! Winners: ${winnerNames.join(', ')}. Each wins ${perWinnerReward.toFixed(2)} ETB!`
            : 'No winners this round! Better luck next time!'
    });
    
    broadcastGameState();
    
    // Schedule next round
    scheduleNextRound();
}

// Schedule the next round
function scheduleNextRound() {
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    
    let countdown = NEXT_ROUND_DELAY / 1000;
    
    const countdownInterval = setInterval(() => {
        io.emit('nextRoundCountdown', { seconds: countdown });
        countdown--;
        
        if (countdown < 0) {
            clearInterval(countdownInterval);
        }
    }, 1000);
    
    nextRoundTimer = setTimeout(() => {
        resetForNextRound();
        nextRoundTimer = null;
    }, NEXT_ROUND_DELAY);
}

// Reset for next round
function resetForNextRound() {
    // Clear all player selections for next round
    for (const [socketId, player] of gameState.players) {
        player.selectedCartelas = [];
    }
    
    gameState.round++;
    gameState.status = 'selection';
    gameState.timer = SELECTION_TIME;
    gameState.drawnNumbers = [];
    gameState.winners = [];
    gameState.totalBet = 0;
    gameState.winnerReward = 0;
    
    broadcastGameState();
    broadcastTimer();
    
    io.emit('nextRound', {
        round: gameState.round,
        timer: SELECTION_TIME,
        message: `🎲 Round ${gameState.round} starting! Select up to ${MAX_CARTELAS} cartelas within ${SELECTION_TIME} seconds.`
    });
    
    // Start the selection timer again
    startSelectionTimer();
}

// ==================== SOCKET.IO CONNECTION HANDLER ====================
io.on("connection", (socket) => {
    console.log(`🟢 Player connected: ${socket.id}`);
    
    // Generate a default username
    const defaultUsername = `Player_${socket.id.slice(-4)}`;
    
    // Initialize player data
    const playerData = {
        socketId: socket.id,
        username: defaultUsername,
        selectedCartelas: [],
        balance: 100,  // Starting balance
        totalWon: 0,
        totalPlayed: 0,
        gamesWon: 0,
        joinedAt: Date.now()
    };
    
    gameState.players.set(socket.id, playerData);
    
    // Send initial data to the new player
    socket.emit('registered', {
        socketId: socket.id,
        username: defaultUsername,
        balance: 100,
        gameState: {
            status: gameState.status,
            round: gameState.round,
            timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers
        }
    });
    
    // Send current game state
    socket.emit('gameState', {
        status: gameState.status,
        round: gameState.round,
        timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers,
        playersCount: gameState.players.size
    });
    
    // Send current timer
    socket.emit('timerUpdate', {
        seconds: gameState.timer,
        round: gameState.round,
        formatted: formatTime(gameState.timer)
    });
    
    // Broadcast updated player count to everyone
    io.emit('playersUpdate', {
        count: gameState.players.size,
        players: Array.from(gameState.players.values()).map(p => ({
            username: p.username,
            selectedCount: p.selectedCartelas.length,
            balance: p.balance
        }))
    });
    
    // ========== PLAYER ACTIONS ==========
    
    // Change username
    socket.on("setUsername", (data) => {
        const player = gameState.players.get(socket.id);
        if (player && data.username && data.username.trim().length > 0) {
            const oldName = player.username;
            player.username = data.username.trim().substring(0, 20);
            
            socket.emit('usernameChanged', { username: player.username });
            
            io.emit('playerUpdated', {
                socketId: socket.id,
                oldName: oldName,
                newName: player.username,
                message: `${oldName} changed name to ${player.username}`
            });
            
            broadcastGameState();
        }
    });
    
    // Select cartela
    socket.on("selectCartela", (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) {
            socket.emit("error", { message: "Player not found" });
            return;
        }
        
        const cartelaNumber = data.cartelaNumber;
        
        // Validation
        if (gameState.status !== 'selection') {
            socket.emit("error", { message: `Cannot select cartelas now. Game is ${gameState.status}. Please wait for next round.` });
            return;
        }
        
        if (player.selectedCartelas.length >= MAX_CARTELAS) {
            socket.emit("error", { message: `Maximum ${MAX_CARTELAS} cartelas allowed per round!` });
            return;
        }
        
        if (player.selectedCartelas.includes(cartelaNumber)) {
            socket.emit("error", { message: `Cartela ${cartelaNumber} already selected!` });
            return;
        }
        
        if (player.balance < BET_AMOUNT) {
            socket.emit("error", { message: `Insufficient balance! You have ${player.balance} ETB. Need ${BET_AMOUNT} ETB per cartela.` });
            return;
        }
        
        // Deduct balance and add cartela
        player.balance -= BET_AMOUNT;
        player.selectedCartelas.push(cartelaNumber);
        
        // Confirm selection to player
        socket.emit("selectionConfirmed", {
            cartela: cartelaNumber,
            selectedCount: player.selectedCartelas.length,
            balance: player.balance,
            remainingSlots: MAX_CARTELAS - player.selectedCartelas.length,
            message: `✅ Cartela ${cartelaNumber} selected! ${player.selectedCartelas.length}/${MAX_CARTELAS}`
        });
        
        // Broadcast to all players
        io.emit("playerSelectionUpdate", {
            username: player.username,
            selectedCount: player.selectedCartelas.length,
            message: `${player.username} selected ${player.selectedCartelas.length}/${MAX_CARTELAS} cartela(s)`
        });
        
        broadcastGameState();
        
        // Update players list
        io.emit('playersUpdate', {
            count: gameState.players.size,
            players: Array.from(gameState.players.values()).map(p => ({
                username: p.username,
                selectedCount: p.selectedCartelas.length,
                balance: p.balance
            }))
        });
    });
    
    // Deselect cartela (refund)
    socket.on("deselectCartela", (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;
        
        if (gameState.status !== 'selection') {
            socket.emit("error", { message: "Cannot deselect after game started!" });
            return;
        }
        
        const cartelaNumber = data.cartelaNumber;
        const index = player.selectedCartelas.indexOf(cartelaNumber);
        
        if (index !== -1) {
            player.selectedCartelas.splice(index, 1);
            player.balance += BET_AMOUNT;
            
            socket.emit("selectionUpdated", {
                selectedCartelas: player.selectedCartelas,
                balance: player.balance,
                message: `Cartela ${cartelaNumber} deselected. Refunded ${BET_AMOUNT} ETB.`
            });
            
            broadcastGameState();
            
            io.emit('playersUpdate', {
                count: gameState.players.size,
                players: Array.from(gameState.players.values()).map(p => ({
                    username: p.username,
                    selectedCount: p.selectedCartelas.length,
                    balance: p.balance
                }))
            });
        }
    });
    
    // Get player status
    socket.on("getStatus", () => {
        const player = gameState.players.get(socket.id);
        if (player) {
            socket.emit("playerStatus", {
                balance: player.balance,
                selectedCartelas: player.selectedCartelas,
                gameStatus: gameState.status,
                timer: gameState.timer,
                round: gameState.round,
                drawnNumbers: gameState.drawnNumbers,
                totalWon: player.totalWon,
                totalPlayed: player.totalPlayed,
                gamesWon: player.gamesWon
            });
        }
    });
    
    // Get leaderboard
    socket.on("getLeaderboard", () => {
        const leaderboard = Array.from(gameState.players.values())
            .sort((a, b) => (b.totalWon || 0) - (a.totalWon || 0))
            .slice(0, 10)
            .map((p, index) => ({
                rank: index + 1,
                username: p.username,
                totalWon: p.totalWon || 0,
                gamesWon: p.gamesWon || 0
            }));
        
        socket.emit("leaderboard", { leaderboard });
    });
    
    // Disconnect
    socket.on("disconnect", () => {
        console.log(`🔴 Player disconnected: ${socket.id}`);
        const player = gameState.players.get(socket.id);
        const username = player?.username || 'Unknown';
        gameState.players.delete(socket.id);
        
        io.emit('playersUpdate', {
            count: gameState.players.size,
            players: Array.from(gameState.players.values()).map(p => ({
                username: p.username,
                selectedCount: p.selectedCartelas.length,
                balance: p.balance
            }))
        });
        
        io.emit('playerLeft', {
            username: username,
            message: `${username} left the game`
        });
        
        broadcastGameState();
    });
});

// ==================== ADMIN API ENDPOINTS ====================

// Get admin statistics
app.get("/api/admin/stats", (req, res) => {
    const players = Array.from(gameState.players.values());
    const totalBalance = players.reduce((sum, p) => sum + (p.balance || 0), 0);
    const totalSelected = players.reduce((sum, p) => sum + (p.selectedCartelas?.length || 0), 0);
    const playersWithSelections = players.filter(p => p.selectedCartelas?.length > 0).length;
    
    res.json({
        success: true,
        status: gameState.status,
        round: gameState.round,
        timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers,
        drawnCount: gameState.drawnNumbers.length,
        playersCount: players.length,
        playersWithSelections,
        totalBalance: totalBalance.toFixed(2),
        totalSelected,
        totalBet: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        winners: gameState.winners,
        timestamp: new Date().toISOString()
    });
});

// Force start game (admin)
app.post("/api/admin/start-game", (req, res) => {
    if (gameState.status === 'selection') {
        if (selectionTimer) {
            clearInterval(selectionTimer);
            selectionTimer = null;
        }
        startActiveGame();
        res.json({ success: true, message: "Game started forcefully!" });
    } else {
        res.json({ success: false, message: `Cannot start game. Current status: ${gameState.status}` });
    }
});

// Force end game (admin)
app.post("/api/admin/end-game", (req, res) => {
    if (gameState.status === 'active') {
        if (drawTimer) {
            clearInterval(drawTimer);
            drawTimer = null;
        }
        endRound([]);
        res.json({ success: true, message: "Game ended forcefully!" });
    } else {
        res.json({ success: false, message: `Cannot end game. Current status: ${gameState.status}` });
    }
});

// Reset game completely (admin)
app.post("/api/admin/reset-game", (req, res) => {
    // Clear all timers
    if (selectionTimer) clearInterval(selectionTimer);
    if (drawTimer) clearInterval(drawTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    
    selectionTimer = null;
    drawTimer = null;
    nextRoundTimer = null;
    
    // Reset game state
    gameState = {
        status: 'selection',
        round: 1,
        timer: SELECTION_TIME,
        drawnNumbers: [],
        winners: [],
        players: gameState.players,  // Preserve players but clear their selections
        totalBet: 0,
        winnerReward: 0
    };
    
    // Clear player selections
    for (const [socketId, player] of gameState.players) {
        player.selectedCartelas = [];
    }
    
    // Start fresh
    startSelectionTimer();
    
    io.emit('gameReset', { message: 'Game has been reset by admin!' });
    
    res.json({ success: true, message: "Game reset successfully!" });
});

// Add balance to a player (admin)
app.post("/api/admin/add-balance", (req, res) => {
    const { socketId, amount } = req.body;
    
    if (!socketId || !amount) {
        return res.status(400).json({ success: false, message: "Socket ID and amount required" });
    }
    
    const player = gameState.players.get(socketId);
    if (!player) {
        return res.status(404).json({ success: false, message: "Player not found" });
    }
    
    player.balance += amount;
    
    io.to(socketId).emit('balanceUpdated', { balance: player.balance });
    io.emit('playersUpdate', {
        count: gameState.players.size,
        players: Array.from(gameState.players.values()).map(p => ({
            username: p.username,
            selectedCount: p.selectedCartelas.length,
            balance: p.balance
        }))
    });
    
    res.json({ success: true, newBalance: player.balance });
});

// Get all players (admin)
app.get("/api/admin/players", (req, res) => {
    const players = Array.from(gameState.players.values()).map(p => ({
        socketId: p.socketId,
        username: p.username,
        balance: p.balance,
        selectedCartelas: p.selectedCartelas,
        totalWon: p.totalWon || 0,
        totalPlayed: p.totalPlayed || 0,
        gamesWon: p.gamesWon || 0,
        joinedAt: p.joinedAt
    }));
    
    res.json({ success: true, players });
});

// Get game logs (admin)
app.get("/api/admin/logs", (req, res) => {
    res.json({
        success: true,
        gameState: {
            status: gameState.status,
            round: gameState.round,
            timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers,
            winners: gameState.winners
        },
        playersCount: gameState.players.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        gameStatus: gameState.status,
        playersOnline: gameState.players.size
    });
});

// Root endpoint
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/player.html"));
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;

// Initialize the game on server start
startSelectionTimer();

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║     🎲 ESTIF BINGO 24/7 SERVER STARTED 🎲               ║
║                                                          ║
║     📱 Player URL: http://localhost:${PORT}/player.html     ║
║     🔐 Admin URL:  http://localhost:${PORT}/admin.html     ║
║                                                          ║
║     🎮 Game Status: ${gameState.status.padEnd(20)}            ║
║     🌍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(20)}            ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    if (selectionTimer) clearInterval(selectionTimer);
    if (drawTimer) clearInterval(drawTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = { app, server, io, gameState };