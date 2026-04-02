// Generate random game code
function generateGameCode() {
    return 'ESTIF-' + Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Format currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'ETB'
    }).format(amount);
}

// Shuffle array
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

module.exports = { generateGameCode, formatCurrency, shuffleArray };