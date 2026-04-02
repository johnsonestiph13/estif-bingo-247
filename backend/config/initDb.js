const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
require("dotenv").config();

async function initDatabase() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || ''
    });

    const queries = [
        `CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME || 'estif_bingo_247'}`,
        `USE ${process.env.DB_NAME || 'estif_bingo_247'}`,
        
        // Users table
        `CREATE TABLE IF NOT EXISTS users (
            user_id INT PRIMARY KEY AUTO_INCREMENT,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            full_name VARCHAR(100),
            phone VARCHAR(20),
            balance DECIMAL(10,2) DEFAULT 0.00,
            total_won DECIMAL(10,2) DEFAULT 0.00,
            total_played INT DEFAULT 0,
            games_won INT DEFAULT 0,
            role ENUM('admin', 'player') DEFAULT 'player',
            is_active BOOLEAN DEFAULT TRUE,
            last_seen TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_email (email),
            INDEX idx_status (is_active)
        )`,
        
        // Game rounds (24/7 continuous)
        `CREATE TABLE IF NOT EXISTS game_rounds (
            round_id INT PRIMARY KEY AUTO_INCREMENT,
            round_number INT NOT NULL,
            status ENUM('selection', 'countdown', 'active', 'ended', 'waiting') DEFAULT 'waiting',
            start_time TIMESTAMP NULL,
            end_time TIMESTAMP NULL,
            winner_amount DECIMAL(10,2) DEFAULT 0,
            admin_commission DECIMAL(10,2) DEFAULT 0,
            total_players INT DEFAULT 0,
            total_bet DECIMAL(10,2) DEFAULT 0,
            winners JSON,
            drawn_numbers JSON,
            win_percentage INT DEFAULT 75,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_status (status),
            INDEX idx_round (round_number)
        )`,
        
        // Game participants
        `CREATE TABLE IF NOT EXISTS round_participants (
            participant_id INT PRIMARY KEY AUTO_INCREMENT,
            round_id INT NOT NULL,
            user_id INT NOT NULL,
            selected_cartelas JSON,
            bet_amount DECIMAL(10,2) DEFAULT 10,
            is_winner BOOLEAN DEFAULT FALSE,
            win_amount DECIMAL(10,2) DEFAULT 0,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (round_id) REFERENCES game_rounds(round_id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(user_id),
            INDEX idx_round_user (round_id, user_id)
        )`,
        
        // Transactions
        `CREATE TABLE IF NOT EXISTS transactions (
            transaction_id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            round_id INT,
            type ENUM('deposit', 'withdraw', 'bet', 'win', 'refund') NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            balance_before DECIMAL(10,2),
            balance_after DECIMAL(10,2),
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(user_id),
            INDEX idx_user (user_id),
            INDEX idx_created (created_at)
        )`,
        
        // Daily reports
        `CREATE TABLE IF NOT EXISTS daily_reports (
            report_id INT PRIMARY KEY AUTO_INCREMENT,
            report_date DATE UNIQUE NOT NULL,
            total_rounds INT DEFAULT 0,
            total_players INT DEFAULT 0,
            total_bet DECIMAL(10,2) DEFAULT 0,
            total_won DECIMAL(10,2) DEFAULT 0,
            total_commission DECIMAL(10,2) DEFAULT 0,
            report_data JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        
        // Insert default admin
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active) 
         VALUES (
             'admin',
             '${process.env.ADMIN_EMAIL || 'johnsonestiph13@gmail.com'}',
             '$2a$10$YourHashedPasswordHere',
             'System Administrator',
             'admin',
             TRUE
         ) ON DUPLICATE KEY UPDATE user_id = user_id`
    ];

    try {
        for (const query of queries) {
            await connection.query(query);
        }
        console.log('✅ Database initialized successfully');
        
        // Hash password for admin
        const hashedPassword = await bcrypt.hash('Jon@2127', 10);
        await connection.query(
            "UPDATE users SET password_hash = ? WHERE email = ?",
            [hashedPassword, process.env.ADMIN_EMAIL || 'johnsonestiph13@gmail.com']
        );
        console.log('✅ Admin password set');
        
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
    } finally {
        await connection.end();
    }
}

initDatabase();