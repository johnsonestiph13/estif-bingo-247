const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const compression = require("compression");
const { Pool } = require("pg");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
require("dotenv").config();

// ==================== ENVIRONMENT VALIDATION ====================
const requiredEnv = ["DATABASE_URL", "JWT_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD_HASH", "BOT_API_URL"];
for (const env of requiredEnv) {
    if (!process.env[env]) {
        console.error(`❌ Missing required environment variable: ${env}`);
        process.exit(1);
    }
}

// ==================== INITIALISE EXPRESS & SOCKET.IO ====================
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
app.use(express.static(path.join(__dirname, "../../public")));
app.use(compression());

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, message: "Too many requests, please try again later." }
});
app.use("/api/", apiLimiter);

const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true
});

// ==================== BOT API URL (Python Bot) ====================
const BOT_API_URL = process.env.BOT_API_URL;

// ==================== POSTGRESQL DATABASE ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                phone VARCHAR(20) PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                balance DECIMAL(10,2) DEFAULT 0,
                total_won DECIMAL(10,2) DEFAULT 0,
                total_played INTEGER DEFAULT 0,
                games_won INTEGER DEFAULT 0,
                total_manual_added DECIMAL(10,2) DEFAULT 0,
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_registrations (
                phone VARCHAR(20) PRIMARY KEY,
                socket_id VARCHAR(50),
                requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS game_rounds (
                round_id SERIAL PRIMARY KEY,
                round_number INTEGER NOT NULL,
                total_players INTEGER DEFAULT 0,
                total_cartelas INTEGER DEFAULT 0,
                total_pool DECIMAL(10,2) DEFAULT 0,
                winner_reward DECIMAL(10,2) DEFAULT 0,
                admin_commission DECIMAL(10,2) DEFAULT 0,
                winners JSONB,
                winner_cartelas JSONB,
                win_percentage INTEGER DEFAULT 75,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(20) REFERENCES users(phone),
                username VARCHAR(50),
                type VARCHAR(20) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                cartela INTEGER,
                round INTEGER,
                note TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS balance_requests (
                id BIGINT PRIMARY KEY,
                phone VARCHAR(20) REFERENCES users(phone),
                username VARCHAR(50),
                amount DECIMAL(10,2) NOT NULL,
                message TEXT,
                status VARCHAR(20) DEFAULT 'pending',
                requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processed_at TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS active_round_selections (
                round_number INTEGER NOT NULL,
                cartela_number INTEGER NOT NULL,
                player_phone VARCHAR(20) REFERENCES users(phone),
                selected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (round_number, cartela_number)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS telegram_links (
                telegram_user_id BIGINT PRIMARY KEY,
                phone VARCHAR(20) REFERENCES users(phone),
                linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_logins (
                phone VARCHAR(20) PRIMARY KEY,
                telegram_user_id BIGINT,
                requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_game_rounds_timestamp ON game_rounds(timestamp)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_active_round_selections_round ON active_round_selections(round_number)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);

        console.log("✅ PostgreSQL tables ready");
    } catch (err) {
        console.error("❌ DB init error:", err);
    } finally {
        client.release();
    }
}
initDatabase();

// ==================== DATABASE HELPER FUNCTIONS ====================
async function getUser(phone) {
    const res = await pool.query("SELECT * FROM users WHERE phone = $1", [phone]);
    return res.rows[0];
}
async function saveUser(user) {
    await pool.query(`
        INSERT INTO users (phone, username, balance, total_won, total_played, games_won, total_manual_added, registered_at, last_seen)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (phone) DO UPDATE SET
            username = EXCLUDED.username,
            balance = EXCLUDED.balance,
            total_won = EXCLUDED.total_won,
            total_played = EXCLUDED.total_played,
            games_won = EXCLUDED.games_won,
            total_manual_added = EXCLUDED.total_manual_added,
            last_seen = EXCLUDED.last_seen
    `, [user.phone, user.username, user.balance, user.total_won, user.total_played, user.games_won, user.total_manual_added, user.registered_at, user.last_seen]);
}
async function saveTransaction(tx) {
    await pool.query(`
        INSERT INTO transactions (user_id, username, type, amount, cartela, round, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [tx.userId, tx.username, tx.type, tx.amount, tx.cartela, tx.round, tx.note]);
}
async function saveGameRound(round) {
    await pool.query(`
        INSERT INTO game_rounds (round_number, total_players, total_cartelas, total_pool, winner_reward, admin_commission, winners, winner_cartelas, win_percentage, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [round.roundNumber, round.totalPlayers, round.totalCartelas, round.totalPool, round.winnerReward, round.adminCommission, JSON.stringify(round.winners), JSON.stringify(round.winnerCartelas), round.winPercentage, round.timestamp]);
}
async function saveBalanceRequest(request) {
    await pool.query(`
        INSERT INTO balance_requests (id, phone, username, amount, message, status, requested_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, processed_at = EXCLUDED.processed_at
    `, [request.id, request.phone, request.username, request.amount, request.message, request.status, request.requested_at]);
}
async function getPendingBalanceRequests() {
    const res = await pool.query("SELECT * FROM balance_requests WHERE status = 'pending' ORDER BY requested_at ASC");
    return res.rows;
}
async function getPendingRegistrations() {
    const res = await pool.query("SELECT * FROM pending_registrations ORDER BY requested_at ASC");
    return res.rows;
}
async function savePendingRegistration(phone, socketId) {
    await pool.query(`
        INSERT INTO pending_registrations (phone, socket_id, requested_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (phone) DO UPDATE SET socket_id = EXCLUDED.socket_id, requested_at = EXCLUDED.requested_at
    `, [phone, socketId]);
}
async function deletePendingRegistration(phone) {
    await pool.query("DELETE FROM pending_registrations WHERE phone = $1", [phone]);
}
async function getAllGameRounds() {
    const res = await pool.query("SELECT * FROM game_rounds ORDER BY round_id DESC");
    return res.rows;
}
async function getUserTransactions(phone) {
    const res = await pool.query("SELECT * FROM transactions WHERE user_id = $1 ORDER BY timestamp DESC", [phone]);
    return res.rows;
}
async function saveActiveSelection(roundNumber, cartelaNumber, playerPhone) {
    await pool.query(`
        INSERT INTO active_round_selections (round_number, cartela_number, player_phone)
        VALUES ($1, $2, $3)
        ON CONFLICT (round_number, cartela_number) DO NOTHING
    `, [roundNumber, cartelaNumber, playerPhone]);
}
async function removeActiveSelection(roundNumber, cartelaNumber) {
    await pool.query(`
        DELETE FROM active_round_selections
        WHERE round_number = $1 AND cartela_number = $2
    `, [roundNumber, cartelaNumber]);
}
async function clearActiveSelectionsForRound(roundNumber) {
    await pool.query("DELETE FROM active_round_selections WHERE round_number = $1", [roundNumber]);
}
async function recoverActiveRound() {
    const res = await pool.query(`
        SELECT round_number, cartela_number, player_phone, u.username, u.balance
        FROM active_round_selections ars
        JOIN users u ON ars.player_phone = u.phone
        ORDER BY ars.selected_at
    `);
    if (res.rows.length === 0) return null;
    const roundNumber = res.rows[0].round_number;
    const selections = res.rows.map(r => ({
        cartelaNumber: r.cartela_number,
        playerPhone: r.player_phone,
        username: r.username,
        balance: r.balance
    }));
    return { roundNumber, selections };
}
async function linkTelegramUser(telegramUserId, phone) {
    await pool.query(`
        INSERT INTO telegram_links (telegram_user_id, phone, linked_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (telegram_user_id) DO UPDATE SET phone = EXCLUDED.phone, linked_at = CURRENT_TIMESTAMP
    `, [telegramUserId, phone]);
}
async function getPhoneByTelegramId(telegramUserId) {
    const res = await pool.query("SELECT phone FROM telegram_links WHERE telegram_user_id = $1", [telegramUserId]);
    return res.rows[0]?.phone;
}
async function savePendingLogin(phone, telegramUserId) {
    await pool.query(`
        INSERT INTO pending_logins (phone, telegram_user_id, requested_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (phone) DO UPDATE SET telegram_user_id = EXCLUDED.telegram_user_id, requested_at = CURRENT_TIMESTAMP
    `, [phone, telegramUserId]);
}

// ==================== CARTELA DATA ====================
const CARTELA_DATA_FILE = path.join(__dirname, "../../data/cartelas.json");
let cartelaData = {};
try {
    if (fs.existsSync(CARTELA_DATA_FILE)) {
        cartelaData = JSON.parse(fs.readFileSync(CARTELA_DATA_FILE, "utf8"));
        console.log(`✅ Loaded ${Object.keys(cartelaData).length} cartelas`);
    }
} catch (err) { console.log("⚠️ No cartela data file"); }
function saveCartelaData() {
    try { fs.writeFileSync(CARTELA_DATA_FILE, JSON.stringify(cartelaData, null, 2)); } catch (err) { console.error("Save cartela error:", err); }
}

// ==================== GAME CONSTANTS ====================
const SELECTION_TIME = parseInt(process.env.SELECTION_TIME) || 50;
const DRAW_INTERVAL = parseInt(process.env.DRAW_INTERVAL) || 4000;
const NEXT_ROUND_DELAY = parseInt(process.env.NEXT_ROUND_DELAY) || 6000;
const BET_AMOUNT = parseFloat(process.env.BET_AMOUNT) || 10;
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
let activeSessions = new Map();

// ==================== CRASH RECOVERY ====================
async function recoverFromCrash() {
    const recovery = await recoverActiveRound();
    if (!recovery) {
        console.log("No unfinished round found, starting fresh.");
        return;
    }
    console.log(`Recovering round ${recovery.roundNumber} with ${recovery.selections.length} selections`);
    gameState.round = recovery.roundNumber;
    gameState.status = "selection";
    gameState.timer = SELECTION_TIME;
    gameState.drawnNumbers = [];
    gameState.winners = [];
    gameState.gameActive = false;
    for (const sel of recovery.selections) {
        globalTakenCartelas.set(sel.cartelaNumber, { playerId: sel.playerPhone, playerName: sel.username, timestamp: Date.now() });
    }
    globalTotalSelectedCartelas = globalTakenCartelas.size;
    const { totalBetAmount, winnerReward } = calculateRewardPool();
    gameState.totalBet = totalBetAmount;
    gameState.winnerReward = winnerReward;
    gameState.adminCommission = totalBetAmount - winnerReward;
    console.log(`Recovered: ${globalTotalSelectedCartelas} cartelas, pool: ${gameState.totalBet} ETB`);
    startSelectionTimer();
}
setTimeout(() => recoverFromCrash(), 2000);

// ==================== MULTI-DEVICE HELPERS ====================
function broadcastToUserDevices(phone, event, data, excludeSocketId = null) {
    const sessions = activeSessions.get(phone);
    if (!sessions) return;
    for (const socketId of sessions) {
        if (socketId !== excludeSocketId) io.to(socketId).emit(event, data);
    }
}
async function syncPlayerState(phone, socketId) {
    const user = await getUser(phone);
    if (!user) return;
    let selectedCartelas = [];
    for (const [sid, p] of gameState.players) if (p.phone === phone) { selectedCartelas = p.selectedCartelas; break; }
    const playerData = { balance: user.balance, selectedCartelas, username: user.username, phone };
    broadcastToUserDevices(phone, "stateSync", playerData, socketId);
}

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
async function reserveCartela(cartelaNumber, playerId, playerName, playerPhone) {
    if (globalTakenCartelas.has(cartelaNumber)) return false;
    globalTakenCartelas.set(cartelaNumber, { playerId, playerName, timestamp: Date.now() });
    globalTotalSelectedCartelas = globalTakenCartelas.size;
    await saveActiveSelection(gameState.round, cartelaNumber, playerPhone);
    return true;
}
async function releaseCartela(cartelaNumber, playerId, playerPhone) {
    const cartela = globalTakenCartelas.get(cartelaNumber);
    if (cartela && cartela.playerId === playerId) {
        globalTakenCartelas.delete(cartelaNumber);
        globalTotalSelectedCartelas = globalTakenCartelas.size;
        await removeActiveSelection(gameState.round, cartelaNumber);
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
        socketId: p.socketId, username: p.username, phone: p.phone.slice(-6),
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

async function startActiveGame() {
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

async function endRound(winnerSocketIds, winnerDetails = []) {
    if (gameState.status !== "active") return;
    stopGame();
    gameState.status = "ended";
    gameState.winners = winnerSocketIds;
    gameState.roundEndTime = new Date();
    const winnerCount = winnerSocketIds.length;
    const perWinner = winnerCount ? gameState.winnerReward / winnerCount : 0;
    const winnerNames = [], winnerCartelas = [];
    for (let i = 0; i < winnerSocketIds.length; i++) {
        const sid = winnerSocketIds[i];
        const pl = gameState.players.get(sid);
        const det = winnerDetails.find(d => d.socketId === sid);
        if (pl) {
            pl.balance += perWinner;
            pl.totalWon = (pl.totalWon || 0) + perWinner;
            pl.gamesWon = (pl.gamesWon || 0) + 1;
            winnerNames.push(pl.username);
            if (det) winnerCartelas.push({ username: pl.username, cartelaId: det.cartelaId, winningLines: det.winningLines });
            io.to(sid).emit("youWon", { amount: perWinner, cartelaId: det?.cartelaId, winningLines: det?.winningLines, newBalance: pl.balance, message: `🎉 You won ${perWinner.toFixed(2)} ETB!` });
            await saveTransaction({
                userId: pl.phone, username: pl.username, type: "win", amount: perWinner,
                cartela: det?.cartelaId, round: gameState.round, note: "Round win"
            });
            await pool.query("UPDATE users SET balance = $1, total_won = total_won + $2, games_won = games_won + 1 WHERE phone = $3", [pl.balance, perWinner, pl.phone]);
        }
    }
    for (const [_, pl] of gameState.players) if (pl.selectedCartelas.length) pl.totalPlayed = (pl.totalPlayed || 0) + 1;
    await saveGameRound({
        roundNumber: gameState.round,
        totalPlayers: Array.from(gameState.players.values()).filter(p => p.selectedCartelas.length > 0).length,
        totalCartelas: globalTotalSelectedCartelas,
        totalPool: gameState.totalBet,
        winnerReward: gameState.winnerReward,
        adminCommission: gameState.adminCommission,
        winners: winnerNames,
        winnerCartelas: winnerCartelas,
        winPercentage: gameState.winPercentage,
        timestamp: new Date().toISOString()
    });
    io.emit("roundEnded", {
        winners: winnerNames, winnerCartelas, winnerCount, winnerReward: perWinner,
        totalPool: gameState.totalBet, adminCommission: gameState.adminCommission,
        winPercentage: gameState.winPercentage, round: gameState.round,
        message: winnerCount ? `🎉 BINGO! Winners: ${winnerNames.join(", ")}. Each wins ${perWinner.toFixed(2)} ETB!` : "No winners this round!"
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

async function resetForNextRound() {
    for (const [_, pl] of gameState.players) pl.selectedCartelas = [];
    globalTakenCartelas.clear();
    globalTotalSelectedCartelas = 0;
    await clearActiveSelectionsForRound(gameState.round);
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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

app.post("/api/admin/login", authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (email !== ADMIN_EMAIL) return res.status(401).json({ success: false, message: "Invalid credentials" });
    const isValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!isValid) return res.status(401).json({ success: false, message: "Invalid credentials" });
    const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "24h" });
    adminTokens.set(token, Date.now());
    res.json({ success: true, token });
});
app.post("/api/admin/change-password", verifyAdminToken, async (req, res) => {
    const { currentPassword, newPassword, token } = req.body;
    if (!adminTokens.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    const isValid = await bcrypt.compare(currentPassword, ADMIN_PASSWORD_HASH);
    if (!isValid) return res.status(401).json({ success: false, message: "Current password incorrect" });
    const newHash = await bcrypt.hash(newPassword, 10);
    process.env.ADMIN_PASSWORD_HASH = newHash;
    res.json({ success: true, message: "Password changed (until restart)" });
});
function verifyAdminToken(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token || !adminTokens.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    next();
}

// ==================== TELEGRAM OTP AUTHENTICATION (via Python Bot API) ====================
app.post("/api/player/send-otp", authLimiter, [
    body("phone").isMobilePhone().withMessage("Invalid phone number"),
    body("telegramUserId").isInt().withMessage("Valid Telegram user ID required")
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    
    const { phone, telegramUserId } = req.body;
    
    // Check if user already exists
    const existing = await getUser(phone);
    if (existing) {
        await linkTelegramUser(telegramUserId, phone);
        return res.json({ success: true, message: "Already registered. Please send /bingo to our Telegram bot to get your OTP code." });
    }
    
    // Save pending login request
    await savePendingLogin(phone, telegramUserId);
    
    // Call Python bot API to prepare OTP (optional - bot already handles /bingo)
    try {
        await fetch(`${BOT_API_URL}/api/request-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, telegramUserId })
        });
    } catch (error) {
        console.error("Error notifying bot API:", error);
        // Don't fail the request - user can still send /bingo manually
    }
    
    res.json({ success: true, message: "Please send /bingo to our Telegram bot to receive your OTP code." });
});

app.post("/api/player/verify-otp", authLimiter, [
    body("phone").isMobilePhone(),
    body("otp").isLength({ min: 6, max: 6 }).isNumeric(),
    body("telegramUserId").isInt()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    
    const { phone, otp, telegramUserId } = req.body;
    
    // Call Python bot API to verify OTP
    try {
        const response = await fetch(`${BOT_API_URL}/api/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegramUserId, otp })
        });
        
        const data = await response.json();
        
        if (!data.success) {
            return res.status(401).json({ success: false, message: data.message });
        }
        
        // Link Telegram ID to phone
        await linkTelegramUser(telegramUserId, phone);
        
        // Check if user exists
        const user = await getUser(phone);
        if (user) {
            return res.json({ success: true, approved: true, balance: user.balance, username: user.username });
        }
        
        // Check pending registration
        const pending = await getPendingRegistrations();
        if (pending.find(p => p.phone === phone)) {
            return res.json({ success: true, approved: false, message: "Registration pending admin approval" });
        }
        
        // Create pending registration
        await savePendingRegistration(phone, null);
        res.json({ success: true, approved: false, message: "Registration request sent to admin" });
        
    } catch (error) {
        console.error("Error calling bot API:", error);
        res.status(500).json({ success: false, message: "Verification service unavailable. Please try again." });
    }
});

// ==================== PHONE REGISTRATION & ADMIN APPROVAL ====================
app.post("/api/player/register", async (req, res) => {
    const { phone, socketId } = req.body;
    if (!phone || !phone.match(/^[0-9+\-\s()]{8,15}$/)) {
        return res.status(400).json({ success: false, message: "Invalid phone number" });
    }
    const existingUser = await getUser(phone);
    if (existingUser) {
        return res.json({ success: true, approved: true, balance: existingUser.balance, username: existingUser.username, message: "Already registered", existingUser: true });
    }
    const pendingList = await getPendingRegistrations();
    if (pendingList.find(p => p.phone === phone)) {
        return res.json({ success: true, approved: false, message: "Registration pending admin approval" });
    }
    await savePendingRegistration(phone, socketId);
    io.emit("newPendingRegistration", { phone, socketId });
    res.json({ success: true, approved: false, message: "Registration request sent to admin" });
});

app.get("/api/admin/pending-registrations", verifyAdminToken, async (req, res) => {
    const pending = await getPendingRegistrations();
    res.json({ success: true, pending });
});

app.post("/api/admin/approve-registration", verifyAdminToken, async (req, res) => {
    const { phone, socketId, username } = req.body;
    const pendingList = await getPendingRegistrations();
    if (!pendingList.find(p => p.phone === phone)) return res.status(404).json({ success: false, message: "No pending registration" });
    const newUser = {
        phone, username: username || `Player_${phone.slice(-4)}`, balance: 30,
        total_won: 0, total_played: 0, games_won: 0, total_manual_added: 0,
        registered_at: new Date().toISOString(), last_seen: new Date().toISOString()
    };
    await saveUser(newUser);
    await deletePendingRegistration(phone);
    if (socketId) io.to(socketId).emit("registrationApproved", { phone, balance: 30, username: newUser.username });
    res.json({ success: true, message: "Registration approved, player received 30 ETB" });
});

// ==================== BALANCE REQUESTS ====================
app.post("/api/player/request-balance", async (req, res) => {
    const { phone, amount, message } = req.body;
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const request = {
        id: Date.now(), phone, username: user.username, amount: amount || 100,
        message: message || "Balance request", status: "pending", requested_at: new Date().toISOString()
    };
    await saveBalanceRequest(request);
    io.emit("newBalanceRequest", request);
    res.json({ success: true, requestId: request.id });
});
app.get("/api/admin/balance-requests", verifyAdminToken, async (req, res) => {
    const pending = await getPendingBalanceRequests();
    res.json({ success: true, requests: pending });
});
app.post("/api/admin/approve-request", verifyAdminToken, async (req, res) => {
    const { requestId, amount } = req.body;
    const pending = await getPendingBalanceRequests();
    const request = pending.find(r => r.id == requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.status !== "pending") return res.status(400).json({ success: false, message: "Already processed" });
    const user = await getUser(request.phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const addAmount = amount || request.amount;
    const newBalance = user.balance + addAmount;
    await pool.query("UPDATE users SET balance = $1 WHERE phone = $2", [newBalance, request.phone]);
    await pool.query("UPDATE balance_requests SET status = 'approved', processed_at = CURRENT_TIMESTAMP WHERE id = $1", [requestId]);
    for (const [socketId, player] of gameState.players) {
        if (player.phone === request.phone) io.to(socketId).emit("balanceRequestApproved", { added: addAmount, newBalance });
    }
    res.json({ success: true, newBalance });
});

// ==================== ADMIN BALANCE MANAGEMENT ====================
app.post("/api/admin/add-balance", verifyAdminToken, async (req, res) => {
    const { phone, amount, note } = req.body;
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const newBalance = user.balance + amount;
    await pool.query("UPDATE users SET balance = $1, total_manual_added = total_manual_added + $2 WHERE phone = $3", [newBalance, amount, phone]);
    await saveTransaction({ userId: phone, username: user.username, type: "admin_add", amount, cartela: null, round: null, note: note || "Manual add" });
    for (const [socketId, player] of gameState.players) {
        if (player.phone === phone) {
            player.balance = newBalance;
            io.to(socketId).emit("balanceUpdated", { balance: newBalance, added: amount });
        }
    }
    broadcastToUserDevices(phone, "balanceUpdated", { balance: newBalance, added: amount });
    res.json({ success: true, newBalance });
});
app.post("/api/admin/remove-balance", verifyAdminToken, async (req, res) => {
    const { phone, amount, note } = req.body;
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.balance < amount) return res.status(400).json({ success: false, message: "Insufficient balance" });
    const newBalance = user.balance - amount;
    await pool.query("UPDATE users SET balance = $1 WHERE phone = $2", [newBalance, phone]);
    await saveTransaction({ userId: phone, username: user.username, type: "admin_remove", amount, cartela: null, round: null, note: note || "Manual removal" });
    for (const [socketId, player] of gameState.players) {
        if (player.phone === phone) {
            player.balance = newBalance;
            io.to(socketId).emit("balanceUpdated", { balance: newBalance, removed: amount });
        }
    }
    broadcastToUserDevices(phone, "balanceUpdated", { balance: newBalance, removed: amount });
    res.json({ success: true, newBalance });
});
app.get("/api/admin/players", verifyAdminToken, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const users = await pool.query("SELECT phone, username, balance, total_manual_added, registered_at FROM users ORDER BY registered_at DESC LIMIT $1 OFFSET $2", [limit, offset]);
    res.json({ success: true, players: users.rows, hasMore: users.rows.length === limit });
});
app.get("/api/admin/player/:phone", verifyAdminToken, async (req, res) => {
    const user = await getUser(req.params.phone);
    if (!user) return res.status(404).json({ success: false, message: "Player not found" });
    res.json({ success: true, player: user });
});
app.get("/api/admin/player-transactions/:phone", verifyAdminToken, async (req, res) => {
    const transactions = await getUserTransactions(req.params.phone);
    res.json({ success: true, transactions });
});

// ==================== GAME API ENDPOINTS ====================
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
app.post("/api/admin/reset-game", verifyAdminToken, async (req, res) => {
    stopGame();
    if (selectionTimer) clearInterval(selectionTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    await clearActiveSelectionsForRound(gameState.round);
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

// ==================== REPORT ENDPOINTS ====================
app.get("/api/reports/daily", verifyAdminToken, async (req, res) => {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const rounds = await pool.query("SELECT * FROM game_rounds WHERE DATE(timestamp) = $1 ORDER BY round_id DESC", [date]);
    const totalGames = rounds.rows.length;
    const totalBet = rounds.rows.reduce((s, r) => s + (r.total_pool || 0), 0);
    const totalWon = rounds.rows.reduce((s, r) => s + (r.winner_reward || 0), 0);
    const totalCommission = rounds.rows.reduce((s, r) => s + (r.admin_commission || 0), 0);
    res.json({ success: true, report: { date, totalGames, totalBet, totalWon, totalCommission, rounds: rounds.rows } });
});
app.get("/api/reports/weekly", verifyAdminToken, async (req, res) => {
    const { year, week } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetWeek = parseInt(week) || getWeekNumber(new Date());
    const rounds = await pool.query(`
        SELECT * FROM game_rounds 
        WHERE EXTRACT(YEAR FROM timestamp) = $1 AND EXTRACT(WEEK FROM timestamp) = $2 
        ORDER BY round_id DESC
    `, [targetYear, targetWeek]);
    const totalGames = rounds.rows.length;
    const totalBet = rounds.rows.reduce((s, r) => s + (r.total_pool || 0), 0);
    const totalWon = rounds.rows.reduce((s, r) => s + (r.winner_reward || 0), 0);
    const totalCommission = rounds.rows.reduce((s, r) => s + (r.admin_commission || 0), 0);
    res.json({ success: true, report: { year: targetYear, week: targetWeek, totalGames, totalBet, totalWon, totalCommission, rounds: rounds.rows } });
});
app.get("/api/reports/monthly", verifyAdminToken, async (req, res) => {
    const { year, month } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    const rounds = await pool.query(`
        SELECT * FROM game_rounds 
        WHERE EXTRACT(YEAR FROM timestamp) = $1 AND EXTRACT(MONTH FROM timestamp) = $2 
        ORDER BY round_id DESC
    `, [targetYear, targetMonth]);
    const totalGames = rounds.rows.length;
    const totalBet = rounds.rows.reduce((s, r) => s + (r.total_pool || 0), 0);
    const totalWon = rounds.rows.reduce((s, r) => s + (r.winner_reward || 0), 0);
    const totalCommission = rounds.rows.reduce((s, r) => s + (r.admin_commission || 0), 0);
    res.json({ success: true, report: { year: targetYear, month: targetMonth, totalGames, totalBet, totalWon, totalCommission, rounds: rounds.rows } });
});
app.get("/api/reports/range", verifyAdminToken, async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ success: false, message: "startDate and endDate required" });
    const rounds = await pool.query(`
        SELECT * FROM game_rounds WHERE DATE(timestamp) BETWEEN $1 AND $2 ORDER BY round_id DESC
    `, [startDate, endDate]);
    const totalGames = rounds.rows.length;
    const totalBet = rounds.rows.reduce((s, r) => s + (r.total_pool || 0), 0);
    const totalWon = rounds.rows.reduce((s, r) => s + (r.winner_reward || 0), 0);
    const totalCommission = rounds.rows.reduce((s, r) => s + (r.admin_commission || 0), 0);
    res.json({ success: true, report: { startDate, endDate, totalGames, totalBet, totalWon, totalCommission, rounds: rounds.rows } });
});
app.get("/api/reports/commission", verifyAdminToken, async (req, res) => {
    const rounds = await pool.query("SELECT round_id, timestamp, total_pool, winner_reward, admin_commission FROM game_rounds ORDER BY round_id DESC");
    const totalCommission = rounds.rows.reduce((s, r) => s + (r.admin_commission || 0), 0);
    const commissionByRound = rounds.rows.map(r => ({
        roundId: r.round_id, date: r.timestamp, totalPool: r.total_pool || 0,
        winnerReward: r.winner_reward || 0, adminCommission: r.admin_commission || 0,
        percentage: r.total_pool ? ((r.admin_commission / r.total_pool) * 100).toFixed(2) : "0"
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
    console.log(`🟢 New socket: ${socket.id}`);

    socket.on("setPhone", async (data) => {
        const { phone } = data;
        const user = await getUser(phone);
        if (!user) {
            socket.emit("error", { message: "Phone not approved yet. Wait for admin approval." });
            return;
        }
        if (!activeSessions.has(phone)) activeSessions.set(phone, new Set());
        activeSessions.get(phone).add(socket.id);
        let existingPlayer = null;
        for (const [sid, p] of gameState.players) if (p.phone === phone) { existingPlayer = p; break; }
        let playerData;
        if (existingPlayer) {
            playerData = { socketId: socket.id, phone: existingPlayer.phone, username: existingPlayer.username,
                selectedCartelas: existingPlayer.selectedCartelas, balance: existingPlayer.balance,
                totalWon: existingPlayer.totalWon, totalPlayed: existingPlayer.totalPlayed, gamesWon: existingPlayer.gamesWon, joinedAt: Date.now() };
            gameState.players.set(socket.id, playerData);
        } else {
            let savedSelections = [];
            for (const [cartela, { playerId }] of globalTakenCartelas.entries()) {
                if (playerId === phone) savedSelections.push(cartela);
            }
            playerData = { socketId: socket.id, phone: user.phone, username: user.username, selectedCartelas: savedSelections,
                balance: user.balance, totalWon: 0, totalPlayed: 0, gamesWon: 0, joinedAt: Date.now() };
            gameState.players.set(socket.id, playerData);
        }
        await pool.query("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE phone = $1", [phone]);
        socket.emit("registered", {
            socketId: socket.id, username: user.username, phone: user.phone.slice(-6), balance: playerData.balance,
            welcomeBonus: 0, gameState: { status: gameState.status, round: gameState.round, timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers, winPercentage: gameState.winPercentage }
        });
        socket.emit("gameState", { status: gameState.status, round: gameState.round, timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers, playersCount: gameState.players.size, winPercentage: gameState.winPercentage });
        socket.emit("timerUpdate", { seconds: gameState.timer, round: gameState.round, formatted: formatTime(gameState.timer) });
        const { totalBetAmount, winnerReward, totalCartelas } = calculateRewardPool();
        socket.emit("rewardPoolUpdate", { totalSelectedCartelas: totalCartelas, totalBetAmount, winnerReward,
            winPercentage: gameState.winPercentage, remainingCartelas: TOTAL_CARTELAS - totalCartelas });
        socket.emit("playerData", { selectedCartelas: playerData.selectedCartelas, balance: playerData.balance, username: playerData.username });
        io.emit("playersUpdate", { count: gameState.players.size, players: Array.from(gameState.players.values()).map(p => ({
            socketId: p.socketId, username: p.username, selectedCount: p.selectedCartelas.length,
            selectedCartelas: p.selectedCartelas, balance: p.balance
        })) });
        syncPlayerState(phone, socket.id);
    });

    socket.on("setUsername", (data) => {
        const player = gameState.players.get(socket.id);
        if (player && data.username?.trim()) {
            player.username = data.username.trim().substring(0, 20);
            pool.query("UPDATE users SET username = $1 WHERE phone = $2", [player.username, player.phone]).catch(console.error);
            socket.emit("usernameChanged", { username: player.username });
            broadcastGameState();
            broadcastToUserDevices(player.phone, "usernameChanged", { username: player.username }, socket.id);
        }
    });

    socket.on("selectCartela", async (data, callback) => {
        try {
            const player = gameState.players.get(socket.id);
            if (!player) throw new Error("Player not found");
            if (gameState.status !== "selection") throw new Error(`Cannot select now (${gameState.status})`);
            if (player.selectedCartelas.length >= MAX_CARTELAS) throw new Error(`Max ${MAX_CARTELAS} cartelas`);
            if (player.selectedCartelas.includes(data.cartelaNumber)) throw new Error("Already selected");
            if (player.balance < BET_AMOUNT) throw new Error(`Insufficient balance: ${player.balance} ETB`);
            if (!isCartelaAvailable(data.cartelaNumber)) {
                const takenBy = globalTakenCartelas.get(data.cartelaNumber);
                throw new Error(`❌ Cartela ${data.cartelaNumber} already taken by ${takenBy.playerName}!`);
            }
            const reserved = await reserveCartela(data.cartelaNumber, socket.id, player.username, player.phone);
            if (!reserved) throw new Error("Just taken by someone else");
            player.balance -= BET_AMOUNT;
            player.selectedCartelas.push(data.cartelaNumber);
            getCartelaGrid(data.cartelaNumber);
            await pool.query("UPDATE users SET balance = balance - $1 WHERE phone = $2", [BET_AMOUNT, player.phone]);
            await saveTransaction({ userId: player.phone, username: player.username, type: "bet", amount: BET_AMOUNT, cartela: data.cartelaNumber, round: gameState.round, note: "Cartela selection" });
            const selectionData = { cartela: data.cartelaNumber, selectedCount: player.selectedCartelas.length,
                selectedCartelas: player.selectedCartelas, balance: player.balance, remainingSlots: MAX_CARTELAS - player.selectedCartelas.length };
            socket.emit("selectionConfirmed", selectionData);
            broadcastToUserDevices(player.phone, "selectionConfirmed", selectionData, socket.id);
            broadcastRewardPool();
            io.emit("cartelaTaken", { cartelaNumber: data.cartelaNumber, takenBy: player.username,
                remainingCartelas: TOTAL_CARTELAS - globalTotalSelectedCartelas, totalSelected: globalTotalSelectedCartelas });
            broadcastGameState();
            io.emit("playersUpdate", { count: gameState.players.size, players: Array.from(gameState.players.values()).map(p => ({
                socketId: p.socketId, username: p.username, selectedCount: p.selectedCartelas.length,
                selectedCartelas: p.selectedCartelas, balance: p.balance
            })) });
            if (callback) callback({ success: true, newBalance: player.balance });
        } catch (err) {
            if (callback) callback({ success: false, error: err.message });
            else socket.emit("error", { message: err.message });
        }
    });

    socket.on("deselectCartela", async (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;
        if (gameState.status !== "selection") return socket.emit("error", { message: "Cannot deselect now" });
        const idx = player.selectedCartelas.indexOf(data.cartelaNumber);
        if (idx !== -1) {
            const released = await releaseCartela(data.cartelaNumber, socket.id, player.phone);
            if (released) {
                player.selectedCartelas.splice(idx, 1);
                player.balance += BET_AMOUNT;
                await pool.query("UPDATE users SET balance = balance + $1 WHERE phone = $2", [BET_AMOUNT, player.phone]);
                const updateData = { selectedCartelas: player.selectedCartelas, balance: player.balance };
                socket.emit("selectionUpdated", updateData);
                broadcastToUserDevices(player.phone, "selectionUpdated", updateData, socket.id);
                broadcastRewardPool();
                io.emit("cartelaReleased", { cartelaNumber: data.cartelaNumber, releasedBy: player.username,
                    availableCartelas: TOTAL_CARTELAS - globalTotalSelectedCartelas, totalSelected: globalTotalSelectedCartelas });
                broadcastGameState();
            }
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
        console.log(`🔴 Disconnected: ${socket.id}`);
        let phoneToRemove = null;
        for (const [phone, sessions] of activeSessions) {
            if (sessions.has(socket.id)) {
                sessions.delete(socket.id);
                if (sessions.size === 0) phoneToRemove = phone;
                break;
            }
        }
        if (phoneToRemove) activeSessions.delete(phoneToRemove);
        const player = gameState.players.get(socket.id);
        if (player) {
            const hasOtherSessions = activeSessions.has(player.phone);
            if (!hasOtherSessions) {
                for (const [cnum, cart] of globalTakenCartelas) if (cart.playerId === socket.id) globalTakenCartelas.delete(cnum);
                globalTotalSelectedCartelas = globalTakenCartelas.size;
                gameState.players.delete(socket.id);
            }
        }
        broadcastRewardPool();
        io.emit("playersUpdate", { count: gameState.players.size, players: Array.from(gameState.players.values()).map(p => ({
            socketId: p.socketId, username: p.username, selectedCount: p.selectedCartelas.length,
            selectedCartelas: p.selectedCartelas, balance: p.balance
        })) });
        broadcastGameState();
    });
});

// ==================== GRACEFUL SHUTDOWN ====================
async function gracefulShutdown() {
    console.log("🛑 Shutting down gracefully...");
    stopGame();
    if (selectionTimer) clearInterval(selectionTimer);
    if (nextRoundTimer) clearTimeout(nextRoundTimer);
    await clearActiveSelectionsForRound(gameState.round);
    for (const [cartela, { playerId }] of globalTakenCartelas) {
        await saveActiveSelection(gameState.round, cartela, playerId);
    }
    saveCartelaData();
    await pool.end();
    server.close(() => {
        console.log("✅ Server closed");
        process.exit(0);
    });
    setTimeout(() => {
        console.error("❌ Forced exit after timeout");
        process.exit(1);
    }, 10000);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
startSelectionTimer();
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║              🎲 ESTIF BINGO 24/7 - ENHANCED EDITION 🎲                    ║
║     📱 Player: https://estif-bingo-247.onrender.com/player.html           ║
║     🔐 Admin:  https://estif-bingo-247.onrender.com/admin.html            ║
║     ✅ Persistent game state (crash recovery)                             ║
║     ✅ Telegram OTP authentication (via Python bot)                       ║
║     ✅ Rate limiting & input validation                                   ║
║     ✅ Graceful shutdown                                                  ║
║                                                                           ║
║     📡 Python Bot API: ${BOT_API_URL}                                     ║
╚═══════════════════════════════════════════════════════════════════════════╝
    `);
});

module.exports = { app, server, io, gameState, globalTakenCartelas, globalTotalSelectedCartelas, activeSessions };