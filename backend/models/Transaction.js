// Transaction model
const TransactionModel = {
    tableName: "transactions",
    fields: {
        transaction_id: "SERIAL PRIMARY KEY",
        user_id: "INTEGER REFERENCES users(user_id)",
        round_id: "INTEGER REFERENCES game_rounds(round_id)",
        type: "VARCHAR(20) NOT NULL",
        amount: "DECIMAL(10,2) NOT NULL",
        balance_before: "DECIMAL(10,2)",
        balance_after: "DECIMAL(10,2)",
        description: "TEXT",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    
    // Transaction types
    types: {
        DEPOSIT: "deposit",
        WITHDRAW: "withdraw",
        BET: "bet",
        WIN: "win",
        REFUND: "refund"
    },
    
    // Validate transaction
    validate: (transaction) => {
        const errors = [];
        
        if (!transaction.user_id) {
            errors.push("User ID is required");
        }
        
        if (!transaction.type || !Object.values(TransactionModel.types).includes(transaction.type)) {
            errors.push("Valid transaction type is required");
        }
        
        if (!transaction.amount || transaction.amount <= 0) {
            errors.push("Amount must be greater than 0");
        }
        
        return errors;
    }
};

module.exports = TransactionModel;