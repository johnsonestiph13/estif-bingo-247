const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const path = require("path");
require("dotenv").config();

const { initializeDatabase } = require("./config/database");
const { socketHandler } = require("./socket/socketHandler");
const authRoutes = require("./routes/authRoutes");
const gameRoutes = require("./routes/gameRoutes");
const adminRoutes = require("./routes/adminRoutes");
const reportRoutes = require("./routes/reportRoutes");
const balanceRoutes = require("./routes/balanceRoutes");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Too many requests'
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, "../public")));
app.use('/assets', express.static(path.join(__dirname, "../public/assets")));

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/balance", balanceRoutes);

// Health check
app.get("/health", (req, res) => {
    res.json({ 
        status: "OK", 
        timestamp: new Date(),
        uptime: process.uptime()
    });
});

// Socket.IO handler
socketHandler(io);

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: "Something went wrong!" });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    await initializeDatabase();
    
    server.listen(PORT, () => {
        console.log(`🚀 Estif Bingo 24/7 running on port ${PORT}`);
        console.log(`📱 Player URL: http://localhost:${PORT}/player.html`);
        console.log(`🔐 Admin URL: http://localhost:${PORT}/admin.html`);
        console.log(`🎲 Game runs continuously 24/7`);
    });
}

startServer();

module.exports = { app, server, io };