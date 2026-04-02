const fs = require("fs");
const path = require("path");

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "../../logs");
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Log levels
const LOG_LEVELS = {
    INFO: "INFO",
    WARN: "WARN",
    ERROR: "ERROR",
    DEBUG: "DEBUG"
};

// Get current timestamp
function getTimestamp() {
    return new Date().toISOString();
}

// Write to log file
function writeToFile(level, message, data = null) {
    const timestamp = getTimestamp();
    const logEntry = {
        timestamp,
        level,
        message,
        data
    };
    
    const logLine = JSON.stringify(logEntry) + "\n";
    const date = new Date().toISOString().split("T")[0];
    const logFile = path.join(logsDir, `${date}.log`);
    
    fs.appendFileSync(logFile, logLine);
}

// Console log with colors
function consoleLog(level, message, data = null) {
    const colors = {
        INFO: "\x1b[32m", // Green
        WARN: "\x1b[33m", // Yellow
        ERROR: "\x1b[31m", // Red
        DEBUG: "\x1b[36m"  // Cyan
    };
    
    const reset = "\x1b[0m";
    const color = colors[level] || "\x1b[37m";
    
    console.log(`${color}[${level}]${reset} ${getTimestamp()} - ${message}`);
    if (data) {
        console.log(data);
    }
}

// Logger class
class Logger {
    constructor(service = "general") {
        this.service = service;
    }
    
    info(message, data = null) {
        const msg = `[${this.service}] ${message}`;
        consoleLog(LOG_LEVELS.INFO, msg, data);
        writeToFile(LOG_LEVELS.INFO, msg, data);
    }
    
    warn(message, data = null) {
        const msg = `[${this.service}] ${message}`;
        consoleLog(LOG_LEVELS.WARN, msg, data);
        writeToFile(LOG_LEVELS.WARN, msg, data);
    }
    
    error(message, data = null) {
        const msg = `[${this.service}] ${message}`;
        consoleLog(LOG_LEVELS.ERROR, msg, data);
        writeToFile(LOG_LEVELS.ERROR, msg, data);
    }
    
    debug(message, data = null) {
        if (process.env.NODE_ENV !== "production") {
            const msg = `[${this.service}] ${message}`;
            consoleLog(LOG_LEVELS.DEBUG, msg, data);
            writeToFile(LOG_LEVELS.DEBUG, msg, data);
        }
    }
    
    logGameEvent(event, gameData) {
        this.info(`Game Event: ${event}`, gameData);
    }
    
    logPlayerAction(userId, action, details) {
        this.info(`Player Action: user=${userId}, action=${action}`, details);
    }
    
    logTransaction(userId, type, amount, result) {
        this.info(`Transaction: user=${userId}, type=${type}, amount=${amount}, result=${result}`);
    }
}

// Create default logger instance
const logger = new Logger("EstifBingo");

module.exports = { Logger, logger };