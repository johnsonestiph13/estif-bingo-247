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
    message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, "../public")));
app.use('/assets', express.static(path.join(__dirname, "../public/assets")));

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date() });
});

// Simple test route
app.get("/api/test", (req, res) => {
    res.json({ message: "Estif Bingo API is running!" });
});

// API Routes (basic for now, expand as needed)
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    // Simple response for testing - expand with actual auth later
    res.json({ message: "Login endpoint - implement authentication" });
});

app.get("/api/games/current", async (req, res) => {
    res.json({ status: "waiting", message: "Game system active" });
});

// Socket.IO connection
io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    
    socket.on("register", (data) => {
        console.log("Client registered:", socket.id, data);
        socket.emit("registered", { status: "ok", message: "Connected to Estif Bingo" });
    });
    
    socket.on("joinGame", (gameCode) => {
        console.log(`Client ${socket.id} joining game: ${gameCode}`);
        socket.join(`game_${gameCode}`);
        socket.emit("gameState", { status: "waiting", message: "Joined game successfully" });
    });
    
    socket.on("selectCartela", (data) => {
        console.log(`Client ${socket.id} selected cartela:`, data);
        socket.emit("selectionConfirmed", { message: "Cartela selected (demo mode)" });
    });
    
    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: "Something went wrong!" });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        const db = await initializeDatabase();
        if (!db) {
            console.warn("⚠️ Running without database - some features may not work");
            console.log("💡 To fix: Add a PostgreSQL database on Render and set DATABASE_URL");
        }
        
        server.listen(PORT, () => {
            console.log(`🚀 Estif Bingo server running on port ${PORT}`);
            console.log(`📱 Player URL: http://localhost:${PORT}/player.html`);
            console.log(`🔐 Admin URL: http://localhost:${PORT}/admin.html`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        });
    } catch (error) {
        console.error("❌ Failed to start server:", error);
        process.exit(1);
    }
}

startServer();

module.exports = { app, server, io };