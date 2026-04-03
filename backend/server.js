const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
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

// ==================== DATABASE (In-Memory with Persistence) ====================
// For production, replace with PostgreSQL. This works for demo.
const fs = require('fs');
const DATA_FILE = path.join(__dirname, '../data/game-data.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, '../data'))) {
    fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
}

// Load or initialize data
let gameData = {
    users: [],
    gameRounds: [],
    transactions: [],
    reports: []
};

try {
    if (fs.existsSync(DATA_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        gameData = { ...gameData, ...loaded };
        console.log("✅ Loaded existing game data");
    }
} catch (err) {
    console.log("⚠️ No existing data found, starting fresh");
}

// Save data function
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(gameData, null, 2));
    } catch (err) {
        console.error("Error saving data:", err);
    }
}

// ==================== GAME CONSTANTS ====================
const SELECTION_TIME = 50;
const DRAW_INTERVAL = 4000;
const NEXT_ROUND_DELAY = 6000;
const BET_AMOUNT = 10;
const WIN_PERCENTAGES = [70, 75, 76, 80];
const DEFAULT_WIN_PERCENTAGE = 75;
const MAX_CARTELAS = 2;

// ==================== GAME STATE ====================
let gameState = {
    status: 'selection',
    round: 1,
    timer: SELECTION_TIME,
    drawnNumbers: [],
    winners: [],
    players: new Map(),
    totalBet: 0,
    winnerReward: 0,
    adminCommission: 0,
    winPercentage: DEFAULT_WIN_PERCENTAGE,
    roundStartTime: null,
    roundEndTime: null
};

// Timers
let selectionTimer = null;
let drawTimer = null;
let nextRoundTimer = null;

// Admin sessions (simple token storage)
let adminTokens = new Map();

// ==================== HELPER FUNCTIONS ====================

function getBingoLetter(num) {
    if (num <= 15) return "B";
    if (num <= 30) return "I";
    if (num <= 45) return "N";
    if (num <= 60) return "G";
    return "O";
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

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
        players: playersList,
        winPercentage: gameState.winPercentage
    });
}

function broadcastTimer() {
    io.emit('timerUpdate', {
        seconds: gameState.timer,
        round: gameState.round,
        formatted: formatTime(gameState.timer)
    });
}

// Calculate rewards based on win percentage
function calculateRewards(totalPlayers, totalCartelas, winPercentage) {
    const totalPool = totalCartelas * BET_AMOUNT;
    const winnerReward = (totalPool * winPercentage) / 100;
    const adminCommission = totalPool - winnerReward;
    return { totalPool, winnerReward, adminCommission };
}

// Save round to history
function saveRoundToHistory(roundData) {
    gameData.gameRounds.push({
        roundId: gameState.round,
        ...roundData,
        timestamp: new Date().toISOString()
    });
    
    // Keep only last 1000 rounds
    if (gameData.gameRounds.length > 1000) {
        gameData.gameRounds = gameData.gameRounds.slice(-1000);
    }
    
    saveData();
}

// Generate daily report
function generateDailyReport(date) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const rounds = gameData.gameRounds.filter(r => r.timestamp?.startsWith(targetDate));
    
    const totalGames = rounds.length;
    const totalBet = rounds.reduce((sum, r) => sum + (r.totalPool || 0), 0);
    const totalWon = rounds.reduce((sum, r) => sum + (r.winnerReward || 0), 0);
    const totalCommission = rounds.reduce((sum, r) => sum + (r.adminCommission || 0), 0);
    const totalPlayers = rounds.reduce((sum, r) => sum + (r.totalPlayers || 0), 0);
    
    return {
        date: targetDate,
        totalGames,
        totalBet,
        totalWon,
        totalCommission,
        totalPlayers,
        rounds: rounds.map(r => ({
            roundId: r.roundId,
            totalPlayers: r.totalPlayers,
            totalBet: r.totalPool,
            winnerReward: r.winnerReward,
            adminCommission: r.adminCommission,
            winners: r.winners,
            winPercentage: r.winPercentage
        }))
    };
}

// Generate weekly report
function generateWeeklyReport(year, week) {
    const now = new Date();
    const targetYear = year || now.getFullYear();
    const targetWeek = week || getWeekNumber(now);
    
    const rounds = gameData.gameRounds.filter(r => {
        const date = new Date(r.timestamp);
        return getWeekNumber(date) === targetWeek && date.getFullYear() === targetYear;
    });
    
    const totalGames = rounds.length;
    const totalBet = rounds.reduce((sum, r) => sum + (r.totalPool || 0), 0);
    const totalWon = rounds.reduce((sum, r) => sum + (r.winnerReward || 0), 0);
    const totalCommission = rounds.reduce((sum, r) => sum + (r.adminCommission || 0), 0);
    
    return {
        year: targetYear,
        week: targetWeek,
        totalGames,
        totalBet,
        totalWon,
        totalCommission,
        rounds
    };
}

// Generate monthly report
function generateMonthlyReport(year, month) {
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || new Date().getMonth() + 1;
    
    const rounds = gameData.gameRounds.filter(r => {
        const date = new Date(r.timestamp);
        return date.getFullYear() === targetYear && (date.getMonth() + 1) === targetMonth;
    });
    
    const totalGames = rounds.length;
    const totalBet = rounds.reduce((sum, r) => sum + (r.totalPool || 0), 0);
    const totalWon = rounds.reduce((sum, r) => sum + (r.winnerReward || 0), 0);
    const totalCommission = rounds.reduce((sum, r) => sum + (r.adminCommission || 0), 0);
    
    return {
        year: targetYear,
        month: targetMonth,
        totalGames,
        totalBet,
        totalWon,
        totalCommission,
        rounds
    };
}

// Get week number
function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// ==================== GAME CORE FUNCTIONS ====================

function startSelectionTimer() {
    if (selectionTimer) clearInterval(selectionTimer);
    
    gameState.status = 'selection';
    gameState.timer = SELECTION_TIME;
    gameState.roundStartTime = new Date();
    
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
        
        if (gameState.timer === 10) {
            io.emit('warning', { message: '⚠️ Only 10 seconds left to select cartelas!', type: 'warning' });
        }
        
        if (gameState.timer <= 0) {
            clearInterval(selectionTimer);
            selectionTimer = null;
            startActiveGame();
        }
    }, 1000);
}

function startActiveGame() {
    gameState.status = 'active';
    gameState.drawnNumbers = [];
    gameState.winners = [];
    
    let totalPlayers = 0;
    let totalCartelas = 0;
    
    for (const [socketId, player] of gameState.players) {
        if (player.selectedCartelas.length > 0) {
            totalPlayers++;
            totalCartelas += player.selectedCartelas.length;
        }
    }
    
    const { totalPool, winnerReward, adminCommission } = calculateRewards(
        totalPlayers, totalCartelas, gameState.winPercentage
    );
    
    gameState.totalBet = totalPool;
    gameState.winnerReward = winnerReward;
    gameState.adminCommission = adminCommission;
    
    broadcastGameState();
    io.emit('gameStarted', {
        round: gameState.round,
        totalPlayers,
        totalCartelas,
        totalBet: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        winPercentage: gameState.winPercentage,
        message: `🎲 Game started! ${totalPlayers} players, ${totalCartelas} cartelas. Win: ${gameState.winPercentage}% of ${gameState.totalBet} ETB pool`
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
            endRound([]);
            return;
        }
        
        const number = numbers[index++];
        gameState.drawnNumbers.push(number);
        const letter = getBingoLetter(number);
        
        io.emit('numberDrawn', {
            number,
            letter,
            drawnCount: gameState.drawnNumbers.length,
            remaining: 75 - gameState.drawnNumbers.length
        });
        
        broadcastGameState();
        
        // Check for winners
        const newWinners = [];
        
        for (const [socketId, player] of gameState.players) {
            if (player.selectedCartelas.length > 0 && 
                !gameState.winners.includes(socketId)) {
                // Simplified win detection - in production, check actual cartela grid
                newWinners.push(socketId);
            }
        }
        
        if (newWinners.length > 0 && gameState.winners.length === 0) {
            endRound(newWinners);
        }
    }, DRAW_INTERVAL);
}

function endRound(winnerSocketIds) {
    if (gameState.status !== 'active') return;
    
    if (drawTimer) {
        clearInterval(drawTimer);
        drawTimer = null;
    }
    
    gameState.status = 'ended';
    gameState.winners = winnerSocketIds;
    gameState.roundEndTime = new Date();
    
    const winnerCount = winnerSocketIds.length;
    const perWinnerReward = winnerCount > 0 ? gameState.winnerReward / winnerCount : 0;
    
    const winnerNames = [];
    for (const socketId of winnerSocketIds) {
        const player = gameState.players.get(socketId);
        if (player) {
            player.balance += perWinnerReward;
            player.totalWon = (player.totalWon || 0) + perWinnerReward;
            player.gamesWon = (player.gamesWon || 0) + 1;
            winnerNames.push(player.username);
            
            io.to(socketId).emit('youWon', {
                amount: perWinnerReward,
                message: `🎉 Congratulations! You won ${perWinnerReward.toFixed(2)} ETB!`
            });
            
            // Record transaction
            gameData.transactions.push({
                userId: socketId,
                username: player.username,
                type: 'win',
                amount: perWinnerReward,
                round: gameState.round,
                timestamp: new Date().toISOString()
            });
        }
    }
    
    // Update total played
    for (const [socketId, player] of gameState.players) {
        if (player.selectedCartelas.length > 0) {
            player.totalPlayed = (player.totalPlayed || 0) + 1;
        }
    }
    
    // Save round to history
    saveRoundToHistory({
        roundId: gameState.round,
        totalPlayers: Array.from(gameState.players.values()).filter(p => p.selectedCartelas.length > 0).length,
        totalCartelas: Array.from(gameState.players.values()).reduce((sum, p) => sum + p.selectedCartelas.length, 0),
        totalPool: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        adminCommission: gameState.adminCommission,
        winners: winnerNames,
        winnerCount,
        perWinnerReward,
        winPercentage: gameState.winPercentage,
        startTime: gameState.roundStartTime,
        endTime: gameState.roundEndTime
    });
    
    io.emit('roundEnded', {
        winners: winnerNames,
        winnerCount,
        winnerReward: perWinnerReward,
        totalPool: gameState.totalBet,
        adminCommission: gameState.adminCommission,
        winPercentage: gameState.winPercentage,
        round: gameState.round,
        message: winnerCount > 0 
            ? `🎉 BINGO! Winners: ${winnerNames.join(', ')}. Each wins ${perWinnerReward.toFixed(2)} ETB!`
            : 'No winners this round! Better luck next time!'
    });
    
    broadcastGameState();
    scheduleNextRound();
}

function scheduleNextRound() {
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    
    let countdown = NEXT_ROUND_DELAY / 1000;
    const countdownInterval = setInterval(() => {
        io.emit('nextRoundCountdown', { seconds: countdown });
        countdown--;
        if (countdown < 0) clearInterval(countdownInterval);
    }, 1000);
    
    nextRoundTimer = setTimeout(() => {
        resetForNextRound();
        nextRoundTimer = null;
    }, NEXT_ROUND_DELAY);
}

function resetForNextRound() {
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
    gameState.adminCommission = 0;
    
    broadcastGameState();
    broadcastTimer();
    
    io.emit('nextRound', {
        round: gameState.round,
        timer: SELECTION_TIME,
        message: `🎲 Round ${gameState.round} starting! Select up to ${MAX_CARTELAS} cartelas within ${SELECTION_TIME} seconds.`
    });
    
    startSelectionTimer();
}

// ==================== ADMIN AUTHENTICATION ====================
const ADMIN_EMAIL = "johnsonestiph13@gmail.com";
let ADMIN_PASSWORD_HASH = null;

// Initialize admin password
(async () => {
    ADMIN_PASSWORD_HASH = await bcrypt.hash("Jon@2127", 10);
    console.log("✅ Admin password initialized");
})();

// Admin login endpoint
app.post("/api/admin/login", async (req, res) => {
    const { email, password } = req.body;
    
    if (email !== ADMIN_EMAIL) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    
    const isValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!isValid) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    
    const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET || "estif-secret-key", { expiresIn: "24h" });
    adminTokens.set(token, Date.now());
    
    res.json({ success: true, token, message: "Login successful" });
});

// Admin change password
app.post("/api/admin/change-password", async (req, res) => {
    const { currentPassword, newPassword, token } = req.body;
    
    if (!adminTokens.has(token)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const isValid = await bcrypt.compare(currentPassword, ADMIN_PASSWORD_HASH);
    if (!isValid) {
        return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }
    
    ADMIN_PASSWORD_HASH = await bcrypt.hash(newPassword, 10);
    res.json({ success: true, message: "Password changed successfully" });
});

// Admin auth middleware
function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !adminTokens.has(token)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    next();
}

// ==================== ADMIN API ENDPOINTS ====================

// Get admin stats
app.get("/api/admin/stats", verifyAdminToken, (req, res) => {
    const players = Array.from(gameState.players.values());
    const totalBalance = players.reduce((sum, p) => sum + (p.balance || 0), 0);
    const totalSelected = players.reduce((sum, p) => sum + (p.selectedCartelas?.length || 0), 0);
    
    res.json({
        success: true,
        status: gameState.status,
        round: gameState.round,
        timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers,
        playersCount: players.length,
        totalBalance: totalBalance.toFixed(2),
        totalSelected,
        winPercentage: gameState.winPercentage,
        totalBet: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        adminCommission: gameState.adminCommission
    });
});

// Update win percentage
app.post("/api/admin/win-percentage", verifyAdminToken, (req, res) => {
    const { percentage } = req.body;
    
    if (!WIN_PERCENTAGES.includes(percentage)) {
        return res.status(400).json({ success: false, message: "Invalid percentage. Allowed: 70, 75, 76, 80" });
    }
    
    gameState.winPercentage = percentage;
    io.emit('winPercentageChanged', { percentage });
    res.json({ success: true, message: `Win percentage updated to ${percentage}%` });
});

// Force start game
app.post("/api/admin/start-game", verifyAdminToken, (req, res) => {
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

// Force end game
app.post("/api/admin/end-game", verifyAdminToken, (req, res) => {
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

// Reset game
app.post("/api/admin/reset-game", verifyAdminToken, (req, res) => {
    if (selectionTimer) clearInterval(selectionTimer);
    if (drawTimer) clearInterval(drawTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    
    selectionTimer = drawTimer = nextRoundTimer = null;
    
    gameState = {
        status: 'selection',
        round: 1,
        timer: SELECTION_TIME,
        drawnNumbers: [],
        winners: [],
        players: gameState.players,
        totalBet: 0,
        winnerReward: 0,
        adminCommission: 0,
        winPercentage: DEFAULT_WIN_PERCENTAGE,
        roundStartTime: null,
        roundEndTime: null
    };
    
    for (const [socketId, player] of gameState.players) {
        player.selectedCartelas = [];
    }
    
    startSelectionTimer();
    io.emit('gameReset', { message: 'Game has been reset by admin!' });
    res.json({ success: true, message: "Game reset successfully!" });
});

// Add player balance
app.post("/api/admin/add-balance", verifyAdminToken, (req, res) => {
    const { socketId, amount } = req.body;
    const player = gameState.players.get(socketId);
    
    if (!player) {
        return res.status(404).json({ success: false, message: "Player not found" });
    }
    
    player.balance += amount;
    
    gameData.transactions.push({
        userId: socketId,
        username: player.username,
        type: 'admin_add',
        amount,
        timestamp: new Date().toISOString()
    });
    saveData();
    
    io.to(socketId).emit('balanceUpdated', { balance: player.balance });
    res.json({ success: true, newBalance: player.balance });
});

// Get all players
app.get("/api/admin/players", verifyAdminToken, (req, res) => {
    const players = Array.from(gameState.players.values()).map(p => ({
        socketId: p.socketId,
        username: p.username,
        balance: p.balance,
        selectedCartelas: p.selectedCartelas,
        totalWon: p.totalWon || 0,
        totalPlayed: p.totalPlayed || 0,
        gamesWon: p.gamesWon || 0
    }));
    res.json({ success: true, players });
});

// ==================== REPORT ENDPOINTS ====================

// Daily report
app.get("/api/reports/daily", verifyAdminToken, (req, res) => {
    const { date } = req.query;
    const report = generateDailyReport(date);
    res.json({ success: true, report });
});

// Weekly report
app.get("/api/reports/weekly", verifyAdminToken, (req, res) => {
    const { year, week } = req.query;
    const report = generateWeeklyReport(year ? parseInt(year) : null, week ? parseInt(week) : null);
    res.json({ success: true, report });
});

// Monthly report
app.get("/api/reports/monthly", verifyAdminToken, (req, res) => {
    const { year, month } = req.query;
    const report = generateMonthlyReport(year ? parseInt(year) : null, month ? parseInt(month) : null);
    res.json({ success: true, report });
});

// Date range report
app.get("/api/reports/range", verifyAdminToken, (req, res) => {
    const { startDate, endDate } = req.query;
    
    const rounds = gameData.gameRounds.filter(r => {
        const date = r.timestamp?.split('T')[0];
        return date >= startDate && date <= endDate;
    });
    
    const totalGames = rounds.length;
    const totalBet = rounds.reduce((sum, r) => sum + (r.totalPool || 0), 0);
    const totalWon = rounds.reduce((sum, r) => sum + (r.winnerReward || 0), 0);
    const totalCommission = rounds.reduce((sum, r) => sum + (r.adminCommission || 0), 0);
    
    res.json({
        success: true,
        report: {
            startDate,
            endDate,
            totalGames,
            totalBet,
            totalWon,
            totalCommission,
            rounds: rounds.map(r => ({
                roundId: r.roundId,
                date: r.timestamp,
                totalPlayers: r.totalPlayers,
                totalBet: r.totalPool,
                winnerReward: r.winnerReward,
                adminCommission: r.adminCommission,
                winners: r.winners
            }))
        }
    });
});

// Commission summary
app.get("/api/reports/commission", verifyAdminToken, (req, res) => {
    const totalCommission = gameData.gameRounds.reduce((sum, r) => sum + (r.adminCommission || 0), 0);
    const commissionByRound = gameData.gameRounds.map(r => ({
        roundId: r.roundId,
        date: r.timestamp,
        totalPool: r.totalPool,
        adminCommission: r.adminCommission,
        percentage: ((r.adminCommission / r.totalPool) * 100).toFixed(2)
    }));
    
    res.json({
        success: true,
        totalCommission,
        commissionByRound
    });
});

// ==================== SOCKET.IO CONNECTION HANDLER ====================
io.on("connection", (socket) => {
    console.log(`🟢 Player connected: ${socket.id}`);
    
    const defaultUsername = `Player_${socket.id.slice(-4)}`;
    
    const playerData = {
        socketId: socket.id,
        username: defaultUsername,
        selectedCartelas: [],
        balance: 100,
        totalWon: 0,
        totalPlayed: 0,
        gamesWon: 0,
        joinedAt: Date.now()
    };
    
    gameState.players.set(socket.id, playerData);
    
    socket.emit('registered', {
        socketId: socket.id,
        username: defaultUsername,
        balance: 100,
        gameState: {
            status: gameState.status,
            round: gameState.round,
            timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers,
            winPercentage: gameState.winPercentage
        }
    });
    
    socket.emit('gameState', {
        status: gameState.status,
        round: gameState.round,
        timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers,
        playersCount: gameState.players.size,
        winPercentage: gameState.winPercentage
    });
    
    socket.emit('timerUpdate', {
        seconds: gameState.timer,
        round: gameState.round,
        formatted: formatTime(gameState.timer)
    });
    
    io.emit('playersUpdate', {
        count: gameState.players.size,
        players: Array.from(gameState.players.values()).map(p => ({
            username: p.username,
            selectedCount: p.selectedCartelas.length,
            balance: p.balance
        }))
    });
    
    // Set username
    socket.on("setUsername", (data) => {
        const player = gameState.players.get(socket.id);
        if (player && data.username && data.username.trim().length > 0) {
            player.username = data.username.trim().substring(0, 20);
            socket.emit('usernameChanged', { username: player.username });
            broadcastGameState();
        }
    });
    
    // Select cartela
    socket.on("selectCartela", (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;
        
        if (gameState.status !== 'selection') {
            socket.emit("error", { message: `Cannot select. Game is ${gameState.status}. Wait for next round.` });
            return;
        }
        
        if (player.selectedCartelas.length >= MAX_CARTELAS) {
            socket.emit("error", { message: `Maximum ${MAX_CARTELAS} cartelas allowed!` });
            return;
        }
        
        if (player.selectedCartelas.includes(data.cartelaNumber)) {
            socket.emit("error", { message: `Cartela ${data.cartelaNumber} already selected!` });
            return;
        }
        
        if (player.balance < BET_AMOUNT) {
            socket.emit("error", { message: `Insufficient balance! Need ${BET_AMOUNT} ETB.` });
            return;
        }
        
        player.balance -= BET_AMOUNT;
        player.selectedCartelas.push(data.cartelaNumber);
        
        gameData.transactions.push({
            userId: socket.id,
            username: player.username,
            type: 'bet',
            amount: BET_AMOUNT,
            cartela: data.cartelaNumber,
            round: gameState.round,
            timestamp: new Date().toISOString()
        });
        saveData();
        
        socket.emit("selectionConfirmed", {
            cartela: data.cartelaNumber,
            selectedCount: player.selectedCartelas.length,
            balance: player.balance,
            remainingSlots: MAX_CARTELAS - player.selectedCartelas.length
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
    });
    
    // Deselect cartela
    socket.on("deselectCartela", (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;
        
        if (gameState.status !== 'selection') {
            socket.emit("error", { message: "Cannot deselect after game started!" });
            return;
        }
        
        const index = player.selectedCartelas.indexOf(data.cartelaNumber);
        if (index !== -1) {
            player.selectedCartelas.splice(index, 1);
            player.balance += BET_AMOUNT;
            
            socket.emit("selectionUpdated", {
                selectedCartelas: player.selectedCartelas,
                balance: player.balance
            });
            
            broadcastGameState();
        }
    });
    
    // Get status
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
                gamesWon: player.gamesWon,
                winPercentage: gameState.winPercentage
            });
        }
    });
    
    // Disconnect
    socket.on("disconnect", () => {
        console.log(`🔴 Player disconnected: ${socket.id}`);
        gameState.players.delete(socket.id);
        io.emit('playersUpdate', {
            count: gameState.players.size,
            players: Array.from(gameState.players.values()).map(p => ({
                username: p.username,
                selectedCount: p.selectedCartelas.length,
                balance: p.balance
            }))
        });
        broadcastGameState();
    });
});

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        gameStatus: gameState.status,
        playersOnline: gameState.players.size,
        totalRounds: gameData.gameRounds.length
    });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;

startSelectionTimer();

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║              🎲 ESTIF BINGO 24/7 - PROFESSIONAL EDITION 🎲               ║
║                                                                           ║
║     📱 Player URL: https://estif-bingo-247.onrender.com/player.html       ║
║     🔐 Admin URL:  https://estif-bingo-247.onrender.com/admin.html        ║
║                                                                           ║
║     👤 Admin Email: johnsonestiph13@gmail.com                            ║
║     🔑 Admin Password: Jon@2127                                          ║
║                                                                           ║
║     🎮 Game Status: ${gameState.status.padEnd(35)}           ║
║     🌍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(35)}           ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
    `);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, saving data and closing...');
    saveData();
    if (selectionTimer) clearInterval(selectionTimer);
    if (drawTimer) clearInterval(drawTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = { app, server, io, gameState };