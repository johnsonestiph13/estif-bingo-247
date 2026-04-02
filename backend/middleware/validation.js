const { body, validationResult } = require("express-validator");

// User registration validation
const validateRegistration = [
    body("username")
        .trim()
        .isLength({ min: 3, max: 50 })
        .withMessage("Username must be 3-50 characters")
        .matches(/^[a-zA-Z0-9_]+$/)
        .withMessage("Username can only contain letters, numbers, and underscores"),
    
    body("email")
        .trim()
        .isEmail()
        .withMessage("Valid email is required")
        .normalizeEmail(),
    
    body("password")
        .isLength({ min: 6 })
        .withMessage("Password must be at least 6 characters")
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage("Password must contain at least one letter and one number"),
    
    body("full_name")
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage("Name must be 2-100 characters"),
    
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    }
];

// Login validation
const validateLogin = [
    body("email")
        .trim()
        .notEmpty()
        .withMessage("Email or username is required"),
    
    body("password")
        .notEmpty()
        .withMessage("Password is required"),
    
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    }
];

// Cartela selection validation
const validateCartelaSelection = [
    body("cartelaNumber")
        .isInt({ min: 1, max: 400 })
        .withMessage("Cartela number must be between 1 and 400"),
    
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    }
];

// Balance update validation
const validateBalanceUpdate = [
    body("userId")
        .isInt()
        .withMessage("Valid user ID is required"),
    
    body("amount")
        .isFloat({ min: 0.01 })
        .withMessage("Amount must be greater than 0"),
    
    body("type")
        .isIn(["add", "deduct"])
        .withMessage("Type must be 'add' or 'deduct'"),
    
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    }
];

// Game creation validation
const validateGameCreation = [
    body("winPercentage")
        .optional()
        .isInt({ min: 50, max: 90 })
        .withMessage("Win percentage must be between 50 and 90"),
    
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    }
];

// Password change validation
const validatePasswordChange = [
    body("currentPassword")
        .notEmpty()
        .withMessage("Current password is required"),
    
    body("newPassword")
        .isLength({ min: 6 })
        .withMessage("New password must be at least 6 characters")
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage("New password must contain at least one letter and one number"),
    
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    }
];

module.exports = {
    validateRegistration,
    validateLogin,
    validateCartelaSelection,
    validateBalanceUpdate,
    validateGameCreation,
    validatePasswordChange
};