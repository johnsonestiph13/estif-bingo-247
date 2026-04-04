const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const compression = require("compression");
const fs = require("fs");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ["websocket", "polling"],
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

// ==================== PERSISTENT DATA ====================
const DATA_FILE = path.join(__dirname, "../data/game-data.json");
const CARTELA_DATA_FILE = path.join(__dirname, "../data/cartelas.json");

if (!fs.existsSync(path.join(__dirname, "../data"))) {
    fs.mkdirSync(path.join(__dirname, "../data"), { recursive: true });
}

let gameData = {
    users: [],
    pendingRegistrations: [],
    gameRounds: [],
    transactions: [],
    balanceRequests: []
};
let cartelaData = {};

try {
    if (fs.existsSync(DATA_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        gameData = { ...gameData, ...loaded };
        console.log("✅ Loaded existing game data");
    }
} catch (err) { console.log("⚠️ No existing data, starting fresh"); }

try {
    if (fs.existsSync(CARTELA_DATA_FILE)) {
        cartelaData = JSON.parse(fs.readFileSync(CARTELA_DATA_FILE, "utf8"));
        console.log(`✅ Loaded ${Object.keys(cartelaData).length} cartelas`);
    }
} catch (err) { console.log("⚠️ No cartela data file"); }

function saveData() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(gameData, null, 2)); } catch (err) { console.error("Save error:", err); }
}
function saveCartelaData() {
    try { fs.writeFileSync(CARTELA_DATA_FILE, JSON.stringify(cartelaData, null, 2)); } catch (err) { console.error("Save cartela error:", err); }
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
    status: "selection",
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

let globalTakenCartelas = new Map();
let globalTotalSelectedCartelas = 0;
let selectionTimer = null;
let drawTimer = null;
let nextRoundTimer = null;
let adminTokens = new Map();

// ==================== CARTELA HELPERS ====================
function generateRandomBingoCard() {
    const getRandomNumbers = (min, max, count) => {
        const nums = [], avail = [];
        for (let i = min; i <= max; i++) avail.push(i);
        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * avail.length);
            nums.push(avail[idx]);
            avail.splice(idx, 1);
        }
        return nums;
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
    cartelaData[cartelaId] = { id: cartelaId, grid };
    saveCartelaData();
    return grid;
}

function checkBingoWin(cartelaId, drawnNumbers) {
    const grid = getCartelaGrid(cartelaId);
    if (!grid) return { won: false, winningLines: [] };
    const drawnSet = new Set(drawnNumbers);
    drawnSet.add("FREE");
    const lines = [];
    for (let r = 0; r < 5; r++) if (grid[r].every(v => drawnSet.has(v))) lines.push(`Row ${r+1}`);
    for (let c = 0; c < 5; c++) {
        let win = true;
        for (let r = 0; r < 5; r++) if (!drawnSet.has(grid[r][c])) { win = false; break; }
        if (win) lines.push(`Column ${c+1}`);
    }
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
        if (!drawnSet.has(grid[i][i])) d1 = false;
        if (!drawnSet.has(grid[i][4-i])) d2 = false;
    }
    if (d1) lines.push("Diagonal ↘");
    if (d2) lines.push("Diagonal ↙");
    return { won: lines.length > 0, winningLines: lines };
}

// ==================== GLOBAL CARTELA TRACKING ====================
function isCartelaAvailable(cartelaNumber) { return !globalTakenCartelas.has(cartelaNumber); }
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
    return { totalBetAmount, winnerReward, totalCartelas: globalTotalSelectedCartelas };
}
function broadcastRewardPool() {
    const { totalBetAmount, winnerReward, totalCartelas } = calculateRewardPool();
    io.emit("rewardPoolUpdate", {
        totalSelectedCartelas: totalCartelas,
        totalBetAmount,
        winnerReward,
        winPercentage: gameState.winPercentage,
        remainingCartelas: TOTAL_CARTELAS - totalCartelas
    });
}

// ==================== GAME CORE ====================
function getBingoLetter(num) {
    if (num <= 15) return "B";
    if (num <= 30) return "I";
    if (num <= 45) return "N";
    if (num <= 60) return "G";
    return "O";
}
function formatTime(sec) { return `${Math.floor(sec/60)}:${(sec%60).toString().padStart(2,"0")}`; }

function broadcastGameState() {
    const playersList = Array.from(gameState.players.values()).map(p => ({
        socketId: p.socketId, username: p.username, phone: p.phone,
        selectedCount: p.selectedCartelas.length, selectedCartelas: p.selectedCartelas, balance: p.balance
    }));
    io.emit("gameState", {
        status: gameState.status, round: gameState.round, timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers, playersCount: gameState.players.size,
        players: playersList, winPercentage: gameState.winPercentage,
        totalBet: gameState.totalBet, winnerReward: gameState.winnerReward
    });
}
function broadcastTimer() { io.emit("timerUpdate", { seconds: gameState.timer, round: gameState.round, formatted: formatTime(gameState.timer) }); }

function stopGame() { if (drawTimer) clearInterval(drawTimer); drawTimer = null; gameState.gameActive = false; }

function startSelectionTimer() {
    if (selectionTimer) clearInterval(selectionTimer);
    gameState.status = "selection";
    gameState.timer = SELECTION_TIME;
    gameState.roundStartTime = new Date();
    gameState.gameActive = false;
    broadcastGameState();
    broadcastTimer();
    selectionTimer = setInterval(() => {
        if (gameState.status !== "selection") { clearInterval(selectionTimer); selectionTimer = null; return; }
        gameState.timer--;
        broadcastTimer();
        if (gameState.timer === 10) io.emit("warning", { message: "⚠️ Only 10 seconds left to select cartelas!", type: "warning" });
        if (gameState.timer <= 0) {
            clearInterval(selectionTimer);
            selectionTimer = null;
            startActiveGame();
        }
    }, 1000);
}

function startActiveGame() {
    gameState.status = "active";
    gameState.drawnNumbers = [];
    gameState.winners = [];
    gameState.gameActive = true;
    const totalCartelas = globalTotalSelectedCartelas;
    const playersWithCartelas = Array.from(gameState.players.values()).filter(p => p.selectedCartelas.length > 0).length;
    const { totalBetAmount, winnerReward } = calculateRewardPool();
    gameState.totalBet = totalBetAmount;
    gameState.winnerReward = winnerReward;
    gameState.adminCommission = totalBetAmount - winnerReward;
    broadcastGameState();
    io.emit("gameStarted", {
        round: gameState.round, totalPlayers: playersWithCartelas, totalCartelas,
        totalBet: gameState.totalBet, winnerReward: gameState.winnerReward,
        winPercentage: gameState.winPercentage,
        message: `🎲 Game started! ${totalCartelas} cartelas selected worldwide. Prize Pool: ${gameState.winnerReward} ETB`
    });
    io.emit("finalRewardPool", {
        totalSelectedCartelas: totalCartelas, totalBetAmount, winnerReward,
        winPercentage: gameState.winPercentage,
        message: `🎯 ${totalCartelas} cartelas selected! Total pool: ${totalBetAmount} ETB. Winner takes ${winnerReward} ETB!`
    });
    const numbers = Array.from({ length: 75 }, (_, i) => i+1);
    for (let i = numbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i+1));
        [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    let idx = 0;
    drawTimer = setInterval(() => {
        if (gameState.status !== "active" || !gameState.gameActive || gameState.winners.length > 0) {
            if (drawTimer) clearInterval(drawTimer);
            return;
        }
        if (idx >= numbers.length) { endRound([]); return; }
        const num = numbers[idx++];
        gameState.drawnNumbers.push(num);
        io.emit("numberDrawn", { number: num, letter: getBingoLetter(num), drawnCount: gameState.drawnNumbers.length, remaining: 75 - gameState.drawnNumbers.length });
        broadcastGameState();
        const newWinners = [], details = [];
        for (const [sid, pl] of gameState.players) {
            if (pl.selectedCartelas.length && !gameState.winners.includes(sid)) {
                for (const cid of pl.selectedCartelas) {
                    const { won, winningLines } = checkBingoWin(cid, gameState.drawnNumbers);
                    if (won) { newWinners.push(sid); details.push({ socketId: sid, cartelaId: cid, winningLines }); break; }
                }
            }
        }
        if (newWinners.length && gameState.winners.length === 0) endRound(newWinners, details);
    }, DRAW_INTERVAL);
}

// ==================== ENHANCED END ROUND FUNCTION ====================
function endRound(winnerSocketIds, winnerDetails = []) {
    if (gameState.status !== "active") return;
    stopGame();
    gameState.status = "ended";
    gameState.winners = winnerSocketIds;
    gameState.roundEndTime = new Date();
    
    const winnerCount = winnerSocketIds.length;
    const perWinner = winnerCount ? gameState.winnerReward / winnerCount : 0;
    const winnerNames = [];
    const winnerCartelas = [];
    
    for (let i = 0; i < winnerSocketIds.length; i++) {
        const sid = winnerSocketIds[i];
        const pl = gameState.players.get(sid);
        const det = winnerDetails.find(d => d.socketId === sid);
        
        if (pl) {
            pl.balance += perWinner;
            pl.totalWon = (pl.totalWon || 0) + perWinner;
            pl.gamesWon = (pl.gamesWon || 0) + 1;
            winnerNames.push(pl.username);
            
            if (det) {
                winnerCartelas.push({
                    username: pl.username,
                    cartelaId: det.cartelaId,
                    winningLines: det.winningLines
                });
            }
            
            io.to(sid).emit("youWon", {
                amount: perWinner,
                cartelaId: det?.cartelaId,
                winningLines: det?.winningLines,
                newBalance: pl.balance,
                message: `🎉 Congratulations! You won ${perWinner.toFixed(2)} ETB!`
            });
            
            gameData.transactions.push({
                userId: pl.phone,
                username: pl.username,
                type: "win",
                amount: perWinner,
                round: gameState.round,
                timestamp: new Date().toISOString()
            });
        }
    }
    
    // Update total played
    for (const [_, pl] of gameState.players) {
        if (pl.selectedCartelas.length) {
            pl.totalPlayed = (pl.totalPlayed || 0) + 1;
        }
    }
    
    // Save round to history
    gameData.gameRounds.push({
        roundId: gameState.round,
        totalPlayers: Array.from(gameState.players.values()).filter(p => p.selectedCartelas.length > 0).length,
        totalCartelas: globalTotalSelectedCartelas,
        totalPool: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        adminCommission: gameState.adminCommission,
        winners: winnerNames,
        winnerCartelas: winnerCartelas,
        winnerCount,
        perWinnerReward: perWinner,
        winPercentage: gameState.winPercentage,
        timestamp: new Date().toISOString()
    });
    
    if (gameData.gameRounds.length > 1000) gameData.gameRounds = gameData.gameRounds.slice(-1000);
    saveData();
    
    // Broadcast to ALL players with full winner details
    io.emit("roundEnded", {
        winners: winnerNames,
        winnerCartelas: winnerCartelas,  // Contains cartelaId and winningLines
        winnerCount,
        winnerReward: perWinner,
        totalPool: gameState.totalBet,
        adminCommission: gameState.adminCommission,
        winPercentage: gameState.winPercentage,
        round: gameState.round,
        message: winnerCount > 0 
            ? `🎉 BINGO! Winners: ${winnerNames.join(", ")}. Each wins ${perWinner.toFixed(2)} ETB!`
            : "No winners this round! Better luck next time!"
    });
    
    broadcastGameState();
    scheduleNextRound();
}

function scheduleNextRound() {
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    let cd = NEXT_ROUND_DELAY / 1000;
    const interval = setInterval(() => { io.emit("nextRoundCountdown", { seconds: cd }); cd--; if (cd < 0) clearInterval(interval); }, 1000);
    nextRoundTimer = setTimeout(() => { resetForNextRound(); nextRoundTimer = null; }, NEXT_ROUND_DELAY);
}

function resetForNextRound() {
    for (const [_, pl] of gameState.players) pl.selectedCartelas = [];
    globalTakenCartelas.clear();
    globalTotalSelectedCartelas = 0;
    gameState.round++;
    gameState.status = "selection";
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
    io.emit("nextRound", { round: gameState.round, timer: SELECTION_TIME, message: `🎲 Round ${gameState.round} starting! Select up to ${MAX_CARTELAS} cartelas within ${SELECTION_TIME} seconds.` });
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
    res.json({ success: true, token });
});

app.post("/api/admin/change-password", async (req, res) => {
    const { currentPassword, newPassword, token } = req.body;
    if (!adminTokens.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    const isValid = await bcrypt.compare(currentPassword, ADMIN_PASSWORD_HASH);
    if (!isValid) return res.status(401).json({ success: false, message: "Current password incorrect" });
    ADMIN_PASSWORD_HASH = await bcrypt.hash(newPassword, 10);
    res.json({ success: true, message: "Password changed" });
});

function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token || !adminTokens.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    next();
}

// ==================== PHONE REGISTRATION & ADMIN APPROVAL ====================
app.post("/api/player/register", (req, res) => {
    const { phone, socketId } = req.body;
    if (!phone || !phone.match(/^[0-9+\-\s()]{8,15}$/)) {
        return res.status(400).json({ success: false, message: "Invalid phone number" });
    }
    const existingUser = gameData.users.find(u => u.phone === phone);
    if (existingUser) {
        return res.json({ success: true, approved: true, balance: existingUser.balance, message: "Already registered" });
    }
    const existingPending = gameData.pendingRegistrations.find(p => p.phone === phone);
    if (existingPending) {
        return res.json({ success: true, approved: false, message: "Registration pending admin approval" });
    }
    gameData.pendingRegistrations.push({ phone, socketId, timestamp: new Date().toISOString() });
    saveData();
    io.emit("newPendingRegistration", { phone, socketId });
    res.json({ success: true, approved: false, message: "Registration request sent to admin" });
});

app.get("/api/admin/pending-registrations", verifyAdminToken, (req, res) => {
    res.json({ success: true, pending: gameData.pendingRegistrations });
});

app.post("/api/admin/approve-registration", verifyAdminToken, (req, res) => {
    const { phone, socketId, username } = req.body;
    const pendingIndex = gameData.pendingRegistrations.findIndex(p => p.phone === phone);
    if (pendingIndex === -1) return res.status(404).json({ success: false, message: "No pending registration" });
    const newUser = {
        phone,
        username: username || `Player_${phone.slice(-4)}`,
        balance: 30,
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };
    gameData.users.push(newUser);
    gameData.pendingRegistrations.splice(pendingIndex, 1);
    saveData();
    if (socketId) {
        io.to(socketId).emit("registrationApproved", { phone, balance: 30, username: newUser.username });
    }
    res.json({ success: true, message: "Registration approved, player received 30 ETB" });
});

// ==================== BALANCE REQUESTS ====================
app.post("/api/player/request-balance", (req, res) => {
    const { phone, amount, message } = req.body;
    const user = gameData.users.find(u => u.phone === phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const request = {
        id: Date.now(), phone, username: user.username, amount: amount || 100,
        message: message || "Balance request", timestamp: new Date().toISOString(), status: "pending"
    };
    gameData.balanceRequests.push(request);
    saveData();
    io.emit("newBalanceRequest", request);
    res.json({ success: true, requestId: request.id });
});

app.get("/api/admin/balance-requests", verifyAdminToken, (req, res) => {
    const pending = gameData.balanceRequests.filter(r => r.status === "pending");
    res.json({ success: true, requests: pending });
});

app.post("/api/admin/approve-request", verifyAdminToken, (req, res) => {
    const { requestId, amount } = req.body;
    const reqIndex = gameData.balanceRequests.findIndex(r => r.id === requestId);
    if (reqIndex === -1) return res.status(404).json({ success: false, message: "Request not found" });
    const request = gameData.balanceRequests[reqIndex];
    if (request.status !== "pending") return res.status(400).json({ success: false, message: "Already processed" });
    const user = gameData.users.find(u => u.phone === request.phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const addAmount = amount || request.amount;
    user.balance += addAmount;
    request.status = "approved";
    request.processedAt = new Date().toISOString();
    saveData();
    const playerEntry = Array.from(gameState.players.entries()).find(([_, p]) => p.phone === request.phone);
    if (playerEntry) {
        io.to(playerEntry[0]).emit("balanceRequestApproved", { added: addAmount, newBalance: user.balance });
    }
    res.json({ success: true, newBalance: user.balance });
});

// ==================== API ENDPOINTS ====================
app.get("/api/cartela/:id", (req, res) => {
    const id = parseInt(req.params.id);
    if (id < 1 || id > TOTAL_CARTELAS) return res.status(400).json({ success: false, message: "Invalid ID" });
    res.json({ success: true, cartelaId: id, grid: getCartelaGrid(id) });
});

app.get("/api/global-stats", (req, res) => {
    const { totalBetAmount, winnerReward, totalCartelas } = calculateRewardPool();
    res.json({ success: true, totalSelectedCartelas: totalCartelas, totalBetAmount, winnerReward, winPercentage: gameState.winPercentage, remainingCartelas: TOTAL_CARTELAS - totalCartelas });
});

app.get("/api/admin/stats", verifyAdminToken, (req, res) => {
    const players = Array.from(gameState.players.values());
    const totalBalance = players.reduce((s, p) => s + (p.balance || 0), 0);
    res.json({
        success: true, status: gameState.status, round: gameState.round, timer: gameState.timer,
        drawnNumbers: gameState.drawnNumbers, playersCount: players.length, totalBalance: totalBalance.toFixed(2),
        winPercentage: gameState.winPercentage, totalBet: gameState.totalBet, winnerReward: gameState.winnerReward,
        adminCommission: gameState.adminCommission, globalSelectedCartelas: globalTotalSelectedCartelas
    });
});

app.post("/api/admin/win-percentage", verifyAdminToken, (req, res) => {
    const { percentage } = req.body;
    if (!WIN_PERCENTAGES.includes(percentage)) return res.status(400).json({ success: false, message: "Invalid percentage" });
    gameState.winPercentage = percentage;
    io.emit("winPercentageChanged", { percentage });
    broadcastRewardPool();
    res.json({ success: true, message: `Win percentage updated to ${percentage}%` });
});

app.post("/api/admin/start-game", verifyAdminToken, (req, res) => {
    if (gameState.status === "selection") {
        if (selectionTimer) clearInterval(selectionTimer);
        startActiveGame();
        res.json({ success: true, message: "Game started forcefully!" });
    } else res.json({ success: false, message: `Cannot start, status: ${gameState.status}` });
});

app.post("/api/admin/end-game", verifyAdminToken, (req, res) => {
    if (gameState.status === "active") { stopGame(); endRound([]); res.json({ success: true }); }
    else res.json({ success: false });
});

app.post("/api/admin/reset-game", verifyAdminToken, (req, res) => {
    stopGame();
    if (selectionTimer) clearInterval(selectionTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    gameState = {
        status: "selection", round: 1, timer: SELECTION_TIME, drawnNumbers: [], winners: [],
        players: gameState.players, totalBet: 0, winnerReward: 0, adminCommission: 0,
        winPercentage: DEFAULT_WIN_PERCENTAGE, roundStartTime: null, roundEndTime: null, gameActive: false
    };
    globalTakenCartelas.clear();
    globalTotalSelectedCartelas = 0;
    for (const [_, pl] of gameState.players) pl.selectedCartelas = [];
    startSelectionTimer();
    broadcastRewardPool();
    io.emit("gameReset", { message: "Game reset by admin" });
    res.json({ success: true });
});

app.post("/api/admin/add-balance", verifyAdminToken, (req, res) => {
    const { phone, amount, note } = req.body;
    const user = gameData.users.find(u => u.phone === phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    user.balance += amount;
    user.totalManualAdded = (user.totalManualAdded || 0) + amount;
    saveData();
    gameData.transactions.push({
        userId: phone,
        username: user.username,
        type: "admin_add",
        amount: amount,
        note: note || "Manual add by admin",
        timestamp: new Date().toISOString()
    });
    const playerEntry = Array.from(gameState.players.entries()).find(([_, p]) => p.phone === phone);
    if (playerEntry) {
        playerEntry[1].balance = user.balance;
        io.to(playerEntry[0]).emit("balanceUpdated", { balance: user.balance, added: amount });
    }
    res.json({ success: true, newBalance: user.balance });
});

app.post("/api/admin/remove-balance", verifyAdminToken, (req, res) => {
    const { phone, amount, note } = req.body;
    const user = gameData.users.find(u => u.phone === phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.balance < amount) return res.status(400).json({ success: false, message: "Insufficient balance" });
    user.balance -= amount;
    saveData();
    gameData.transactions.push({
        userId: phone,
        username: user.username,
        type: "admin_remove",
        amount: amount,
        note: note || "Manual removal by admin",
        timestamp: new Date().toISOString()
    });
    const playerEntry = Array.from(gameState.players.entries()).find(([_, p]) => p.phone === phone);
    if (playerEntry) {
        playerEntry[1].balance = user.balance;
        io.to(playerEntry[0]).emit("balanceUpdated", { balance: user.balance, removed: amount });
    }
    res.json({ success: true, newBalance: user.balance });
});

app.get("/api/admin/players", verifyAdminToken, (req, res) => {
    const users = gameData.users.map(u => ({
        phone: u.phone, username: u.username, balance: u.balance, totalManualAdded: u.totalManualAdded || 0, registeredAt: u.registeredAt
    }));
    res.json({ success: true, players: users });
});

// ==================== PLAYER SEARCH & TRANSACTION HISTORY ====================
app.get("/api/admin/player/:phone", verifyAdminToken, (req, res) => {
    const phone = req.params.phone;
    const user = gameData.users.find(u => u.phone === phone);
    if (!user) return res.status(404).json({ success: false, message: "Player not found" });
    res.json({ success: true, player: user });
});

app.get("/api/admin/player-transactions/:phone", verifyAdminToken, (req, res) => {
    const phone = req.params.phone;
    const transactions = gameData.transactions.filter(t => t.userId === phone && (t.type === 'admin_add' || t.type === 'admin_remove'));
    res.json({ success: true, transactions });
});

// ==================== REPORT ENDPOINTS ====================
app.get("/api/reports/daily", verifyAdminToken, (req, res) => {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const rounds = gameData.gameRounds.filter(r => r.timestamp?.startsWith(date));
    res.json({ success: true, report: { date, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0) } });
});

app.get("/api/reports/weekly", verifyAdminToken, (req, res) => {
    const { year, week } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetWeek = parseInt(week) || getWeekNumber(new Date());
    const rounds = gameData.gameRounds.filter(r => {
        if (!r.timestamp) return false;
        const d = new Date(r.timestamp);
        return getWeekNumber(d) === targetWeek && d.getFullYear() === targetYear;
    });
    res.json({ success: true, report: { year: targetYear, week: targetWeek, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0) } });
});

app.get("/api/reports/monthly", verifyAdminToken, (req, res) => {
    const { year, month } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    const rounds = gameData.gameRounds.filter(r => {
        if (!r.timestamp) return false;
        const d = new Date(r.timestamp);
        return d.getFullYear() === targetYear && (d.getMonth() + 1) === targetMonth;
    });
    res.json({ success: true, report: { year: targetYear, month: targetMonth, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0) } });
});

app.get("/api/reports/range", verifyAdminToken, (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ success: false, message: "startDate and endDate required" });
    const rounds = gameData.gameRounds.filter(r => {
        if (!r.timestamp) return false;
        const date = r.timestamp.split("T")[0];
        return date >= startDate && date <= endDate;
    });
    res.json({ success: true, report: { startDate, endDate, totalGames: rounds.length, totalBet: rounds.reduce((s, r) => s + (r.totalPool || 0), 0), totalWon: rounds.reduce((s, r) => s + (r.winnerReward || 0), 0), totalCommission: rounds.reduce((s, r) => s + (r.adminCommission || 0), 0) } });
});

app.get("/api/reports/commission", verifyAdminToken, (req, res) => {
    const totalCommission = gameData.gameRounds.reduce((sum, r) => sum + (r.adminCommission || 0), 0);
    const commissionByRound = [...gameData.gameRounds].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).map(r => ({
        roundId: r.roundId, date: r.timestamp, totalPool: r.totalPool || 0,
        adminCommission: r.adminCommission || 0, percentage: r.totalPool ? ((r.adminCommission / r.totalPool) * 100).toFixed(2) : "0"
    }));
    res.json({ success: true, totalCommission, commissionByRound });
});

function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date() });
});

// ==================== SOCKET.IO ====================
io.on("connection", (socket) => {
    console.log(`🟢 New socket connection: ${socket.id}`);

    socket.on("setPhone", async (data) => {
        const { phone } = data;
        const user = gameData.users.find(u => u.phone === phone);
        if (!user) {
            socket.emit("error", { message: "Phone not approved yet. Wait for admin approval." });
            return;
        }
        const playerData = {
            socketId: socket.id,
            phone: user.phone,
            username: user.username,
            selectedCartelas: [],
            balance: user.balance,
            totalWon: 0,
            totalPlayed: 0,
            gamesWon: 0,
            joinedAt: Date.now()
        };
        gameState.players.set(socket.id, playerData);
        user.lastSeen = new Date().toISOString();
        saveData();

        socket.emit("registered", {
            socketId: socket.id,
            username: user.username,
            phone: user.phone,
            balance: user.balance,
            welcomeBonus: 0,
            gameState: {
                status: gameState.status, round: gameState.round, timer: gameState.timer,
                drawnNumbers: gameState.drawnNumbers, winPercentage: gameState.winPercentage
            }
        });
        socket.emit("gameState", {
            status: gameState.status, round: gameState.round, timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers, playersCount: gameState.players.size,
            winPercentage: gameState.winPercentage
        });
        socket.emit("timerUpdate", { seconds: gameState.timer, round: gameState.round, formatted: formatTime(gameState.timer) });

        const { totalBetAmount, winnerReward, totalCartelas } = calculateRewardPool();
        socket.emit("rewardPoolUpdate", {
            totalSelectedCartelas: totalCartelas, totalBetAmount, winnerReward,
            winPercentage: gameState.winPercentage, remainingCartelas: TOTAL_CARTELAS - totalCartelas
        });

        io.emit("playersUpdate", {
            count: gameState.players.size,
            players: Array.from(gameState.players.values()).map(p => ({
                socketId: p.socketId, username: p.username,
                selectedCount: p.selectedCartelas.length, selectedCartelas: p.selectedCartelas,
                balance: p.balance
            }))
        });
    });

    socket.on("setUsername", (data) => {
        const player = gameState.players.get(socket.id);
        if (player && data.username?.trim()) {
            player.username = data.username.trim().substring(0, 20);
            const user = gameData.users.find(u => u.phone === player.phone);
            if (user) user.username = player.username;
            saveData();
            socket.emit("usernameChanged", { username: player.username });
            broadcastGameState();
        }
    });

    socket.on("selectCartela", async (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return socket.emit("error", { message: "Player not found" });
        if (gameState.status !== "selection") return socket.emit("error", { message: `Cannot select now (${gameState.status})` });
        if (player.selectedCartelas.length >= MAX_CARTELAS) return socket.emit("error", { message: `Max ${MAX_CARTELAS} cartelas` });
        if (player.selectedCartelas.includes(data.cartelaNumber)) return socket.emit("error", { message: "Already selected" });
        if (player.balance < BET_AMOUNT) return socket.emit("error", { message: `Insufficient balance: ${player.balance} ETB` });

        if (!isCartelaAvailable(data.cartelaNumber)) {
            const takenBy = globalTakenCartelas.get(data.cartelaNumber);
            return socket.emit("error", { message: `❌ Cartela ${data.cartelaNumber} already taken by ${takenBy.playerName}!` });
        }
        if (!reserveCartela(data.cartelaNumber, socket.id, player.username)) return socket.emit("error", { message: "Just taken by someone else" });

        player.balance -= BET_AMOUNT;
        player.selectedCartelas.push(data.cartelaNumber);
        getCartelaGrid(data.cartelaNumber);
        const user = gameData.users.find(u => u.phone === player.phone);
        if (user) user.balance = player.balance;
        gameData.transactions.push({ userId: player.phone, username: player.username, type: "bet", amount: BET_AMOUNT, cartela: data.cartelaNumber, round: gameState.round, timestamp: new Date().toISOString() });
        saveData();

        socket.emit("selectionConfirmed", {
            cartela: data.cartelaNumber, selectedCount: player.selectedCartelas.length,
            selectedCartelas: player.selectedCartelas, balance: player.balance,
            remainingSlots: MAX_CARTELAS - player.selectedCartelas.length
        });
        broadcastRewardPool();
        io.emit("cartelaTaken", {
            cartelaNumber: data.cartelaNumber, takenBy: player.username,
            remainingCartelas: TOTAL_CARTELAS - globalTotalSelectedCartelas,
            totalSelected: globalTotalSelectedCartelas
        });
        broadcastGameState();
        io.emit("playersUpdate", {
            count: gameState.players.size,
            players: Array.from(gameState.players.values()).map(p => ({
                socketId: p.socketId, username: p.username,
                selectedCount: p.selectedCartelas.length, selectedCartelas: p.selectedCartelas,
                balance: p.balance
            }))
        });
    });

    socket.on("deselectCartela", (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;
        if (gameState.status !== "selection") return socket.emit("error", { message: "Cannot deselect now" });
        const idx = player.selectedCartelas.indexOf(data.cartelaNumber);
        if (idx !== -1) {
            releaseCartela(data.cartelaNumber, socket.id);
            player.selectedCartelas.splice(idx, 1);
            player.balance += BET_AMOUNT;
            const user = gameData.users.find(u => u.phone === player.phone);
            if (user) user.balance = player.balance;
            saveData();
            socket.emit("selectionUpdated", { selectedCartelas: player.selectedCartelas, balance: player.balance });
            broadcastRewardPool();
            io.emit("cartelaReleased", {
                cartelaNumber: data.cartelaNumber, releasedBy: player.username,
                availableCartelas: TOTAL_CARTELAS - globalTotalSelectedCartelas,
                totalSelected: globalTotalSelectedCartelas
            });
            broadcastGameState();
        }
    });

    socket.on("getStatus", () => {
        const player = gameState.players.get(socket.id);
        if (player) socket.emit("playerStatus", {
            balance: player.balance, selectedCartelas: player.selectedCartelas,
            gameStatus: gameState.status, timer: gameState.timer, round: gameState.round,
            drawnNumbers: gameState.drawnNumbers, totalWon: player.totalWon,
            totalPlayed: player.totalPlayed, gamesWon: player.gamesWon,
            winPercentage: gameState.winPercentage
        });
    });

    socket.on("getCartelaGrid", async (data, callback) => {
        const grid = getCartelaGrid(data.cartelaId);
        if (callback) callback({ success: true, cartelaId: data.cartelaId, grid });
        else socket.emit("cartelaGrid", { cartelaId: data.cartelaId, grid });
    });

    socket.on("disconnect", () => {
        console.log(`🔴 Player disconnected: ${socket.id}`);
        for (const [cnum, cart] of globalTakenCartelas) if (cart.playerId === socket.id) globalTakenCartelas.delete(cnum);
        globalTotalSelectedCartelas = globalTakenCartelas.size;
        gameState.players.delete(socket.id);
        broadcastRewardPool();
        io.emit("playersUpdate", {
            count: gameState.players.size,
            players: Array.from(gameState.players.values()).map(p => ({
                socketId: p.socketId, username: p.username,
                selectedCount: p.selectedCartelas.length, selectedCartelas: p.selectedCartelas,
                balance: p.balance
            }))
        });
        broadcastGameState();
    });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
startSelectionTimer();
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║              🎲 ESTIF BINGO 24/7 - GLOBAL EDITION 🎲                      ║
║     📱 Player: https://estif-bingo-247.onrender.com/player.html           ║
║     🔐 Admin:  https://estif-bingo-247.onrender.com/admin.html            ║
║     👤 Admin Email: johnsonestiph13@gmail.com                             ║
║     🔑 Admin Password: Jon@2127                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
    `);
});

process.on("SIGTERM", () => {
    saveData(); saveCartelaData(); stopGame();
    if (selectionTimer) clearInterval(selectionTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    server.close(() => process.exit(0));
});

module.exports = { app, server, io, gameState, globalTakenCartelas, globalTotalSelectedCartelas };