// Admin Dashboard JavaScript for Estif Bingo

const token = storage.get('token');
let currentGameCode = null;
let socket = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    initializeSocket();
    loadDashboard();
    setupEventListeners();
});

// Check authentication
async function checkAuth() {
    if (!token) {
        window.location.href = '/login.html';
        return;
    }
    
    try {
        const response = await fetch('/api/auth/verify', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) {
            localStorage.removeItem('token');
            window.location.href = '/login.html';
        }
    } catch (error) {
        console.error('Auth check error:', error);
    }
}

// Initialize Socket.IO for real-time updates
function initializeSocket() {
    socket = io(window.location.origin, {
        auth: { token },
        transports: ['websocket', 'polling']
    });
    
    socket.on('connect', () => {
        console.log('Admin socket connected');
        socket.emit('registerAdmin', { token });
    });
    
    socket.on('gameStateUpdate', (data) => {
        updateGameStats(data);
    });
    
    socket.on('playerJoined', (data) => {
        showToast(`${data.username} joined the game!`, 'info');
        updatePlayerCount(data.playerCount);
    });
    
    socket.on('roundEnded', (data) => {
        showToast(`Round ${data.roundNumber} ended! Winners: ${data.winnerNames || 'None'}`, 'info');
        loadDashboard();
    });
    
    socket.on('error', (message) => {
        showToast(message, 'error');
    });
}

// Load dashboard data
async function loadDashboard() {
    showLoading();
    try {
        await Promise.all([
            loadStats(),
            loadRecentRounds(),
            loadActiveGameInfo()
        ]);
    } catch (error) {
        console.error('Error loading dashboard:', error);
        showToast('Error loading dashboard data', 'error');
    } finally {
        hideLoading();
    }
}

// Load statistics
async function loadStats() {
    try {
        const response = await fetch('/api/admin/stats', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        document.getElementById('totalRounds').textContent = data.totalRounds || 0;
        document.getElementById('totalPlayers').textContent = data.totalPlayers || 0;
        document.getElementById('totalBet').textContent = `${(data.totalBet || 0).toFixed(2)} ETB`;
        document.getElementById('totalWon').textContent = `${(data.totalWon || 0).toFixed(2)} ETB`;
        document.getElementById('totalCommission').textContent = `${(data.totalCommission || 0).toFixed(2)} ETB`;
        document.getElementById('onlinePlayers').textContent = data.onlinePlayers || 0;
        
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Load recent rounds
async function loadRecentRounds() {
    try {
        const response = await fetch('/api/admin/recent-rounds?limit=10', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const rounds = await response.json();
        
        const tbody = document.querySelector('#recentRoundsTable tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        rounds.forEach(round => {
            const row = tbody.insertRow();
            row.insertCell(0).textContent = round.round_number;
            row.insertCell(1).textContent = formatDate(round.created_at, true);
            row.insertCell(2).textContent = round.total_players || 0;
            row.insertCell(3).textContent = `${(round.total_bet || 0).toFixed(2)} ETB`;
            row.insertCell(4).textContent = round.winners ? JSON.parse(round.winners).join(', ') : '-';
            row.insertCell(5).innerHTML = `<span class="status-badge ${round.status}">${round.status}</span>`;
        });
    } catch (error) {
        console.error('Error loading recent rounds:', error);
    }
}

// Load active game info
async function loadActiveGameInfo() {
    try {
        const response = await fetch('/api/games/current', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const game = await response.json();
        
        if (game.gameCode) {
            currentGameCode = game.gameCode;
            document.getElementById('gameCode').textContent = currentGameCode;
            document.getElementById('gameStatusDisplay').textContent = game.status || 'waiting';
            document.getElementById('gameTimerDisplay').textContent = game.timeLeft || 0;
            document.getElementById('joinedPlayers').textContent = game.playerCount || 0;
        }
    } catch (error) {
        console.error('Error loading active game:', error);
    }
}

// Update game stats via socket
function updateGameStats(data) {
    if (data.playerCount !== undefined) {
        document.getElementById('joinedPlayers').textContent = data.playerCount;
    }
    if (data.status) {
        document.getElementById('gameStatusDisplay').textContent = data.status;
    }
    if (data.timeLeft !== undefined) {
        document.getElementById('gameTimerDisplay').textContent = data.timeLeft;
    }
}

// Update player count
function updatePlayerCount(count) {
    const playerCountEl = document.getElementById('joinedPlayers');
    if (playerCountEl) {
        playerCountEl.textContent = count;
    }
}

// Create new game
async function createGame() {
    const winPercentage = document.getElementById('winPercentage')?.value || 75;
    
    showLoading();
    try {
        const response = await fetch('/api/admin/create-game', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ winPercentage: parseInt(winPercentage) })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentGameCode = data.gameCode;
            document.getElementById('gameCode').textContent = currentGameCode;
            document.getElementById('activeGameInfo').style.display = 'block';
            showToast(`Game created! Code: ${currentGameCode}`, 'success');
            
            // Auto-start countdown
            startGameCountdown();
        } else {
            showToast(data.message || 'Failed to create game', 'error');
        }
    } catch (error) {
        console.error('Error creating game:', error);
        showToast('Error creating game', 'error');
    } finally {
        hideLoading();
    }
}

// Start game countdown
function startGameCountdown() {
    if (socket && currentGameCode) {
        socket.emit('startGame', { gameCode: currentGameCode });
        showToast('Game countdown started!', 'success');
    }
}

// Copy game code
async function copyGameCode() {
    if (currentGameCode) {
        await copyToClipboard(currentGameCode);
        showToast('Game code copied! Share with players.', 'success');
    }
}

// Load players
async function loadPlayers() {
    showLoading();
    try {
        const response = await fetch('/api/admin/players', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const players = await response.json();
        
        const tbody = document.querySelector('#playersTable tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        players.forEach(player => {
            const row = tbody.insertRow();
            row.insertCell(0).textContent = player.user_id;
            row.insertCell(1).textContent = player.username;
            row.insertCell(2).textContent = player.email;
            row.insertCell(3).textContent = `${(player.balance || 0).toFixed(2)} ETB`;
            row.insertCell(4).textContent = `${(player.total_won || 0).toFixed(2)} ETB`;
            row.insertCell(5).innerHTML = player.is_active 
                ? '<span class="status-active">Active</span>' 
                : '<span class="status-inactive">Disabled</span>';
            row.insertCell(6).innerHTML = `
                <button class="btn-success" onclick="adjustBalance(${player.user_id})" title="Adjust Balance">💰</button>
                <button class="btn-danger" onclick="togglePlayerStatus(${player.user_id}, ${!player.is_active})" title="${player.is_active ? 'Disable' : 'Enable'}">
                    ${player.is_active ? '🔴' : '🟢'}
                </button>
                <button class="btn-primary" onclick="viewPlayerHistory(${player.user_id})" title="View History">📋</button>
            `;
        });
    } catch (error) {
        console.error('Error loading players:', error);
        showToast('Error loading players', 'error');
    } finally {
        hideLoading();
    }
}

// Adjust player balance
async function adjustBalance(userId) {
    const amount = prompt('Enter amount (ETB):');
    if (!amount || isNaN(amount)) return;
    
    const action = confirm('Add to balance? Click OK for ADD, Cancel for DEDUCT');
    const type = action ? 'add' : 'deduct';
    const description = prompt('Description (optional):', 'Admin adjustment');
    
    showLoading();
    try {
        const response = await fetch('/api/admin/update-balance', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                userId,
                amount: parseFloat(amount),
                type,
                description: description || 'Admin adjustment'
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast(`Balance updated! New balance: ${data.newBalance.toFixed(2)} ETB`, 'success');
            loadPlayers();
        } else {
            showToast(data.message || 'Failed to update balance', 'error');
        }
    } catch (error) {
        console.error('Error updating balance:', error);
        showToast('Error updating balance', 'error');
    } finally {
        hideLoading();
    }
}

// Toggle player status
async function togglePlayerStatus(userId, isActive) {
    const action = isActive ? 'enable' : 'disable';
    if (!confirm(`Are you sure you want to ${action} this player?`)) return;
    
    showLoading();
    try {
        const response = await fetch('/api/admin/toggle-player', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ userId, isActive })
        });
        
        if (response.ok) {
            showToast(`Player ${isActive ? 'enabled' : 'disabled'} successfully`, 'success');
            loadPlayers();
        } else {
            const data = await response.json();
            showToast(data.message || 'Failed to toggle status', 'error');
        }
    } catch (error) {
        console.error('Error toggling player:', error);
        showToast('Error toggling player status', 'error');
    } finally {
        hideLoading();
    }
}

// View player history
async function viewPlayerHistory(userId) {
    showLoading();
    try {
        const response = await fetch(`/api/games/my-history?userId=${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        const historyHtml = data.history.map(h => `
            <div class="history-item">
                <div>Round #${h.round_number}</div>
                <div>Bet: ${h.bet_amount} ETB</div>
                <div>${h.is_winner ? `Won: ${h.win_amount} ETB 🎉` : 'Lost'}</div>
                <div>${formatDate(h.joined_at)}</div>
            </div>
        `).join('');
        
        showModal('Player History', historyHtml || 'No history found');
    } catch (error) {
        console.error('Error loading player history:', error);
        showToast('Error loading player history', 'error');
    } finally {
        hideLoading();
    }
}

// Create new player
async function createPlayer() {
    const playerData = {
        username: document.getElementById('playerUsername').value,
        email: document.getElementById('playerEmail').value,
        full_name: document.getElementById('playerFullName').value,
        phone: document.getElementById('playerPhone').value,
        initialBalance: parseFloat(document.getElementById('playerBalance').value) || 0,
        password: document.getElementById('playerPassword').value
    };
    
    if (!playerData.username || !playerData.email || !playerData.password) {
        showToast('Please fill all required fields', 'error');
        return;
    }
    
    if (!isValidEmail(playerData.email)) {
        showToast('Please enter a valid email', 'error');
        return;
    }
    
    showLoading();
    try {
        const response = await fetch('/api/admin/create-player', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(playerData)
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('Player created successfully!', 'success');
            closeModal();
            loadPlayers();
            
            // Clear form
            document.getElementById('playerUsername').value = '';
            document.getElementById('playerEmail').value = '';
            document.getElementById('playerFullName').value = '';
            document.getElementById('playerPhone').value = '';
            document.getElementById('playerBalance').value = '0';
            document.getElementById('playerPassword').value = '';
        } else {
            showToast(data.message || 'Failed to create player', 'error');
        }
    } catch (error) {
        console.error('Error creating player:', error);
        showToast('Error creating player', 'error');
    } finally {
        hideLoading();
    }
}

// Load daily report
async function loadDailyReport() {
    const today = new Date().toISOString().split('T')[0];
    showLoading();
    try {
        const response = await fetch(`/api/reports/daily?date=${today}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displayReportSummary(data.summary);
        displayReportTable(data.rounds);
        
    } catch (error) {
        console.error('Error loading daily report:', error);
        showToast('Error loading report', 'error');
    } finally {
        hideLoading();
    }
}

// Load weekly report
async function loadWeeklyReport() {
    showLoading();
    try {
        const response = await fetch('/api/reports/weekly', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displayReportSummary(data);
        displayReportTable([]);
        
    } catch (error) {
        console.error('Error loading weekly report:', error);
        showToast('Error loading report', 'error');
    } finally {
        hideLoading();
    }
}

// Load monthly report
async function loadMonthlyReport() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    
    showLoading();
    try {
        const response = await fetch(`/api/reports/monthly?year=${year}&month=${month}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displayReportSummary(data.summary);
        displayReportTable(data.daily);
        
    } catch (error) {
        console.error('Error loading monthly report:', error);
        showToast('Error loading report', 'error');
    } finally {
        hideLoading();
    }
}

// Load date range report
async function loadDateRangeReport() {
    const startDate = document.getElementById('startDate')?.value;
    const endDate = document.getElementById('endDate')?.value;
    
    if (!startDate || !endDate) {
        showToast('Please select both start and end dates', 'error');
        return;
    }
    
    showLoading();
    try {
        const response = await fetch(`/api/reports/range?startDate=${startDate}&endDate=${endDate}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displayReportSummary(data.totals);
        displayReportTable(data.daily_data);
        
    } catch (error) {
        console.error('Error loading date range report:', error);
        showToast('Error loading report', 'error');
    } finally {
        hideLoading();
    }
}

// Display report summary
function displayReportSummary(summary) {
    const summaryDiv = document.getElementById('reportSummary');
    if (!summaryDiv) return;
    
    summaryDiv.innerHTML = `
        <div class="summary-stats">
            <div class="summary-item">
                <div class="summary-label">Total Rounds</div>
                <div class="summary-value">${summary.total_rounds || 0}</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Total Players</div>
                <div class="summary-value">${summary.total_players || 0}</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Total Bet</div>
                <div class="summary-value">${(summary.total_bet || 0).toFixed(2)} ETB</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Total Won</div>
                <div class="summary-value">${(summary.total_won || 0).toFixed(2)} ETB</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Total Commission</div>
                <div class="summary-value">${(summary.total_commission || 0).toFixed(2)} ETB</div>
            </div>
        </div>
    `;
}

// Display report table
function displayReportTable(data) {
    const tbody = document.querySelector('#reportTable tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No data available</td></tr>';
        return;
    }
    
    data.forEach(item => {
        const row = tbody.insertRow();
        row.insertCell(0).textContent = item.date || item.report_date || '-';
        row.insertCell(1).textContent = item.rounds || item.total_rounds || 0;
        row.insertCell(2).textContent = item.total_players || 0;
        row.insertCell(3).textContent = `${(item.total_bet || 0).toFixed(2)} ETB`;
        row.insertCell(4).textContent = `${(item.total_won || 0).toFixed(2)} ETB`;
        row.insertCell(5).textContent = `${(item.total_commission || 0).toFixed(2)} ETB`;
    });
}

// Change admin password
async function changeAdminPassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    
    if (!currentPassword || !newPassword) {
        showToast('Please fill all fields', 'error');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showToast('New passwords do not match', 'error');
        return;
    }
    
    if (newPassword.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }
    
    showLoading();
    try {
        const response = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('Password changed successfully!', 'success');
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
        } else {
            showToast(data.message || 'Failed to change password', 'error');
        }
    } catch (error) {
        console.error('Error changing password:', error);
        showToast('Error changing password', 'error');
    } finally {
        hideLoading();
    }
}

// Save game settings
async function saveGameSettings() {
    const settings = {
        default_win_percentage: document.getElementById('defaultWinPercentage')?.value || 75,
        min_bet_amount: parseFloat(document.getElementById('minBet')?.value) || 10,
        draw_interval_ms: (parseInt(document.getElementById('drawInterval')?.value) || 4) * 1000,
        selection_seconds: parseInt(document.getElementById('selectionSeconds')?.value) || 50,
        next_round_delay: parseInt(document.getElementById('nextRoundDelay')?.value) || 6
    };
    
    showLoading();
    try {
        const response = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ settings })
        });
        
        if (response.ok) {
            showToast('Settings saved successfully!', 'success');
        } else {
            showToast('Failed to save settings', 'error');
        }
    } catch (error) {
        console.error('Error saving settings:', error);
        showToast('Error saving settings', 'error');
    } finally {
        hideLoading();
    }
}

// Show modal
function showModal(title, content) {
    let modal = document.getElementById('customModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'customModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3 id="modalTitle"></h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body" id="modalBody"></div>
                <div class="modal-footer">
                    <button class="btn-primary" onclick="closeModal()">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = content;
    modal.style.display = 'flex';
}

// Close modal
function closeModal() {
    const modal = document.getElementById('customModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    const createModal = document.getElementById('createPlayerModal');
    if (createModal) {
        createModal.style.display = 'none';
    }
}

// Show create player modal
function showCreatePlayerModal() {
    const modal = document.getElementById('createPlayerModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

// Tab navigation
function showTab(tabName) {
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Update nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    // Load tab-specific data
    switch(tabName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'players':
            loadPlayers();
            break;
        case 'reports':
            loadDailyReport();
            break;
    }
}

// Change report type
function changeReportType() {
    const reportType = document.getElementById('reportType').value;
    const datePickerGroup = document.getElementById('datePickerGroup');
    const rangePickerGroup = document.getElementById('rangePickerGroup');
    
    if (reportType === 'daily') {
        datePickerGroup.style.display = 'block';
        rangePickerGroup.style.display = 'none';
        loadDailyReport();
    } else if (reportType === 'weekly') {
        datePickerGroup.style.display = 'none';
        rangePickerGroup.style.display = 'none';
        loadWeeklyReport();
    } else if (reportType === 'monthly') {
        datePickerGroup.style.display = 'block';
        rangePickerGroup.style.display = 'none';
        loadMonthlyReport();
    } else if (reportType === 'range') {
        datePickerGroup.style.display = 'none';
        rangePickerGroup.style.display = 'block';
        loadDateRangeReport();
    }
}

// Logout
function logout() {
    if (confirm('Are you sure you want to logout?')) {
        localStorage.removeItem('token');
        sessionStorage.clear();
        window.location.href = '/login.html';
    }
}

// Setup event listeners
function setupEventListeners() {
    // Auto-refresh dashboard every 10 seconds
    setInterval(() => {
        const dashboardTab = document.getElementById('dashboard-tab');
        if (dashboardTab && dashboardTab.classList.contains('active')) {
            loadDashboard();
        }
    }, 10000);
}

// Toggle sidebar on mobile
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('open');
    }
}

// Expose functions for global access
window.createGame = createGame;
window.copyGameCode = copyGameCode;
window.loadPlayers = loadPlayers;
window.adjustBalance = adjustBalance;
window.togglePlayerStatus = togglePlayerStatus;
window.viewPlayerHistory = viewPlayerHistory;
window.createPlayer = createPlayer;
window.showTab = showTab;
window.changeReportType = changeReportType;
window.loadDailyReport = loadDailyReport;
window.loadWeeklyReport = loadWeeklyReport;
window.loadMonthlyReport = loadMonthlyReport;
window.loadDateRangeReport = loadDateRangeReport;
window.changeAdminPassword = changeAdminPassword;
window.saveGameSettings = saveGameSettings;
window.logout = logout;
window.closeModal = closeModal;
window.showCreatePlayerModal = showCreatePlayerModal;
window.toggleSidebar = toggleSidebar;