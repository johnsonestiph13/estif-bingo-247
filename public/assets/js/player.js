// Player main JavaScript for Estif Bingo

const SOCKET_URL = window.location.origin;
const token = storage.get('token');
let userId = null;
let socket = null;

// Game state
let currentGameState = {
    status: 'waiting',
    round: 0,
    timeLeft: 0,
    drawnNumbers: []
};

let playerState = {
    balance: 0,
    selectedCartelas: [],
    username: ''
};

let cartelaElements = [];

// Audio
const audioMap = {};
for (let i = 1; i <= 75; i++) {
    const audio = new Audio(`/assets/sounds/${i}.mp3`);
    audio.preload = 'auto';
    audioMap[i] = audio;
}
const winSound = new Audio('/assets/sounds/win.mp3');
const clickSound = new Audio('/assets/sounds/click.mp3');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    initializeSocket();
    createCartelaGrid();
    setupEventListeners();
});

// Check authentication
function checkAuth() {
    if (!token) {
        window.location.href = '/login.html';
        return;
    }
    
    try {
        const tokenData = JSON.parse(atob(token.split('.')[1]));
        userId = tokenData.userId;
    } catch (e) {
        window.location.href = '/login.html';
    }
}

// Initialize socket
function initializeSocket() {
    socket = io(SOCKET_URL, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });
    
    socket.on('connect', () => {
        console.log('Connected to server');
        showToast('Connected to game server!', 'success');
        socket.emit('register', { userId, token });
    });
    
    socket.on('registered', (data) => {
        playerState.balance = data.balance;
        playerState.username = data.username;
        updateBalanceDisplay();
        updateTimerDisplay(data.timeLeft);
        updateStatusDisplay();
    });
    
    socket.on('currentGameState', (state) => {
        currentGameState = state;
        updateTimerDisplay(state.timeLeft);
        updateStatusDisplay();
        updateCalledNumbers(state.drawnNumbers || []);
    });
    
    socket.on('gameStateUpdate', (state) => {
        currentGameState.status = state.status;
        currentGameState.round = state.round;
        currentGameState.drawnNumbers = state.drawnNumbers || [];
        updateStatusDisplay();
        updateCalledNumbers(currentGameState.drawnNumbers);
    });
    
    socket.on('selectionTimeLeft', (data) => {
        updateTimerDisplay(data.seconds);
        if (data.seconds <= 10) {
            document.getElementById('timerDisplay').classList.add('urgent');
        } else {
            document.getElementById('timerDisplay').classList.remove('urgent');
        }
    });
    
    socket.on('numberDrawn', (data) => {
        playSound(data.number);
        addCalledNumber(data.number);
    });
    
    socket.on('selectionConfirmed', (data) => {
        playerState.balance = data.remainingBalance;
        updateBalanceDisplay();
        updateSelectedCount(data.selectedCount);
        showToast(`Cartela ${data.cartela} selected!`, 'success');
        updateCartelaHighlight(data.cartela, true);
        playClickSound();
    });
    
    socket.on('selectionUpdated', (data) => {
        playerState.selectedCartelas = data.selectedCartelas;
        playerState.balance = data.balance;
        updateBalanceDisplay();
        updateSelectedDisplay();
        refreshCartelaHighlights();
    });
    
    socket.on('roundEnded', (data) => {
        showWinnerAnnouncement(data);
        playWinSound();
        playerState.selectedCartelas = [];
        updateSelectedDisplay();
        refreshCartelaHighlights();
    });
    
    socket.on('nextRoundCountdown', (data) => {
        showToast(`Next round starts in ${data.seconds} seconds!`, 'warning');
    });
    
    socket.on('playerStatus', (data) => {
        playerState.balance = data.balance;
        playerState.selectedCartelas = data.selectedCartelas;
        updateBalanceDisplay();
        updateSelectedDisplay();
        refreshCartelaHighlights();
        updateTimerDisplay(data.timeLeft);
    });
    
    socket.on('error', (message) => {
        showToast(message, 'error');
    });
    
    socket.on('disconnect', () => {
        showToast('Disconnected from server. Reconnecting...', 'error');
    });
}

// Create cartela grid
function createCartelaGrid() {
    const grid = document.getElementById('cartelaGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    cartelaElements = [];
    
    for (let i = 1; i <= 400; i++) {
        const cell = document.createElement('div');
        cell.className = 'cartela-item';
        cell.textContent = i;
        cell.dataset.number = i;
        cell.onclick = () => selectCartela(i);
        grid.appendChild(cell);
        cartelaElements.push(cell);
    }
}

// Select cartela
function selectCartela(number) {
    if (currentGameState.status !== 'selection') {
        showToast(`Cannot select now. Game status: ${currentGameState.status}`, 'error');
        return;
    }
    
    if (playerState.selectedCartelas.includes(number)) {
        socket.emit('deselectCartela', { cartelaNumber: number });
    } else {
        if (playerState.selectedCartelas.length >= 2) {
            showToast('Maximum 2 cartelas allowed!', 'error');
            return;
        }
        socket.emit('selectCartela', { cartelaNumber: number });
    }
}

// Update cartela highlight
function updateCartelaHighlight(number, isSelected) {
    const cell = cartelaElements.find(c => parseInt(c.dataset.number) === number);
    if (cell) {
        if (isSelected) {
            cell.classList.add('selected');
        } else {
            cell.classList.remove('selected');
        }
    }
}

// Refresh all cartela highlights
function refreshCartelaHighlights() {
    cartelaElements.forEach(cell => {
        const num = parseInt(cell.dataset.number);
        if (playerState.selectedCartelas.includes(num)) {
            cell.classList.add('selected');
        } else {
            cell.classList.remove('selected');
        }
    });
}

// Update selected display
function updateSelectedDisplay() {
    const container = document.getElementById('selectedCartelasList');
    if (!container) return;
    
    if (playerState.selectedCartelas.length === 0) {
        container.innerHTML = '<div style="text-align:center; opacity:0.7;">No cartelas selected</div>';
        return;
    }
    
    container.innerHTML = '';
    playerState.selectedCartelas.forEach(cartela => {
        const card = document.createElement('div');
        card.className = 'selected-card';
        card.innerHTML = `
            <div class="selected-number">#${cartela}</div>
            <button class="remove-btn" onclick="deselectCartela(${cartela})">✗</button>
        `;
        container.appendChild(card);
    });
}

// Deselect cartela (global for onclick)
function deselectCartela(number) {
    if (currentGameState.status !== 'selection') {
        showToast('Cannot deselect now', 'error');
        return;
    }
    socket.emit('deselectCartela', { cartelaNumber: number });
}

// Update timer display
function updateTimerDisplay(seconds) {
    const timerEl = document.getElementById('timerDisplay');
    if (!timerEl) return;
    
    if (seconds === undefined || seconds === null) {
        timerEl.textContent = '--:--';
        return;
    }
    
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    timerEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Update status display
function updateStatusDisplay() {
    const statusEl = document.getElementById('statusDisplay');
    const roundEl = document.getElementById('roundDisplay');
    const cartelaSection = document.getElementById('cartelaSection');
    const selectedSection = document.getElementById('selectedSection');
    
    const statusMap = {
        'waiting': { text: '⏳ Waiting for next round', class: 'waiting', showCartela: true },
        'selection': { text: '🎲 SELECT CARTELAS', class: 'selection', showCartela: true },
        'active': { text: '🎯 GAME IN PROGRESS', class: 'active', showCartela: false },
        'ended': { text: '🏆 ROUND ENDED', class: 'ended', showCartela: true }
    };
    
    const status = statusMap[currentGameState.status] || statusMap.waiting;
    
    if (statusEl) {
        statusEl.textContent = status.text;
        statusEl.className = `status-badge ${status.class}`;
    }
    
    if (roundEl && currentGameState.round) {
        roundEl.textContent = `Round ${currentGameState.round}`;
    }
    
    // Show/hide sections
    if (cartelaSection) {
        cartelaSection.style.display = status.showCartela ? 'block' : 'none';
    }
    if (selectedSection) {
        selectedSection.style.display = status.showCartela ? 'none' : 'block';
    }
    
    // Enable/disable cartela selection
    if (cartelaElements.length) {
        const enable = currentGameState.status === 'selection';
        cartelaElements.forEach(cell => {
            if (enable) {
                cell.classList.remove('disabled');
            } else {
                cell.classList.add('disabled');
            }
        });
    }
}

// Update called numbers
function updateCalledNumbers(numbers) {
    const container = document.getElementById('calledNumbers');
    if (!container) return;
    
    container.innerHTML = '';
    numbers.forEach(number => {
        const ball = document.createElement('div');
        ball.className = 'called-ball';
        ball.textContent = number;
        container.appendChild(ball);
    });
}

// Add single called number
function addCalledNumber(number) {
    const container = document.getElementById('calledNumbers');
    if (!container) return;
    
    const ball = document.createElement('div');
    ball.className = 'called-ball';
    ball.textContent = number;
    ball.style.animation = 'popIn 0.3s ease-out';
    container.appendChild(ball);
    container.scrollTop = container.scrollHeight;
    
    // Keep only last 30 numbers
    while (container.children.length > 30) {
        container.removeChild(container.firstChild);
    }
}

// Update balance display
function updateBalanceDisplay() {
    const balanceEl = document.getElementById('balanceAmount');
    const balanceDisplay = document.getElementById('balanceDisplay');
    
    if (balanceEl) {
        balanceEl.textContent = playerState.balance.toFixed(2);
        if (playerState.balance < 10) {
            balanceEl.style.color = '#ff9800';
        } else {
            balanceEl.style.color = '#f5c542';
        }
    }
    if (balanceDisplay) {
        balanceDisplay.textContent = playerState.balance.toFixed(2);
    }
}

// Update selected count
function updateSelectedCount(count) {
    const countEl = document.getElementById('selectedCount');
    if (countEl) {
        countEl.textContent = `${count}/2`;
    }
}

// Show winner announcement
function showWinnerAnnouncement(data) {
    const overlay = document.createElement('div');
    overlay.className = 'winner-overlay';
    overlay.innerHTML = `
        <div class="winner-card">
            <div class="winner-title">🎉 BINGO! 🎉</div>
            <div class="winner-names">🏆 ${data.winnerNames || 'No winners'}</div>
            <div class="winner-reward">💰 ${data.winnerReward.toFixed(2)} ETB each</div>
            <div class="next-round-info">⏳ Next round starts in ${data.nextRoundIn} seconds...</div>
        </div>
    `;
    document.body.appendChild(overlay);
    
    setTimeout(() => {
        overlay.style.animation = 'fadeIn 0.3s reverse';
        setTimeout(() => overlay.remove(), 300);
    }, 5000);
}

// Play sound
function playSound(number) {
    const audio = audioMap[number];
    if (audio) {
        audio.currentTime = 0;
        audio.play().catch(e => console.log('Audio error:', e));
    }
}

// Play win sound
function playWinSound() {
    winSound.currentTime = 0;
    winSound.play().catch(e => console.log('Win sound error:', e));
}

// Play click sound
function playClickSound() {
    clickSound.currentTime = 0;
    clickSound.play().catch(e => console.log('Click sound error:', e));
}

// Setup event listeners
function setupEventListeners() {
    // Auto-refresh player status every 5 seconds
    setInterval(() => {
        if (socket && socket.connected) {
            socket.emit('getStatus');
        }
    }, 5000);
}

// Expose for global access
window.deselectCartela = deselectCartela;
window.selectCartela = selectCartela;