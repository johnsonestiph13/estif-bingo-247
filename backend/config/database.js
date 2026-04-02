const mysql = require("mysql2/promise");
require("dotenv").config();

let pool = null;

async function initializeDatabase() {
    try {
        pool = await mysql.createPool({
            host: process.env.DB_HOST || "localhost",
            user: process.env.DB_USER || "root",
            password: process.env.DB_PASSWORD || "",
            database: process.env.DB_NAME || "estif_bingo_247",
            waitForConnections: true,
            connectionLimit: 20,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0
        });
        
        console.log("✅ Database connected");
        return pool;
    } catch (error) {
        console.error("❌ Database connection failed:", error);
        throw error;
    }
}

module.exports = { pool: () => pool, initializeDatabase };