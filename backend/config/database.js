cat > backend/config/database.js << 'EOF'
const { Pool } = require("pg");

let pool = null;

async function initializeDatabase() {
    try {
        // Use DATABASE_URL from Render's PostgreSQL
        const connectionString = process.env.DATABASE_URL;
        
        if (!connectionString) {
            console.error("❌ DATABASE_URL environment variable not set");
            console.log("Please add a PostgreSQL database on Render and set DATABASE_URL");
            return null;
        }
        
        console.log("📡 Connecting to PostgreSQL...");
        
        pool = new Pool({
            connectionString: connectionString,
            ssl: { rejectUnauthorized: false },
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        
        // Test connection
        const client = await pool.connect();
        console.log("✅ PostgreSQL connected successfully");
        client.release();
        
        // Create tables if they don't exist
        await createTables();
        
        return pool;
    } catch (error) {
        console.error("❌ Database connection failed:", error.message);
        return null;
    }
}

async function createTables() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(100),
                phone VARCHAR(20),
                balance DECIMAL(10,2) DEFAULT 0,
                total_won DECIMAL(10,2) DEFAULT 0,
                total_played INTEGER DEFAULT 0,
                games_won INTEGER DEFAULT 0,
                role VARCHAR(20) DEFAULT 'player',
                is_active BOOLEAN DEFAULT TRUE,
                last_seen TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS game_rounds (
                round_id SERIAL PRIMARY KEY,
                round_number INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'waiting',
                start_time TIMESTAMP,
                end_time TIMESTAMP,
                winner_amount DECIMAL(10,2) DEFAULT 0,
                admin_commission DECIMAL(10,2) DEFAULT 0,
                total_players INTEGER DEFAULT 0,
                total_bet DECIMAL(10,2) DEFAULT 0,
                winners JSONB,
                drawn_numbers JSONB,
                win_percentage INTEGER DEFAULT 75,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS round_participants (
                participant_id SERIAL PRIMARY KEY,
                round_id INTEGER REFERENCES game_rounds(round_id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
                selected_cartelas JSONB,
                bet_amount DECIMAL(10,2) DEFAULT 10,
                is_winner BOOLEAN DEFAULT FALSE,
                win_amount DECIMAL(10,2) DEFAULT 0,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS transactions (
                transaction_id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
                round_id INTEGER REFERENCES game_rounds(round_id) ON DELETE SET NULL,
                type VARCHAR(20) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                balance_before DECIMAL(10,2),
                balance_after DECIMAL(10,2),
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database tables ready");
    } catch (error) {
        console.error("❌ Table creation error:", error.message);
    } finally {
        client.release();
    }
}

module.exports = { pool: () => pool, initializeDatabase };
EOF