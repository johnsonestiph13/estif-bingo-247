// User model (database schema reference)
const UserModel = {
    tableName: "users",
    fields: {
        user_id: "SERIAL PRIMARY KEY",
        username: "VARCHAR(50) UNIQUE NOT NULL",
        email: "VARCHAR(100) UNIQUE NOT NULL",
        password_hash: "VARCHAR(255) NOT NULL",
        full_name: "VARCHAR(100)",
        phone: "VARCHAR(20)",
        balance: "DECIMAL(10,2) DEFAULT 0",
        total_won: "DECIMAL(10,2) DEFAULT 0",
        total_played: "INTEGER DEFAULT 0",
        games_won: "INTEGER DEFAULT 0",
        role: "VARCHAR(20) DEFAULT 'player'",
        is_active: "BOOLEAN DEFAULT TRUE",
        last_seen: "TIMESTAMP",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    
    // Validation rules
    validate: (userData) => {
        const errors = [];
        
        if (!userData.username || userData.username.length < 3) {
            errors.push("Username must be at least 3 characters");
        }
        
        if (!userData.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userData.email)) {
            errors.push("Valid email is required");
        }
        
        if (userData.password && userData.password.length < 6) {
            errors.push("Password must be at least 6 characters");
        }
        
        return errors;
    },
    
    // Sanitize user data (remove sensitive fields)
    sanitize: (user) => {
        const sanitized = { ...user };
        delete sanitized.password_hash;
        return sanitized;
    }
};

module.exports = UserModel;