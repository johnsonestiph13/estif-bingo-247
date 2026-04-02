// Reports JavaScript for Estif Bingo Admin

// Initialize reports
document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    loadReports();
});

// Initialize date pickers with default values
function initializeDatePickers() {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const reportDateInput = document.getElementById('reportDate');
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    
    if (reportDateInput) {
        reportDateInput.value = today;
        reportDateInput.addEventListener('change', () => loadReports());
    }
    
    if (startDateInput) {
        startDateInput.value = weekAgo.toISOString().split('T')[0];
        startDateInput.addEventListener('change', () => loadDateRangeReport());
    }
    
    if (endDateInput) {
        endDateInput.value = today;
        endDateInput.addEventListener('change', () => loadDateRangeReport());
    }
}

// Load reports based on type
async function loadReports() {
    const reportType = document.getElementById('reportType')?.value || 'daily';
    
    switch(reportType) {
        case 'daily':
            await loadDailyReport();
            break;
        case 'weekly':
            await loadWeeklyReport();
            break;
        case 'monthly':
            await loadMonthlyReport();
            break;
        case 'range':
            await loadDateRangeReport();
            break;
        default:
            await loadDailyReport();
    }
}

// Load daily report
async function loadDailyReport() {
    const date = document.getElementById('reportDate')?.value;
    if (!date) return;
    
    showLoading();
    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`/api/reports/daily?date=${date}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displaySummary(data.summary);
        displayGameDetails(data.rounds);
        displayCharts(data.rounds, 'daily');
        
    } catch (error) {
        console.error('Error loading daily report:', error);
        showToast('Error loading daily report', 'error');
    } finally {
        hideLoading();
    }
}

// Load weekly report
async function loadWeeklyReport() {
    showLoading();
    try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/reports/weekly', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displaySummary(data);
        displayWeeklyDetails(data);
        displayCharts([], 'weekly');
        
    } catch (error) {
        console.error('Error loading weekly report:', error);
        showToast('Error loading weekly report', 'error');
    } finally {
        hideLoading();
    }
}

// Load monthly report
async function loadMonthlyReport() {
    const date = document.getElementById('reportDate')?.value;
    if (!date) return;
    
    const [year, month] = date.split('-');
    
    showLoading();
    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`/api/reports/monthly?year=${year}&month=${month}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displaySummary(data.summary);
        displayGameDetails(data.daily);
        displayCharts(data.daily, 'monthly');
        
    } catch (error) {
        console.error('Error loading monthly report:', error);
        showToast('Error loading monthly report', 'error');
    } finally {
        hideLoading();
    }
}

// Load date range report
async function loadDateRangeReport() {
    const startDate = document.getElementById('startDate')?.value;
    const endDate = document.getElementById('endDate')?.value;
    
    if (!startDate || !endDate) return;
    
    showLoading();
    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`/api/reports/range?startDate=${startDate}&endDate=${endDate}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        
        displaySummary(data.totals);
        displayGameDetails(data.daily_data);
        displayCharts(data.daily_data, 'range');
        
    } catch (error) {
        console.error('Error loading date range report:', error);
        showToast('Error loading date range report', 'error');
    } finally {
        hideLoading();
    }
}

// Display summary statistics
function displaySummary(summary) {
    const summaryDiv = document.getElementById('reportSummary');
    if (!summaryDiv) return;
    
    summaryDiv.innerHTML = `
        <div class="summary-stats">
            <div class="summary-item">
                <div class="summary-label">📊 Total Rounds</div>
                <div class="summary-value">${summary.total_rounds || 0}</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">👥 Total Players</div>
                <div class="summary-value">${summary.total_players || 0}</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">💰 Total Bet</div>
                <div class="summary-value">${(summary.total_bet || 0).toFixed(2)} ETB</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">🏆 Total Won</div>
                <div class="summary-value">${(summary.total_won || 0).toFixed(2)} ETB</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">💸 Total Commission</div>
                <div class="summary-value">${(summary.total_commission || 0).toFixed(2)} ETB</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">📈 Platform Revenue</div>
                <div class="summary-value">${((summary.total_bet || 0) - (summary.total_won || 0)).toFixed(2)} ETB</div>
            </div>
        </div>
    `;
}

// Display game details table
function displayGameDetails(games) {
    const tbody = document.querySelector('#reportTable tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    if (!games || games.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No data available</td></tr>';
        return;
    }
    
    games.forEach(game => {
        const row = tbody.insertRow();
        row.insertCell(0).textContent = game.date || game.report_date || '-';
        row.insertCell(1).textContent = game.round_number || game.rounds || '-';
        row.insertCell(2).textContent = game.total_players || 0;
        row.insertCell(3).textContent = `${(game.total_bet || 0).toFixed(2)} ETB`;
        row.insertCell(4).textContent = `${(game.winner_amount || game.total_won || 0).toFixed(2)} ETB`;
        row.insertCell(5).textContent = `${(game.admin_commission || game.total_commission || 0).toFixed(2)} ETB`;
        row.insertCell(6).innerHTML = game.winners ? `<span class="winners-list">${JSON.parse(game.winners).join(', ')}</span>` : '-';
    });
}

// Display weekly details
function displayWeeklyDetails(data) {
    const detailsDiv = document.getElementById('weeklyDetails');
    if (!detailsDiv) return;
    
    detailsDiv.innerHTML = `
        <div class="weekly-stats">
            <div class="weekly-item">
                <strong>Week ${data.week}</strong> - Year ${data.year}
            </div>
            <div class="weekly-item">
                Average Players/Round: ${data.total_rounds > 0 ? Math.round(data.total_players / data.total_rounds) : 0}
            </div>
            <div class="weekly-item">
                Average Bet/Round: ${data.total_rounds > 0 ? (data.total_bet / data.total_rounds).toFixed(2) : 0} ETB
            </div>
        </div>
    `;
}

// Display charts
function displayCharts(data, type) {
    const chartContainer = document.getElementById('reportChart');
    if (!chartContainer) return;
    
    // Prepare chart data
    const labels = data.map(d => d.date || d.report_date);
    const betData = data.map(d => parseFloat(d.total_bet || 0));
    const wonData = data.map(d => parseFloat(d.winner_amount || d.total_won || 0));
    
    // Clear previous chart
    chartContainer.innerHTML = '<canvas id="reportCanvas"></canvas>';
    
    const canvas = document.getElementById('reportCanvas');
    if (!canvas) return;
    
    // Create chart
    new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Total Bet (ETB)',
                    data: betData,
                    borderColor: '#f5c542',
                    backgroundColor: 'rgba(245, 197, 66, 0.1)',
                    tension: 0.4,
                    fill: true
                },
                {
                    label: 'Total Won (ETB)',
                    data: wonData,
                    borderColor: '#4caf50',
                    backgroundColor: 'rgba(76, 175, 80, 0.1)',
                    tension: 0.4,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#f5efdc' }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Amount (ETB)',
                        color: '#f5efdc'
                    },
                    ticks: { color: '#f5efdc' }
                },
                x: {
                    title: {
                        display: true,
                        text: type === 'monthly' ? 'Day' : 'Date',
                        color: '#f5efdc'
                    },
                    ticks: { color: '#f5efdc' }
                }
            }
        }
    });
}

// Export report as CSV
function exportReportCSV() {
    const table = document.querySelector('#reportTable');
    if (!table) return;
    
    const rows = table.querySelectorAll('tr');
    const csvData = [];
    
    rows.forEach(row => {
        const rowData = [];
        row.querySelectorAll('th, td').forEach(cell => {
            rowData.push(cell.textContent.trim());
        });
        csvData.push(rowData.join(','));
    });
    
    const csvContent = csvData.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bingo_report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('Report exported successfully!', 'success');
}

// Print report
function printReport() {
    const reportContent = document.getElementById('reportContent');
    if (!reportContent) return;
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
        <head>
            <title>Estif Bingo Report</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                table { border-collapse: collapse; width: 100%; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                th { background-color: #f2f2f2; }
                .summary { margin-bottom: 20px; }
                .summary-item { display: inline-block; margin-right: 20px; }
            </style>
        </head>
        <body>
            ${reportContent.innerHTML}
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.print();
}

// Expose functions for global access
window.loadReports = loadReports;
window.loadDailyReport = loadDailyReport;
window.loadWeeklyReport = loadWeeklyReport;
window.loadMonthlyReport = loadMonthlyReport;
window.loadDateRangeReport = loadDateRangeReport;
window.exportReportCSV = exportReportCSV;
window.printReport = printReport;
window.changeReportType = loadReports;