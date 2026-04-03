// dashboard.js — Session history dashboard

'use strict';

let chartInstance = null;

async function init() {
  const { sessionHistory = [] } = await chrome.storage.local.get('sessionHistory');
  render(sessionHistory);

  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (confirm('Clear all session history?')) {
      await chrome.storage.local.remove(['sessionHistory', 'lastResult']);
      render([]);
    }
  });
}

function render(history) {
  renderStats(history);
  renderChart(history);
  renderTable(history);
}

// ─── Stat cards ───────────────────────────────────────────────────────────────

function renderStats(history) {
  if (history.length === 0) {
    document.getElementById('statAvgScore').textContent = '—';
    document.getElementById('statAvgDmn').textContent = '—';
    document.getElementById('statAvgFpn').textContent = '—';
    document.getElementById('statReelsToday').textContent = '0';
    return;
  }

  const avg = (key) => (history.reduce((s, r) => s + (r[key] || 0), 0) / history.length).toFixed(2);

  const avgScore = parseFloat(avg('brain_rot'));
  const scoreEl = document.getElementById('statAvgScore');
  scoreEl.textContent = avgScore.toFixed(1);
  scoreEl.className = `stat-value ${avgScore <= SCORE_THRESHOLDS.GREEN_MAX ? '' : avgScore <= SCORE_THRESHOLDS.YELLOW_MAX ? '' : 'red'}`;

  document.getElementById('statAvgDmn').textContent = avg('dmn');
  document.getElementById('statAvgFpn').textContent = avg('fpn');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const reelsToday = history.filter(r => r.savedAt >= todayStart.getTime()).length;
  document.getElementById('statReelsToday').textContent = reelsToday;
}

// ─── Chart ────────────────────────────────────────────────────────────────────

function renderChart(history) {
  const canvas = document.getElementById('scoreChart');
  const last30 = history.slice(-30);

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  if (last30.length === 0) return;

  const labels = last30.map((_, i) => `#${history.length - last30.length + i + 1}`);
  const scores = last30.map(r => Math.round((r.brain_rot || 0) * 10) / 10);
  const colors = scores.map(s =>
    s <= SCORE_THRESHOLDS.GREEN_MAX ? '#34a853'
    : s <= SCORE_THRESHOLDS.YELLOW_MAX ? '#fbbc04'
    : '#ea4335'
  );

  chartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Brain Rot Score',
        data: scores,
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              const reel = last30[idx];
              return `Reel ${labels[idx]} — ${reel.platform || 'unknown'}`;
            },
            label: (item) => `Score: ${item.raw}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: '#f1f3f4' },
          ticks: { color: '#5f6368', font: { size: 11 } },
        },
        x: {
          grid: { display: false },
          ticks: { color: '#5f6368', font: { size: 11 } },
        },
      },
    },
  });
}

// ─── Table ────────────────────────────────────────────────────────────────────

function renderTable(history) {
  const container = document.getElementById('tableContainer');

  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧠</div>
        <div>No reels analyzed yet.</div>
        <div style="margin-top:8px;font-size:12px">Open Instagram, TikTok, or YouTube Shorts and watch a reel.</div>
      </div>`;
    return;
  }

  const rows = [...history].reverse().map((reel, i) => {
    const score = Math.round((reel.brain_rot || 0) * 10) / 10;
    const scoreClass = score <= SCORE_THRESHOLDS.GREEN_MAX ? 'green'
      : score <= SCORE_THRESHOLDS.YELLOW_MAX ? 'yellow' : 'red';
    const time = reel.savedAt ? new Date(reel.savedAt).toLocaleTimeString() : '—';
    const date = reel.savedAt ? new Date(reel.savedAt).toLocaleDateString() : '—';
    return `
      <tr>
        <td>${date} ${time}</td>
        <td><span class="platform-tag">${reel.platform || '—'}</span></td>
        <td><span class="score-pill ${scoreClass}">${score}</span></td>
        <td>${(reel.dmn || 0).toFixed(2)}</td>
        <td>${(reel.fpn || 0).toFixed(2)}</td>
        <td>${(reel.reward || 0).toFixed(2)}</td>
        <td>${(reel.visual || 0).toFixed(2)}</td>
        <td>${(reel.somatomotor || 0).toFixed(2)}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Platform</th>
          <th>Brain Rot</th>
          <th>DMN</th>
          <th>FPN</th>
          <th>Reward</th>
          <th>Visual</th>
          <th>Somatomotor</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

init();
