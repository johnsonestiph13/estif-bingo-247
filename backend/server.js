const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Database connection (optional - won't crash if missing)
let db = null;
if (process.env.DATABASE_URL) {
    db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log("✅ Database connected");
} else {
    console.log("⚠️ No DATABASE_URL set, running without database");
}

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date() });
});

// Serve player page
app.get("/player", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/player.html"));
});

// Serve admin page
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/admin.html"));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Estif Bingo running on port ${PORT}`);
    console.log(`📱 Player: https://estif-bingo-247.onrender.com/player.html`);
    console.log(`🔐 Admin: https://estif-bingo-247.onrender.com/admin.html`);
});