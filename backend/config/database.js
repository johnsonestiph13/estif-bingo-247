const { Pool } = require("pg");

let pool = null;

async function initializeDatabase() {
    try {
        const connectionString = process.env.DATABASE_URL || 
            `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
        
        pool = new Pool({
            connectionString: connectionString,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 20,
            idleTimeoutMillis: 30000,
        });
        
        const client = await pool.connect();
        console.log("✅ PostgreSQL database connected");
        client.release();
        
        return pool;
    } catch (error) {
        console.error("❌ Database connection failed:", error);
        throw error;
    }
}

module.exports = { pool: () => pool, initializeDatabase };