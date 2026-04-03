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
    pingInterval: 25000,
    allowEIO3: true
});

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(compression());

// ==================== DATABASE ====================
const fs = require('fs');
const compression = require('compression');
const DATA_FILE = path.join(__dirname, '../data/game-data.json');
const CARTELA_DATA_FILE = path.join(__dirname, '../data/cartelas.json');

if (!fs.existsSync(path.join(__dirname, '../data'))) {
    fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
}

let gameData = { users: [], gameRounds: [], transactions: [], reports: [] };
let cartelaData = {};

try {
    if (fs.existsSync(DATA_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        gameData = { ...gameData, ...loaded };
        console.log("✅ Loaded existing game data");
    }
} catch (err) { console.log("⚠️ No existing data found"); }

try {
    if (fs.existsSync(CARTELA_DATA_FILE)) {
        cartelaData = JSON.parse(fs.readFileSync(CARTELA_DATA_FILE, 'utf8'));
        console.log(`✅ Loaded ${Object.keys(cartelaData).length} cartelas`);
    }
} catch (err) { console.log("⚠️ No cartela data"); }

function saveData() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(gameData, null, 2)); } catch (err) { console.error("Error saving data:", err); }
}

function saveCartelaData() {
    try { fs.writeFileSync(CARTELA_DATA_FILE, JSON.stringify(cartelaData, null, 2)); } catch (err) { console.error("Error saving cartela data:", err); }
}

// ==================== GAME CONSTANTS ====================
const SELECTION_TIME = 50;
const DRAW_INTERVAL = 4000;
const NEXT_ROUND_DELAY = 6000;
const BET_AMOUNT = 10;
const WIN_PERCENTAGES = [70, 75, 76, 80];
const DEFAULT_WIN_PERCENTAGE = 75;
const MAX_CARTELAS = 2;
const TOTAL_CARTELAS = 400;

// ==================== GLOBAL STATE ====================
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
    roundEndTime: null,
    gameActive: false
};

// GLOBAL CARTELA TRACKING - ONE CARTELA PER PLAYER WORLDWIDE
let globalTakenCartelas = new Map(); // cartelaNumber -> { playerId, playerName, timestamp }
let globalTotalSelectedCartelas = 0;

let selectionTimer = null;
let drawTimer = null;
let nextRoundTimer = null;
let adminTokens = new Map();

// ==================== CARTELA FUNCTIONS ====================
function generateRandomBingoCard() {
    const getRandomNumbers = (min, max, count) => {
        const numbers = [], available = [];
        for (let i = min; i <= max; i++) available.push(i);
        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * available.length);
            numbers.push(available[idx]);
            available.splice(idx, 1);
        }
        return numbers;
    };
    const b = getRandomNumbers(1, 15, 5);
    const i = getRandomNumbers(16, 30, 5);
    const n = getRandomNumbers(31, 45, 5);
    const g = getRandomNumbers(46, 60, 5);
    const o = getRandomNumbers(61, 75, 5);
    n[2] = "FREE";
    return [
        [b[0], i[0], n[0], g[0], o[0]],
        [b[1], i[1], n[1], g[1], o[1]],
        [b[2], i[2], n[2], g[2], o[2]],
        [b[3], i[3], n[3], g[3], o[3]],
        [b[4], i[4], n[4], g[4], o[4]]
    ];
}

function getCartelaGrid(cartelaId) {
    if (cartelaData[cartelaId]) return cartelaData[cartelaId].grid;
    const grid = generateRandomBingoCard();
    cartelaData[cartelaId] = { id: cartelaId, grid: grid };
    saveCartelaData();
    return grid;
}

function checkBingoWin(cartelaId, drawnNumbers) {
    const grid = getCartelaGrid(cartelaId);
    if (!grid) return { won: false, winningLines: [] };
    const drawnSet = new Set(drawnNumbers);
    drawnSet.add("FREE");
    const winningLines = [];
    for (let row = 0; row < 5; row++) {
        if (grid[row].every(v => drawnSet.has(v))) winningLines.push(`Row ${row + 1}`);
    }
    for (let col = 0; col < 5; col++) {
        let win = true;
        for (let row = 0; row < 5; row++) if (!drawnSet.has(grid[row][col])) { win = false; break; }
        if (win) winningLines.push(`Column ${col + 1}`);
    }
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
        if (!drawnSet.has(grid[i][i])) d1 = false;
        if (!drawnSet.has(grid[i][4 - i])) d2 = false;
    }
    if (d1) winningLines.push("Diagonal ↘");
    if (d2) winningLines.push("Diagonal ↙");
    return { won: winningLines.length > 0, winningLines };
}

// ==================== GLOBAL CARTELA TRACKING ====================
function isCartelaAvailable(cartelaNumber) {
    return !globalTakenCartelas.has(cartelaNumber);
}

function reserveCartela(cartelaNumber, playerId, playerName) {
    if (globalTakenCartelas.has(cartelaNumber)) return false;
    globalTakenCartelas.set(cartelaNumber, { playerId, playerName, timestamp: Date.now() });
    globalTotalSelectedCartelas = globalTakenCartelas.size;
    return true;
}

function releaseCartela(cartelaNumber, playerId) {
    const cartela = globalTakenCartelas.get(cartelaNumber);
    if (cartela && cartela.playerId === playerId) {
        globalTakenCartelas.delete(cartelaNumber);
        globalTotalSelectedCartelas = globalTakenCartelas.size;
        return true;
    }
    return false;
}

function calculateRewardPool() {
    const totalBetAmount = globalTotalSelectedCartelas * BET_AMOUNT;
    const winnerReward = (totalBetAmount * gameState.winPercentage) / 100;
    const adminCommission = totalBetAmount - winnerReward;
    return { totalBetAmount, winnerReward, adminCommission, totalCartelas: globalTotalSelectedCartelas };
}

function broadcastRewardPool() {
    const { totalBetAmount, winnerReward, totalCartelas } = calculateRewardPool();
    io.emit('rewardPoolUpdate', {
        totalSelectedCartelas: totalCartelas,
        totalBetAmount: totalBetAmount,
        winnerReward: winnerReward,
        winPercentage: gameState.winPercentage,
        remainingCartelas: TOTAL_CARTELAS - totalCartelas
    });
}

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
        socketId: p.socketId,
        username: p.username,
        selectedCount: p.selectedCartelas.length,
        selectedCartelas: p.selectedCartelas,
        balance: p.balance
    }));
    io.emit('gameState', {
        status: gameState.status,
        round: gameState.round,
        timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers,
        playersCount: gameState.players.size,
        players: playersList,
        winPercentage: gameState.winPercentage,
        totalBet: gameState.totalBet,
        winnerReward: gameState.winnerReward
    });
}

function broadcastTimer() {
    io.emit('timerUpdate', { seconds: gameState.timer, round: gameState.round, formatted: formatTime(gameState.timer) });
}

function calculateRewards(totalPlayers, totalCartelas, winPercentage) {
    const totalPool = totalCartelas * BET_AMOUNT;
    const winnerReward = (totalPool * winPercentage) / 100;
    const adminCommission = totalPool - winnerReward;
    return { totalPool, winnerReward, adminCommission };
}

// ==================== GAME CORE ====================
function stopGame() {
    if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
    gameState.gameActive = false;
}

function startSelectionTimer() {
    if (selectionTimer) clearInterval(selectionTimer);
    gameState.status = 'selection';
    gameState.timer = SELECTION_TIME;
    gameState.roundStartTime = new Date();
    gameState.gameActive = false;
    broadcastGameState();
    broadcastTimer();
    selectionTimer = setInterval(() => {
        if (gameState.status !== 'selection') { clearInterval(selectionTimer); selectionTimer = null; return; }
        gameState.timer--;
        broadcastTimer();
        if (gameState.timer === 10) io.emit('warning', { message: '⚠️ Only 10 seconds left to select cartelas!', type: 'warning' });
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
    gameState.gameActive = true;
    
    // Calculate using GLOBAL selected cartelas
    const totalCartelas = globalTotalSelectedCartelas;
    const playersWithCartelas = Array.from(gameState.players.values()).filter(p => p.selectedCartelas.length > 0).length;
    const { totalPool, winnerReward, adminCommission } = calculateRewards(playersWithCartelas, totalCartelas, gameState.winPercentage);
    
    gameState.totalBet = totalPool;
    gameState.winnerReward = winnerReward;
    gameState.adminCommission = adminCommission;
    
    broadcastGameState();
    io.emit('gameStarted', {
        round: gameState.round,
        totalPlayers: playersWithCartelas,
        totalCartelas: totalCartelas,
        totalBet: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        winPercentage: gameState.winPercentage,
        message: `🎲 Game started! ${totalCartelas} cartelas selected worldwide. Prize Pool: ${gameState.winnerReward} ETB`
    });
    
    io.emit('finalRewardPool', {
        totalSelectedCartelas: totalCartelas,
        totalBetAmount: totalPool,
        winnerReward: winnerReward,
        winPercentage: gameState.winPercentage,
        message: `🎯 ${totalCartelas} cartelas selected! Total pool: ${totalPool} ETB. Winner takes ${winnerReward} ETB!`
    });
    
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    let index = 0;
    drawTimer = setInterval(() => {
        if (gameState.status !== 'active' || !gameState.gameActive || gameState.winners.length > 0) {
            if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
            return;
        }
        if (index >= numbers.length) { endRound([]); return; }
        const number = numbers[index++];
        gameState.drawnNumbers.push(number);
        io.emit('numberDrawn', { number, letter: getBingoLetter(number), drawnCount: gameState.drawnNumbers.length, remaining: 75 - gameState.drawnNumbers.length });
        broadcastGameState();
        
        const newWinners = [], winnerDetails = [];
        for (const [socketId, player] of gameState.players) {
            if (player.selectedCartelas.length > 0 && !gameState.winners.includes(socketId)) {
                for (const cartelaId of player.selectedCartelas) {
                    const { won, winningLines } = checkBingoWin(cartelaId, gameState.drawnNumbers);
                    if (won) { newWinners.push(socketId); winnerDetails.push({ socketId, cartelaId, winningLines }); break; }
                }
            }
        }
        if (newWinners.length > 0 && gameState.winners.length === 0) endRound(newWinners, winnerDetails);
    }, DRAW_INTERVAL);
}

function endRound(winnerSocketIds, winnerDetails = []) {
    if (gameState.status !== 'active') return;
    stopGame();
    gameState.status = 'ended';
    gameState.winners = winnerSocketIds;
    gameState.roundEndTime = new Date();
    const winnerCount = winnerSocketIds.length;
    const perWinnerReward = winnerCount > 0 ? gameState.winnerReward / winnerCount : 0;
    const winnerNames = [], winnerCartelas = [];
    for (let i = 0; i < winnerSocketIds.length; i++) {
        const socketId = winnerSocketIds[i];
        const player = gameState.players.get(socketId);
        const detail = winnerDetails.find(d => d.socketId === socketId);
        if (player) {
            player.balance += perWinnerReward;
            player.totalWon = (player.totalWon || 0) + perWinnerReward;
            player.gamesWon = (player.gamesWon || 0) + 1;
            winnerNames.push(player.username);
            if (detail) winnerCartelas.push({ username: player.username, cartelaId: detail.cartelaId, winningLines: detail.winningLines });
            io.to(socketId).emit('youWon', { amount: perWinnerReward, cartelaId: detail?.cartelaId, winningLines: detail?.winningLines, newBalance: player.balance, message: `🎉 You won ${perWinnerReward.toFixed(2)} ETB!` });
            gameData.transactions.push({ userId: socketId, username: player.username, type: 'win', amount: perWinnerReward, round: gameState.round, timestamp: new Date().toISOString() });
        }
    }
    for (const [socketId, player] of gameState.players) { if (player.selectedCartelas.length > 0) player.totalPlayed = (player.totalPlayed || 0) + 1; }
    gameData.gameRounds.push({ roundId: gameState.round, totalPlayers: Array.from(gameState.players.values()).filter(p => p.selectedCartelas.length > 0).length, totalCartelas: globalTotalSelectedCartelas, totalPool: gameState.totalBet, winnerReward: gameState.winnerReward, adminCommission: gameState.adminCommission, winners: winnerNames, winnerCartelas, winnerCount, perWinnerReward, winPercentage: gameState.winPercentage, timestamp: new Date().toISOString() });
    if (gameData.gameRounds.length > 1000) gameData.gameRounds = gameData.gameRounds.slice(-1000);
    saveData();
    io.emit('roundEnded', { winners: winnerNames, winnerCartelas, winnerCount, winnerReward: perWinnerReward, totalPool: gameState.totalBet, adminCommission: gameState.adminCommission, winPercentage: gameState.winPercentage, round: gameState.round, message: winnerCount > 0 ? `🎉 BINGO! Winners: ${winnerNames.join(', ')}. Each wins ${perWinnerReward.toFixed(2)} ETB!` : 'No winners this round!' });
    broadcastGameState();
    scheduleNextRound();
}

function scheduleNextRound() {
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    let countdown = NEXT_ROUND_DELAY / 1000;
    const countdownInterval = setInterval(() => { io.emit('nextRoundCountdown', { seconds: countdown }); countdown--; if (countdown < 0) clearInterval(countdownInterval); }, 1000);
    nextRoundTimer = setTimeout(() => { resetForNextRound(); nextRoundTimer = null; }, NEXT_ROUND_DELAY);
}

function resetForNextRound() {
    for (const [socketId, player] of gameState.players) player.selectedCartelas = [];
    globalTakenCartelas.clear();
    globalTotalSelectedCartelas = 0;
    gameState.round++;
    gameState.status = 'selection';
    gameState.timer = SELECTION_TIME;
    gameState.drawnNumbers = [];
    gameState.winners = [];
    gameState.totalBet = 0;
    gameState.winnerReward = 0;
    gameState.adminCommission = 0;
    gameState.gameActive = false;
    broadcastGameState();
    broadcastTimer();
    broadcastRewardPool();
    io.emit('nextRound', { round: gameState.round, timer: SELECTION_TIME, message: `🎲 Round ${gameState.round} starting! Select up to ${MAX_CARTELAS} cartelas within ${SELECTION_TIME} seconds.` });
    startSelectionTimer();
}

// ==================== ADMIN AUTH ====================
const ADMIN_EMAIL = "johnsonestiph13@gmail.com";
let ADMIN_PASSWORD_HASH = null;
(async () => { ADMIN_PASSWORD_HASH = await bcrypt.hash("Jon@2127", 10); console.log("✅ Admin password initialized"); })();

app.post("/api/admin/login", async (req, res) => {
    const { email, password } = req.body;
    if (email !== ADMIN_EMAIL) return res.status(401).json({ success: false, message: "Invalid credentials" });
    const isValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!isValid) return res.status(401).json({ success: false, message: "Invalid credentials" });
    const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET || "estif-secret-key", { expiresIn: "24h" });
    adminTokens.set(token, Date.now());
    res.json({ success: true, token, message: "Login successful" });
});

app.post("/api/admin/change-password", async (req, res) => {
    const { currentPassword, newPassword, token } = req.body;
    if (!adminTokens.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    const isValid = await bcrypt.compare(currentPassword, ADMIN_PASSWORD_HASH);
    if (!isValid) return res.status(401).json({ success: false, message: "Current password is incorrect" });
    ADMIN_PASSWORD_HASH = await bcrypt.hash(newPassword, 10);
    res.json({ success: true, message: "Password changed successfully" });
});

function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !adminTokens.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    next();
}

// ==================== API ENDPOINTS ====================
app.get("/api/cartela/:id", (req, res) => {
    const id = parseInt(req.params.id);
    if (id < 1 || id > TOTAL_CARTELAS) return res.status(400).json({ success: false, message: "Invalid cartela ID" });
    res.json({ success: true, cartelaId: id, grid: getCartelaGrid(id) });
});

app.get("/api/global-stats", (req, res) => {
    const { totalBetAmount, winnerReward, totalCartelas } = calculateRewardPool();
    res.json({ success: true, totalSelectedCartelas: totalCartelas, totalBetAmount, winnerReward, winPercentage: gameState.winPercentage, remainingCartelas: TOTAL_CARTELAS - totalCartelas });
});

app.get("/api/admin/stats", verifyAdminToken, (req, res) => {
    const players = Array.from(gameState.players.values());
    const totalBalance = players.reduce((sum, p) => sum + (p.balance || 0), 0);
    res.json({ success: true, status: gameState.status, round: gameState.round, timer: gameState.timer, drawnNumbers: gameState.drawnNumbers, playersCount: players.length, totalBalance: totalBalance.toFixed(2), winPercentage: gameState.winPercentage, totalBet: gameState.totalBet, winnerReward: gameState.winnerReward, adminCommission: gameState.adminCommission, globalSelectedCartelas: globalTotalSelectedCartelas });
});

app.post("/api/admin/win-percentage", verifyAdminToken, (req, res) => {
    const { percentage } = req.body;
    if (!WIN_PERCENTAGES.includes(percentage)) return res.status(400).json({ success: false, message: "Invalid percentage" });
    gameState.winPercentage = percentage;
    io.emit('winPercentageChanged', { percentage });
    broadcastRewardPool();
    res.json({ success: true, message: `Win percentage updated to ${percentage}%` });
});

app.post("/api/admin/start-game", verifyAdminToken, (req, res) => {
    if (gameState.status === 'selection') {
        if (selectionTimer) { clearInterval(selectionTimer); selectionTimer = null; }
        startActiveGame();
        res.json({ success: true, message: "Game started forcefully!" });
    } else res.json({ success: false, message: `Cannot start game. Current status: ${gameState.status}` });
});

app.post("/api/admin/end-game", verifyAdminToken, (req, res) => {
    if (gameState.status === 'active') { stopGame(); endRound([]); res.json({ success: true, message: "Game ended forcefully!" }); }
    else res.json({ success: false, message: `Cannot end game. Current status: ${gameState.status}` });
});

app.post("/api/admin/reset-game", verifyAdminToken, (req, res) => {
    stopGame();
    if (selectionTimer) clearInterval(selectionTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    selectionTimer = nextRoundTimer = null;
    gameState = { status: 'selection', round: 1, timer: SELECTION_TIME, drawnNumbers: [], winners: [], players: gameState.players, totalBet: 0, winnerReward: 0, adminCommission: 0, winPercentage: DEFAULT_WIN_PERCENTAGE, roundStartTime: null, roundEndTime: null, gameActive: false };
    globalTakenCartelas.clear();
    globalTotalSelectedCartelas = 0;
    for (const [socketId, player] of gameState.players) player.selectedCartelas = [];
    startSelectionTimer();
    broadcastRewardPool();
    io.emit('gameReset', { message: 'Game has been reset by admin!' });
    res.json({ success: true, message: "Game reset successfully!" });
});

app.post("/api/admin/add-balance", verifyAdminToken, (req, res) => {
    const { socketId, amount } = req.body;
    if (!socketId) return res.status(400).json({ success: false, message: "Socket ID required" });
    const addAmount = parseFloat(amount);
    if (isNaN(addAmount) || addAmount <= 0) return res.status(400).json({ success: false, message: "Amount must be positive" });
    const player = gameState.players.get(socketId);
    if (!player) return res.status(404).json({ success: false, message: "Player not found" });
    player.balance += addAmount;
    gameData.transactions.push({ userId: socketId, username: player.username, type: 'admin_add', amount: addAmount, newBalance: player.balance, timestamp: new Date().toISOString() });
    saveData();
    io.to(socketId).emit('balanceUpdated', { balance: player.balance, added: addAmount });
    res.json({ success: true, newBalance: player.balance });
});

app.post("/api/admin/remove-balance", verifyAdminToken, (req, res) => {
    const { socketId, amount } = req.body;
    if (!socketId) return res.status(400).json({ success: false, message: "Socket ID required" });
    const removeAmount = parseFloat(amount);
    if (isNaN(removeAmount) || removeAmount <= 0) return res.status(400).json({ success: false, message: "Amount must be positive" });
    const player = gameState.players.get(socketId);
    if (!player) return res.status(404).json({ success: false, message: "Player not found" });
    if (player.balance < removeAmount) return res.status(400).json({ success: false, message: "Insufficient balance", currentBalance: player.balance });
    player.balance -= removeAmount;
    gameData.transactions.push({ userId: socketId, username: player.username, type: 'admin_remove', amount: removeAmount, newBalance: player.balance, timestamp: new Date().toISOString() });
    saveData();
    io.to(socketId).emit('balanceUpdated', { balance: player.balance, removed: removeAmount });
    res.json({ success: true, newBalance: player.balance });
});

app.get("/api/admin/players", verifyAdminToken, (req, res) => {
    const players = Array.from(gameState.players.values()).map(p => ({ socketId: p.socketId, username: p.username, balance: p.balance, selectedCartelas: p.selectedCartelas, totalWon: p.totalWon || 0, totalPlayed: p.totalPlayed || 0, gamesWon: p.gamesWon || 0 }));
    res.json({ success: true, players });
});

app.get("/api/admin/player-transactions/:socketId", verifyAdminToken, (req, res) => {
    const { socketId } = req.params;
    const transactions = gameData.transactions.filter(t => t.userId === socketId);
    res.json({ success: true, transactions });
});

// Report endpoints
app.get("/api/reports/daily", verifyAdminToken, (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const rounds = gameData.gameRounds.filter(r => r.timestamp?.startsWith(date));
    res.json({ success: true, report: { date, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0), rounds } });
});

app.get("/api/reports/weekly", verifyAdminToken, (req, res) => {
    const now = new Date();
    const weekNumber = getWeekNumber(now);
    const rounds = gameData.gameRounds.filter(r => getWeekNumber(new Date(r.timestamp)) === weekNumber);
    res.json({ success: true, report: { week: weekNumber, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0) } });
});

app.get("/api/reports/monthly", verifyAdminToken, (req, res) => {
    const { year, month } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    const rounds = gameData.gameRounds.filter(r => { const d = new Date(r.timestamp); return d.getFullYear() === targetYear && (d.getMonth() + 1) === targetMonth; });
    res.json({ success: true, report: { year: targetYear, month: targetMonth, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0) } });
});

app.get("/api/reports/range", verifyAdminToken, (req, res) => {
    const { startDate, endDate } = req.query;
    const rounds = gameData.gameRounds.filter(r => { const date = r.timestamp?.split('T')[0]; return date >= startDate && date <= endDate; });
    res.json({ success: true, report: { startDate, endDate, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0), rounds } });
});

app.get("/api/reports/commission", verifyAdminToken, (req, res) => {
    const totalCommission = gameData.gameRounds.reduce((sum, r) => sum + (r.adminCommission || 0), 0);
    const commissionByRound = gameData.gameRounds.map(r => ({ roundId: r.roundId, date: r.timestamp, totalPool: r.totalPool, adminCommission: r.adminCommission, percentage: ((r.adminCommission / r.totalPool) * 100).toFixed(2) }));
    res.json({ success: true, totalCommission, commissionByRound });
});

function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date().toISOString(), uptime: process.uptime(), gameStatus: gameState.status, playersOnline: gameState.players.size, totalRounds: gameData.gameRounds.length, globalSelectedCartelas: globalTotalSelectedCartelas });
});

// ==================== SOCKET.IO ====================
io.on("connection", (socket) => {
    console.log(`🟢 Player connected: ${socket.id}`);
    const defaultUsername = `Player_${socket.id.slice(-4)}`;
    const playerData = { socketId: socket.id, username: defaultUsername, selectedCartelas: [], balance: 100, totalWon: 0, totalPlayed: 0, gamesWon: 0, joinedAt: Date.now() };
    gameState.players.set(socket.id, playerData);
    
    socket.emit('registered', { socketId: socket.id, username: defaultUsername, balance: 100, gameState: { status: gameState.status, round: gameState.round, timer: gameState.timer, drawnNumbers: gameState.drawnNumbers, winPercentage: gameState.winPercentage } });
    socket.emit('gameState', { status: gameState.status, round: gameState.round, timer: gameState.timer, drawnNumbers: gameState.drawnNumbers, playersCount: gameState.players.size, winPercentage: gameState.winPercentage });
    socket.emit('timerUpdate', { seconds: gameState.timer, round: gameState.round, formatted: formatTime(gameState.timer) });
    
    // Send initial global stats
    const { totalBetAmount, winnerReward, totalCartelas, remainingCartelas } = calculateRewardPool();
    socket.emit('rewardPoolUpdate', { totalSelectedCartelas: totalCartelas, totalBetAmount, winnerReward, winPercentage: gameState.winPercentage, remainingCartelas });
    
    io.emit('playersUpdate', { count: gameState.players.size, players: Array.from(gameState.players.values()).map(p => ({ socketId: p.socketId, username: p.username, selectedCount: p.selectedCartelas.length, selectedCartelas: p.selectedCartelas, balance: p.balance })) });
    
    socket.on("setUsername", (data) => {
        const player = gameState.players.get(socket.id);
        if (player && data.username && data.username.trim().length > 0) {
            player.username = data.username.trim().substring(0, 20);
            socket.emit('usernameChanged', { username: player.username });
            broadcastGameState();
        }
    });
    
    socket.on("selectCartela", async (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return socket.emit("error", { message: "Player not found" });
        if (gameState.status !== 'selection') return socket.emit("error", { message: `Cannot select. Game is ${gameState.status}. Wait for next round.` });
        if (player.selectedCartelas.length >= MAX_CARTELAS) return socket.emit("error", { message: `Maximum ${MAX_CARTELAS} cartelas allowed!` });
        if (player.selectedCartelas.includes(data.cartelaNumber)) return socket.emit("error", { message: `Cartela ${data.cartelaNumber} already selected!` });
        if (player.balance < BET_AMOUNT) return socket.emit("error", { message: `Insufficient balance! Need ${BET_AMOUNT} ETB. Your balance: ${player.balance} ETB` });
        
        if (!isCartelaAvailable(data.cartelaNumber)) {
            const takenBy = globalTakenCartelas.get(data.cartelaNumber);
            return socket.emit("error", { message: `❌ Cartela ${data.cartelaNumber} is already selected by ${takenBy.playerName}! Please choose another.`, cartelaNumber: data.cartelaNumber, takenBy: takenBy.playerName });
        }
        
        if (!reserveCartela(data.cartelaNumber, socket.id, player.username)) return socket.emit("error", { message: `Cartela ${data.cartelaNumber} was just taken!` });
        
        player.balance -= BET_AMOUNT;
        player.selectedCartelas.push(data.cartelaNumber);
        getCartelaGrid(data.cartelaNumber);
        gameData.transactions.push({ userId: socket.id, username: player.username, type: 'bet', amount: BET_AMOUNT, cartela: data.cartelaNumber, round: gameState.round, timestamp: new Date().toISOString() });
        saveData();
        socket.emit("selectionConfirmed", { cartela: data.cartelaNumber, selectedCount: player.selectedCartelas.length, selectedCartelas: player.selectedCartelas, balance: player.balance, remainingSlots: MAX_CARTELAS - player.selectedCartelas.length });
        
        broadcastRewardPool();
        io.emit('cartelaTaken', { cartelaNumber: data.cartelaNumber, takenBy: player.username, remainingCartelas: TOTAL_CARTELAS - globalTotalSelectedCartelas, totalSelected: globalTotalSelectedCartelas });
        broadcastGameState();
        io.emit('playersUpdate', { count: gameState.players.size, players: Array.from(gameState.players.values()).map(p => ({ socketId: p.socketId, username: p.username, selectedCount: p.selectedCartelas.length, selectedCartelas: p.selectedCartelas, balance: p.balance })) });
    });
    
    socket.on("deselectCartela", (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;
        if (gameState.status !== 'selection') return socket.emit("error", { message: "Cannot deselect after game started!" });
        const index = player.selectedCartelas.indexOf(data.cartelaNumber);
        if (index !== -1) {
            releaseCartela(data.cartelaNumber, socket.id);
            player.selectedCartelas.splice(index, 1);
            player.balance += BET_AMOUNT;
            socket.emit("selectionUpdated", { selectedCartelas: player.selectedCartelas, balance: player.balance });
            broadcastRewardPool();
            io.emit('cartelaReleased', { cartelaNumber: data.cartelaNumber, releasedBy: player.username, availableCartelas: TOTAL_CARTELAS - globalTotalSelectedCartelas, totalSelected: globalTotalSelectedCartelas });
            broadcastGameState();
        }
    });
    
    socket.on("getStatus", () => {
        const player = gameState.players.get(socket.id);
        if (player) socket.emit("playerStatus", { balance: player.balance, selectedCartelas: player.selectedCartelas, gameStatus: gameState.status, timer: gameState.timer, round: gameState.round, drawnNumbers: gameState.drawnNumbers, totalWon: player.totalWon, totalPlayed: player.totalPlayed, gamesWon: player.gamesWon, winPercentage: gameState.winPercentage });
    });
    
    socket.on("getCartelaGrid", async (data, callback) => {
        const grid = getCartelaGrid(data.cartelaId);
        if (callback) callback({ success: true, cartelaId: data.cartelaId, grid });
        else socket.emit("cartelaGrid", { cartelaId: data.cartelaId, grid });
    });
    
    socket.on("disconnect", () => {
        console.log(`🔴 Player disconnected: ${socket.id}`);
        // Release all cartelas held by this player
        for (const [cartelaNum, cartela] of globalTakenCartelas) {
            if (cartela.playerId === socket.id) globalTakenCartelas.delete(cartelaNum);
        }
        globalTotalSelectedCartelas = globalTakenCartelas.size;
        gameState.players.delete(socket.id);
        broadcastRewardPool();
        io.emit('playersUpdate', { count: gameState.players.size, players: Array.from(gameState.players.values()).map(p => ({ socketId: p.socketId, username: p.username, selectedCount: p.selectedCartelas.length, selectedCartelas: p.selectedCartelas, balance: p.balance })) });
        broadcastGameState();
    });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
startSelectionTimer();
server.listen(PORT, () => {
    console.log(`╔═══════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║              🎲 ESTIF BINGO 24/7 - GLOBAL EDITION 🎲                      ║`);
    console.log(`║                                                                           ║`);
    console.log(`║     📱 Player: https://estif-bingo-247.onrender.com/player.html           ║`);
    console.log(`║     🔐 Admin:  https://estif-bingo-247.onrender.com/admin.html            ║`);
    console.log(`║                                                                           ║`);
    console.log(`║     👤 Admin Email: johnsonestiph13@gmail.com                             ║`);
    console.log(`║     🔑 Admin Password: Jon@2127                                           ║`);
    console.log(`║                                                                           ║`);
    console.log(`╚═══════════════════════════════════════════════════════════════════════════╝`);
});

process.on('SIGTERM', () => { saveData(); saveCartelaData(); stopGame(); if (selectionTimer) clearInterval(selectionTimer); if (nextRoundTimer) clearTimeout(nextRoundTimer); server.close(() => { console.log('Server closed'); process.exit(0); }); });

module.exports = { app, server, io, gameState, globalTakenCartelas, globalTotalSelectedCartelas };