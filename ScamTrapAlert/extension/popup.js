// popup.js - ScamTrapAlert popup: scan UI, Chart.js gauge, auto-scan cache restore

const AUTO_SCAN_CACHE_MS = 5 * 60 * 1000;

function openPrimeModal() {
  document.getElementById('primeModal').hidden = false;
  document.getElementById('primeCloseBtn')?.focus();
} 

function closePrimeModal() {
  document.getElementById('primeModal').hidden = true;
}

function formatUsdPrice(amount) {
  const n = Number(amount) || 0;
  if (Number.isInteger(n)) return `$${n.toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

function selectUpgradePlan(panel, planId) {
  if (!panel) return;
  const plans = panel.querySelectorAll('.upgrade-plan');
  let price = '4.99';
  plans.forEach((plan) => {
    const selected = plan.dataset.plan === planId;
    plan.classList.toggle('upgrade-plan--selected', selected);
    plan.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) price = plan.dataset.price || price;
  });
  const payBtn = panel.querySelector('[data-upgrade-pay]');
  if (payBtn) {
    payBtn.textContent = `Pay ${formatUsdPrice(price)} →`;
  }
}

function initUpgradePanels() {
  document.querySelectorAll('.upgrade-panel').forEach((panel) => {
    panel.querySelectorAll('.upgrade-plan').forEach((planBtn) => {
      planBtn.addEventListener('click', () => {
        selectUpgradePlan(panel, planBtn.dataset.plan);
      });
    });
    panel.querySelector('[data-upgrade-pay]')?.addEventListener('click', () => {
      alert('Payments are not available yet. Stay tuned for ScamTrapAlert Prime!');
    });
    const selected = panel.querySelector('.upgrade-plan--selected');
    if (selected) selectUpgradePlan(panel, selected.dataset.plan);
  });
}

function initProBanners() {
  document.querySelectorAll('[data-open-upgrade]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openPrimeModal();
    });
  });
}

function setQuotaExhaustedMode(active) {
  const container = document.querySelector('.popup-container');
  const scanMain = document.getElementById('scanMainSection');
  const results = document.getElementById('results');
  const homeUpgrade = document.getElementById('homeUpgradePanel');
  const homeProBanner = document.getElementById('homeProBanner');
  const scanTab = document.getElementById('scan-tab');
  const tabsNav = document.querySelector('.tabs');

  container?.classList.toggle('popup-container--quota-exhausted', active);

  if (active) {
    container?.classList.remove('popup-container--has-result');
    if (scanMain) scanMain.hidden = true;
    if (results) results.hidden = true;
    if (homeUpgrade) homeUpgrade.hidden = false;
    if (homeProBanner) homeProBanner.hidden = true;
    if (tabsNav) tabsNav.hidden = true;
    closePrimeModal();

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const isHome = btn.getAttribute('data-tab') === 'scan';
      btn.classList.toggle('active', isHome);
      btn.setAttribute('aria-selected', isHome ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-content').forEach((panel) => {
      panel.classList.toggle('active', panel.id === 'scan-tab');
    });
  } else {
    if (scanMain) scanMain.hidden = false;
    if (homeUpgrade) homeUpgrade.hidden = true;
    if (homeProBanner) homeProBanner.hidden = false;
    if (tabsNav) tabsNav.hidden = false;
  }

  scanTab?.classList.toggle('scan-tab--upgrade-only', active);
}

function updateUsageUI(usage) {
  const bar = document.getElementById('usageBar');
  const textEl = document.getElementById('usageText');
  const scanButton = document.getElementById('scanButton');
  if (!bar || !textEl || !usage) return;

  const remaining = Number(usage.scansRemaining) || 0;
  const limit = Number(usage.scansLimit) || 0;
  const used = Number(usage.scansUsed) || 0;

  if (!limit) {
    textEl.textContent = 'Loading scan quota…';
    return;
  }

  if (remaining <= 0) {
    textEl.textContent = `0 scans remaining today (${used}/${limit} used · resets midnight UTC)`;
    bar.classList.add('usage-bar--empty');
    if (scanButton) scanButton.disabled = true;
    setQuotaExhaustedMode(true);
  } else {
    textEl.textContent = `${remaining} scan${remaining === 1 ? '' : 's'} remaining today (${used}/${limit} used)`;
    bar.classList.remove('usage-bar--empty');
    if (scanButton && scanButton.querySelector('.scan-button__label')?.textContent !== 'Analyzing content…') {
      scanButton.disabled = false;
    }
    setQuotaExhaustedMode(false);
  }
}

async function refreshUsageDisplay() {
  const textEl = document.getElementById('usageText');
  try {
    const deviceId = await ensureDeviceId();
    const { usage } = await fetchUsageStatus(deviceId);
    if (usage) {
      updateUsageUI(usage);
      return;
    }
    textEl.textContent = 'Run backend: cd backend && npm start';
  } catch (e) {
    try {
      const local = await getLocalUsageStatus();
      updateUsageUI(local);
    } catch {
      textEl.textContent = 'Run backend: cd backend && npm start';
    }
  }
}

function isQuotaExceededResponse(response) {
  if (!response) return false;
  if (response.error === 'quota_exceeded') return true;
  const err = String(response.error || response.message || '');
  return /quota|402|daily limit/i.test(err);
}

function isDeviceErrorResponse(response) {
  if (!response) return false;
  if (response.error === 'device_error') return true;
  const err = String(response.error || response.message || '');
  return /device_id|device id|status 400/i.test(err);
}

function isAiRateLimitResponse(response) {
  if (!response) return false;
  if (response.error === 'ai_rate_limited') return true;
  const err = String(response.error || response.message || '');
  return /ai_rate_limited|rate limit reached|groq.*429|tokens per day/i.test(err);
}

document.addEventListener('DOMContentLoaded', async function () {
  const scanButton = document.getElementById('scanButton');
  const loading = document.getElementById('loading');
  const results = document.getElementById('results');

  await refreshUsageDisplay();
  initUpgradePanels();
  initProBanners();

  document.getElementById('primeCloseBtn')?.addEventListener('click', closePrimeModal);
  document.getElementById('primeModalBackdrop')?.addEventListener('click', closePrimeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('primeModal')?.hidden) {
      closePrimeModal();
    }
  });
  closePrimeModal();

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');

      tabBtns.forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      tabContents.forEach((c) => c.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      document.getElementById(`${tabId}-tab`).classList.add('active');

      if (tabId === 'history') loadHistory();
    });
  });

  const autoScanCheck = document.getElementById('autoScan');
  const sensitivitySelect = document.getElementById('sensitivity');

  chrome.storage.local.get(['autoScan', 'sensitivity'], (data) => {
    autoScanCheck.checked = data.autoScan || false;
    sensitivitySelect.value = data.sensitivity || 'medium';
  });

  autoScanCheck.addEventListener('change', () => {
    chrome.storage.local.set({ autoScan: autoScanCheck.checked });
  });

  sensitivitySelect.addEventListener('change', () => {
    chrome.storage.local.set({ sensitivity: sensitivitySelect.value });
  });

  document.getElementById('clearHistory').addEventListener('click', () => {
    chrome.storage.local.set({ scanHistory: [] }, () => {
      loadHistory();
    });
  });

  scanButton.addEventListener('click', async function () {
    const deviceId = await ensureDeviceId();
    const { usage } = await fetchUsageStatus(deviceId);
    if (usage && usage.scansRemaining <= 0) {
      updateUsageUI(usage);
      return;
    }

    const sensitivity = sensitivitySelect.value || 'medium';
    try {
      setPostScanCompactMode(false);
      destroyScoreChart();
      results.hidden = true;
      setScanBusy(true);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.runtime.sendMessage({ action: 'clearTabCache', tabId: tab.id });
      }

      const response = await chrome.runtime.sendMessage({
        action: 'scan',
        deviceId,
        sensitivity,
        forceFresh: true
      });

      if (!response) {
        results.hidden = false;
        displayError(
          'Extension could not reach the page. Refresh the LinkedIn tab, reload the extension, then scan again.',
          ''
        );
        clearPageHighlights();
        return;
      }

      if (isQuotaExceededResponse(response)) {
        if (response.usage) updateUsageUI(response.usage);
        else await refreshUsageDisplay();
        return;
      }

      if (isAiRateLimitResponse(response)) {
        results.hidden = false;
        displayAiRateLimitError(response);
        return;
      }

      if (isDeviceErrorResponse(response)) {
        results.hidden = false;
        displayError(
          response.message || 'Reload the extension at chrome://extensions and try again.',
          '',
          response
        );
        return;
      }

      if (response._usage) updateUsageUI(response._usage);
      else await refreshUsageDisplay();

      const exhausted =
        (response._usage && response._usage.scansRemaining <= 0) ||
        document.querySelector('.popup-container')?.classList.contains('popup-container--quota-exhausted');

      saveToHistory(response);

      if (exhausted) {
        sendHighlightMessage(response);
        return;
      }

      results.hidden = false;
      displayResults(response);
      sendHighlightMessage(response);
    } catch (error) {
      console.error('Scan failed:', error);
      results.hidden = false;
      displayError('Failed to scan page. Please try again.');
      clearPageHighlights();
    } finally {
      setScanBusy(false);
      syncScanButtonLabel();
      try {
        const { usage } = await fetchUsageStatus(await ensureDeviceId());
        if (usage) {
          updateUsageUI(usage);
          if (usage.scansRemaining > 0) scanButton.disabled = false;
        }
      } catch {
        scanButton.disabled = false;
      }
    }
  });

  loadHistory();
});

async function tryRestoreAutoScanResult(resultsEl) {
  try {
    const deviceId = await ensureDeviceId();
    const { usage } = await fetchUsageStatus(deviceId);
    if (usage && usage.scansRemaining <= 0) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;

    const { autoScanResults = {} } = await chrome.storage.local.get('autoScanResults');
    const cached = autoScanResults[String(tab.id)];
    if (!cached || cached.url !== tab.url) return;
    if (Date.now() - cached.ts > AUTO_SCAN_CACHE_MS) return;
    if (!cached.result || cached.result.error) return;

    resultsEl.hidden = false;
    displayResults(cached.result);
    sendHighlightMessage(cached.result);
  } catch (e) {
    console.warn('tryRestoreAutoScanResult:', e);
  }
}

function computeDisplayScore(data) {
  const score = Number(data?.overall_risk_score) || 0;
  const apiRiskRaw = (data?.risk_level || 'SAFE').toString().trim().toUpperCase();
  const riskAliases = { MODERATE: 'MEDIUM', DANGER: 'HIGH', CRITICAL: 'EXTREME' };
  const apiRiskLevel = riskAliases[apiRiskRaw] || apiRiskRaw;
  let displayScore = score;
  if (apiRiskLevel === 'HIGH' || apiRiskLevel === 'EXTREME') {
    displayScore = Math.max(displayScore, 20);
  } else if (apiRiskLevel === 'MEDIUM') {
    displayScore = Math.max(displayScore, 15);
  } else if (score > 10) {
    displayScore = Math.max(displayScore, 11);
  }
  return Math.round(displayScore);
}

const RISK_CATEGORY_SEGMENTS = [
  { key: 'phishing_signals', label: 'Phishing', legendName: 'Phishing signals', color: '#f87171' },
  { key: 'fake_recruiter_signals', label: 'Fake job', legendName: 'Fake recruiter', color: '#fb923c' },
  { key: 'urgency_tactics', label: 'Urgency', legendName: 'Urgency tactics', color: '#fbbf24' },
  { key: 'fear_manipulation', label: 'Fear', legendName: 'Fear manipulation', color: '#f472b6' },
  { key: 'trust_engineering', label: 'Trust', legendName: 'Trust engineering', color: '#c084fc' },
  { key: 'authority_abuse', label: 'Authority', legendName: 'Authority abuse', color: '#a78bfa' },
  { key: 'fake_scarcity', label: 'Scarcity', legendName: 'Fake scarcity', color: '#38bdf8' },
  { key: 'ai_generated_content', label: 'AI tone', legendName: 'AI-generated tone', color: '#94a3b8' }
];

function categoryLevelWeight(level) {
  const raw = (level || 'LOW').toString().trim().toUpperCase();
  if (raw === 'HIGH') return 2;
  if (raw === 'MEDIUM') return 1;
  return 0;
}

function riskArcColor(visualLevel) {
  const level = (visualLevel || 'SAFE').toUpperCase();
  if (level === 'HIGH' || level === 'EXTREME') return '#fb7185';
  if (level === 'MEDIUM') return '#fbbf24';
  return '#22d3ee';
}

function getElevatedCategorySegments(categories) {
  if (!categories) return [];
  return RISK_CATEGORY_SEGMENTS.map((seg) => {
    const level = (categories[seg.key] || 'LOW').toString().trim().toUpperCase();
    const weight = categoryLevelWeight(level);
    if (!weight) return null;
    return { ...seg, level, weight };
  }).filter(Boolean);
}

function setChartCenterScore(value, visualLevel) {
  const el = document.getElementById('chartCenterScore');
  if (!el) return;
  el.textContent = value == null || value === '' ? '—' : String(value);
  el.setAttribute('data-level', (visualLevel || 'SAFE').toUpperCase());
}

function segmentHint(level) {
  if (level === 'HIGH') return 'Strong signal — pause before you act';
  if (level === 'MEDIUM') return 'Possible signal — double-check claims';
  return 'Low signal';
}

function setRiskChartSubtitle(elevatedCount, score) {
  const sub = document.getElementById('riskChartSubtitle');
  if (!sub) return;
  if (elevatedCount > 0) {
    sub.textContent = `${elevatedCount} active signal${elevatedCount > 1 ? 's' : ''} — larger slices matter more`;
  } else if (score > 0) {
    sub.textContent = 'Ring shows your overall risk score (0 = safe, 100 = extreme)';
  } else {
    sub.textContent = 'No manipulation signals detected in this scan';
  }
}

function highlightChartSegment(index) {
  const chart = window._riskScoreChart;
  if (!chart || index == null || index < 0) {
    if (chart) {
      chart.setActiveElements([]);
      chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
      chart.update();
    }
    document.querySelectorAll('.chart-legend__item--active').forEach((el) => {
      el.classList.remove('chart-legend__item--active');
    });
    return;
  }

  chart.setActiveElements([{ datasetIndex: 0, index }]);
  chart.update();
  document.querySelectorAll('.chart-legend__item[data-segment]').forEach((el) => {
    el.classList.toggle('chart-legend__item--active', Number(el.dataset.segment) === index);
  });
}

function renderChartLegend(elevated, score, visualLevel) {
  const list = document.getElementById('chartLegend');
  if (!list) return;

  list.replaceChildren();
  setRiskChartSubtitle(elevated.length, score);

  if (elevated.length > 0) {
    elevated.forEach((seg, index) => {
      const li = document.createElement('li');
      li.className = 'chart-legend__item chart-legend__item--interactive';
      li.dataset.segment = String(index);
      li.setAttribute('role', 'listitem');

      const dot = document.createElement('span');
      dot.className = 'chart-legend__dot';
      dot.style.backgroundColor = seg.color;

      const text = document.createElement('div');
      text.className = 'chart-legend__text';
      const name = document.createElement('span');
      name.className = 'chart-legend__name';
      name.textContent = seg.legendName || seg.label;
      const hint = document.createElement('span');
      hint.className = 'chart-legend__hint';
      hint.textContent = segmentHint(seg.level);
      text.append(name, hint);

      const badge = document.createElement('span');
      badge.className = 'chart-legend__level';
      badge.dataset.level = seg.level;
      badge.textContent = seg.level;

      li.append(dot, text, badge);
      li.addEventListener('mouseenter', () => highlightChartSegment(index));
      li.addEventListener('mouseleave', () => highlightChartSegment(-1));
      li.addEventListener('focus', () => highlightChartSegment(index));
      li.addEventListener('blur', () => highlightChartSegment(-1));
      list.appendChild(li);
    });
    return;
  }

  const li = document.createElement('li');
  li.className = 'chart-legend__item';
  const dot = document.createElement('span');
  dot.className = 'chart-legend__dot';
  dot.style.backgroundColor = riskArcColor(visualLevel);

  const text = document.createElement('div');
  text.className = 'chart-legend__text';
  const name = document.createElement('span');
  name.className = 'chart-legend__name';
  name.textContent = score > 0 ? 'Overall risk level' : 'All clear';
  const hint = document.createElement('span');
  hint.className = 'chart-legend__hint';
  hint.textContent =
    score > 0
      ? `Filled ring = ${score} / 100 on our scale`
      : 'Expand “Manipulation signals” below for category details';
  text.append(name, hint);

  const badge = document.createElement('span');
  badge.className = 'chart-legend__level';
  badge.dataset.level = visualLevel === 'SAFE' ? 'SAFE' : visualLevel;
  badge.textContent = visualLevel;

  li.append(dot, text, badge);
  list.appendChild(li);
}

function updateRiskChart(data, displayScore, visualLevel) {
  const canvas = document.getElementById('scoreChart');
  const wrap = document.getElementById('scoreChartWrap');
  if (!canvas || typeof Chart === 'undefined') return;

  if (window._riskScoreChart) {
    window._riskScoreChart.destroy();
    window._riskScoreChart = null;
  }

  const score = Math.max(0, Math.min(100, Number(displayScore) || 0));
  const level = (visualLevel || 'SAFE').toUpperCase();
  setChartCenterScore(score, level);

  const elevated = getElevatedCategorySegments(data?.categories);
  const trackColor = '#0f172a';
  const segmentBorder = '#0f172a';

  let chartData;
  let chartLabels;
  let chartColors;
  let ariaSummary;

  if (elevated.length > 0) {
    chartLabels = elevated.map((s) => s.label);
    chartData = elevated.map((s) => s.weight);
    chartColors = elevated.map((s) => s.color);
    const names = elevated.map((s) => `${s.legendName || s.label} ${s.level}`).join(', ');
    ariaSummary = `Risk score ${score}. Active signals: ${names}`;
  } else {
    const filled = score;
    const rest = Math.max(0, 100 - filled);
    chartLabels = ['Risk level', 'Remaining'];
    chartData = filled > 0 ? [filled, rest] : [1, 99];
    chartColors =
      filled > 0 ? [riskArcColor(level), trackColor] : ['#334155', trackColor];
    ariaSummary =
      score > 0
        ? `Risk score ${score} out of 100, ${level} level`
        : `Risk score 0, no manipulation signals detected`;
  }

  if (wrap) wrap.setAttribute('aria-label', ariaSummary);
  renderChartLegend(elevated, score, level);

  window._riskScoreChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: chartLabels,
      datasets: [
        {
          data: chartData,
          backgroundColor: chartColors,
          borderColor: segmentBorder,
          borderWidth: elevated.length > 1 ? 3 : 0,
          hoverOffset: elevated.length > 0 ? 10 : 4,
          spacing: elevated.length > 1 ? 2 : 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      layout: { padding: 4 },
      cutout: elevated.length > 0 ? '58%' : '65%',
      animation: { duration: 400 },
      interaction: { mode: 'nearest', intersect: true },
      onHover(_event, elements) {
        if (elevated.length === 0) return;
        const idx = elements?.[0]?.index;
        highlightChartSegment(idx != null ? idx : -1);
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      }
    }
  });
}

function destroyScoreChart() {
  if (window._riskScoreChart) {
    window._riskScoreChart.destroy();
    window._riskScoreChart = null;
  }
  setChartCenterScore('—', 'SAFE');
  const wrap = document.getElementById('scoreChartWrap');
  if (wrap) wrap.setAttribute('aria-label', 'Risk breakdown chart');
  const list = document.getElementById('chartLegend');
  if (list) list.replaceChildren();
  setRiskChartSubtitle(0, 0);
}

function saveToHistory(data) {
  if (!data || data.error) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || 'Unknown';
    const newEntry = {
      url: url,
      score: data.overall_risk_score || 0,
      level: data.risk_level || 'SAFE',
      timestamp: new Date().toISOString()
    };

    chrome.storage.local.get(['scanHistory'], (result) => {
      let history = result.scanHistory || [];
      history.unshift(newEntry);
      history = history.slice(0, 10);
      chrome.storage.local.set({ scanHistory: history });
    });
  });
}

function safeHostname(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}

function loadHistory() {
  const historyList = document.getElementById('historyList');
  if (!historyList) return;

  chrome.storage.local.get(['scanHistory'], (result) => {
    const history = result.scanHistory || [];

    if (history.length === 0) {
      historyList.innerHTML = '<p class="no-history">No scan history yet.</p>';
      return;
    }

    historyList.innerHTML = history
      .map(
        (item) => {
        const scoreClass = item.score > 60 ? 'history-score--high' : 'history-score--low';
        return `
      <div class="history-item">
        <div class="history-details">
          <span class="history-url">${safeHostname(item.url)}</span>
          <span class="history-date">${new Date(item.timestamp).toLocaleDateString()}</span>
        </div>
        <div class="history-score ${scoreClass}">${item.score}</div>
      </div>
    `;
      }
      )
      .join('');
  });
}

function setScamTypeLabel(label, riskLevel) {
  const el = document.getElementById('scamTypeLabel');
  if (!el) return;

  const level = (riskLevel || 'SAFE').toString().trim().toUpperCase();
  const text = (label || '').trim() || 'Unknown';

  el.textContent = text;
  el.setAttribute('data-level', level);
}

function deriveScamTypeLabel(data, visualLevel) {
  const fromApi = (data.scam_type || '').toString().trim();
  if (fromApi) return fromApi;

  const cats = data.categories || {};
  const score = Number(data.overall_risk_score) || 0;

  if (visualLevel === 'SAFE' && score < 15) return 'No Clear Threat';

  if (cats.fake_recruiter_signals === 'HIGH') return 'Fake Job Offer';
  if (cats.phishing_signals === 'HIGH') return 'Phishing Attack';
  if (cats.fake_scarcity === 'HIGH') return 'Fake Urgency / Scarcity';
  if (cats.trust_engineering === 'HIGH') return 'Trust Manipulation';
  if (cats.fear_manipulation === 'HIGH') return 'Fear Manipulation';
  if (cats.urgency_tactics === 'HIGH') return 'Pressure / Urgency Scam';
  if (cats.authority_abuse === 'HIGH') return 'Impersonation Scam';

  const summary = (data.summary || '').toLowerCase();
  if (/crypto|bitcoin|usdt|wallet/i.test(summary)) return 'Crypto Scam';
  if (/romance|dating|love/i.test(summary)) return 'Romance Scam';
  if (/job|recruit|salary|interview/i.test(summary)) return 'Fake Job Offer';
  if (/phish|login|password|verify your account/i.test(summary)) return 'Phishing Attack';
  if (/payment|qr|upi|transfer|send money/i.test(summary)) return 'Payment Fraud';

  if (visualLevel === 'HIGH' || visualLevel === 'EXTREME') return 'Suspicious Scam';
  if (visualLevel === 'MEDIUM') return 'Possible Scam';
  return 'No Clear Threat';
}

function isChatPlatform(platform) {
  const p = (platform || '').toLowerCase();
  return /whatsapp|telegram/.test(p) || (p.includes('linkedin') && !/job/i.test(platform));
}

function isLinkedInJobResult(data) {
  return (
    data?.linkedin_content_type === 'job' ||
    /linkedin · job/i.test(data?.scan_description || '') ||
    /job post/i.test(data?.context || '')
  );
}

function linkedInJobExtractionSucceeded(data) {
  return isLinkedInJobResult(data) && !data?.error && !data?.extraction_failed && !!(data?.text || '').trim();
}

function extractLegacyScanTitle(desc) {
  const d = (desc || '').trim();
  const chat = d.match(/^Scanning active (?:WhatsApp|Telegram) chat(?: with)?\s+(.+)$/i);
  if (chat) return chat[1].trim();
  const email = d.match(/^Scanning open email:\s*(.+)$/i);
  if (email) return email[1].trim();
  return '';
}

function normalizeScanDescription(desc, platform) {
  let d = (desc || '').trim();
  if (!d) return d;

  if (/^scanning active whatsapp chat/i.test(d)) {
    return 'WhatsApp · Active chat';
  }
  if (/^scanning active telegram chat(?: with)?\s*/i.test(d)) {
    return 'Telegram · Active chat';
  }
  if (/^scanning open email:\s*/i.test(d)) {
    return 'Gmail · Open email';
  }
  if (/^scanning linkedin/i.test(d)) {
    if (/job/i.test(d)) return 'LinkedIn · Job post';
    return 'LinkedIn · Messages';
  }
  if (/linkedin · direct message/i.test(d)) return 'LinkedIn · Messages';

  return d;
}

function resolveResultRiskLevel(data) {
  const score = Number(data?.overall_risk_score) || 0;
  const apiRiskRaw = (data?.risk_level || 'SAFE').toString().trim().toUpperCase();
  const riskAliases = { MODERATE: 'MEDIUM', DANGER: 'HIGH', CRITICAL: 'EXTREME' };
  const apiRiskLevel = riskAliases[apiRiskRaw] || apiRiskRaw;
  const scoreRisk = score > 10;
  const apiRisk = ['MEDIUM', 'HIGH', 'EXTREME'].includes(apiRiskLevel);
  const isRisk = scoreRisk || apiRisk;
  return isRisk ? (apiRisk ? apiRiskLevel : 'HIGH') : 'SAFE';
}

/** Status line under "Content analyzed" — processed / safe / risk / failed. */
function buildScanProcessStatus(data) {
  if (data?.scan_status === 'processing') {
    return {
      text: 'Processing — AI is analyzing this content…',
      level: 'processing'
    };
  }

  if (data?.error || data?.scan_status === 'error') {
    const isBackend =
      /failed to analyze|backend|network|fetch|localhost|cannot reach/i.test(
        String(data.error || data.summary || '')
      );
    if (data.extraction_failed || data.extraction_hint) {
      return {
        text: data.extraction_hint || data.error || 'Not processed — content could not be read',
        level: 'error'
      };
    }
    return {
      text: isBackend
        ? 'Failed — could not reach the analysis server'
        : 'Failed — content could not be read or analyzed',
      level: 'error'
    };
  }

  const desc = (data?.scan_description || '').toLowerCase();
  const hasResult =
    data?.overall_risk_score != null ||
    data?.risk_level != null ||
    data?.summary != null;

  if (!hasResult) {
    if (data?.extraction_hint) {
      return { text: data.extraction_hint, level: 'error' };
    }
    if (/no messages|open a chat|could not read|scroll|select a job|job description/i.test(desc)) {
      return { text: 'Not processed — content could not be read from this page', level: 'error' };
    }
    if (/analyzing/i.test(desc)) {
      return { text: 'Processing — preparing content for analysis…', level: 'processing' };
    }
    return { text: 'Waiting — scan to analyze this content', level: 'info' };
  }

  const visualLevel = resolveResultRiskLevel(data);
  const scamLabel = deriveScamTypeLabel(data, visualLevel);

  if (visualLevel === 'SAFE') {
    return {
      text: 'Processed · Looks safe — no major scam signals detected',
      level: 'safe'
    };
  }
  if (visualLevel === 'MEDIUM') {
    return {
      text: `Processed · Caution advised — ${scamLabel}`,
      level: 'medium'
    };
  }
  return {
    text: `Processed · High risk — ${scamLabel}`,
    level: 'high'
  };
}

function truncateText(text, maxLen) {
  const s = (text || '').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

function getSourceLineForDisplay(data) {
  const platform = data?.scan_platform || '';
  const rawDesc = (data?.scan_description || '').trim();
  const isJob = isLinkedInJobResult(data);
  const desc = isJob ? 'LinkedIn · Job post' : normalizeScanDescription(rawDesc, platform);
  let title = (data?.scan_source_title || '').trim();
  if (!title) title = extractLegacyScanTitle(rawDesc);
  if (desc && title) return `${desc} · ${truncateText(title, 48)}`;
  return desc || truncateText(title, 56) || 'Web page';
}

function setScanBusy(busy) {
  const scanButton = document.getElementById('scanButton');
  const loading = document.getElementById('loading');
  const scanLabel = scanButton?.querySelector('.scan-button__label');
  const scanIcon = scanButton?.querySelector('.scan-button__icon');

  if (loading) loading.hidden = true;

  if (!scanButton) return;

  scanButton.hidden = false;
  scanButton.disabled = Boolean(busy);
  scanButton.classList.toggle('scan-button--busy', Boolean(busy));

  if (busy) {
    if (scanIcon) scanIcon.hidden = true;
    if (scanLabel) scanLabel.textContent = 'Analyzing content…';
  } else if (scanIcon) {
    scanIcon.hidden = false;
  }
}

function syncScanButtonLabel() {
  const scanLabel = document.querySelector('.scan-button__label');
  const hasResult = document.querySelector('.popup-container')?.classList.contains('popup-container--has-result');
  if (scanLabel) {
    scanLabel.textContent = hasResult ? 'Scan again' : 'Scan current tab';
  }
}

function setPostScanCompactMode(active) {
  const container = document.querySelector('.popup-container');
  const scanLabel = document.querySelector('.scan-button__label');
  if (active) {
    container?.classList.add('popup-container--has-result');
    if (scanLabel) scanLabel.textContent = 'Scan again';
  } else {
    container?.classList.remove('popup-container--has-result');
    if (scanLabel) scanLabel.textContent = 'Scan current tab';
  }
}

function scrollToVerdict() {
  const tab = document.querySelector('#scan-tab.tab-content');
  if (tab) tab.scrollTo({ top: 0, behavior: 'smooth' });
  const banner = document.getElementById('verdictBanner');
  if (banner && !banner.hidden) {
    banner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function updateVerdictBanner(data, options = {}) {
  const banner = document.getElementById('verdictBanner');
  const badgeEl = document.getElementById('verdictRiskBadge');
  const typeEl = document.getElementById('verdictScamType');
  const lineEl = document.getElementById('verdictOneLiner');
  const scoreEl = document.getElementById('verdictScore');
  const sourceEl = document.getElementById('verdictSource');
  if (!banner || !badgeEl || !typeEl) return;

  if (options.hide) {
    banner.hidden = true;
    return;
  }

  const sourceLine = getSourceLineForDisplay(data);
  if (sourceEl) sourceEl.textContent = sourceLine;

  if (data?.error === 'quota_exceeded') {
    banner.dataset.level = 'EXTREME';
    badgeEl.textContent = 'LIMIT';
    badgeEl.dataset.level = 'EXTREME';
    typeEl.textContent = 'Daily scan limit reached';
    if (lineEl) lineEl.textContent = data.message || 'Try again after midnight UTC';
    const limit = Number(data?.usage?.scansLimit || data?.scansLimit);
    if (scoreEl) {
      scoreEl.textContent = limit > 0 ? `${limit} scans per day` : 'Daily limit reached';
    }
    banner.classList.remove('verdict-banner--pulse');
    banner.hidden = false;
    scrollToVerdict();
    return;
  }

  if (data?.error === 'ai_rate_limited') {
    banner.dataset.level = 'MEDIUM';
    badgeEl.textContent = 'BUSY';
    badgeEl.dataset.level = 'MEDIUM';
    typeEl.textContent = 'Analysis temporarily unavailable';
    if (lineEl) {
      lineEl.textContent = truncateText(
        data.message ||
          'Our analysis service is temporarily busy. Please wait and try again.',
        120
      );
    }
    if (scoreEl) {
      scoreEl.textContent = data.retryAfterText ? `Retry ${data.retryAfterText}` : 'Try later';
    }
    banner.classList.remove('verdict-banner--pulse');
    banner.hidden = false;
    scrollToVerdict();
    return;
  }

  if (data?.error || data?.scan_status === 'error') {
    const isBackend =
      /failed to analyze|backend|network|fetch|localhost|cannot reach|status 400|status 402/i.test(
        String(data.error || data.summary || '')
      );
    banner.dataset.level = 'EXTREME';
    badgeEl.textContent = 'ERROR';
    badgeEl.dataset.level = 'EXTREME';
    typeEl.textContent = isBackend ? 'Connection Error' : 'Scan Failed';
    if (lineEl) {
      lineEl.textContent = truncateText(
        data.extraction_hint || data.error || messageFromData(data),
        100
      );
    }
    if (scoreEl) scoreEl.textContent = '—';
    banner.classList.remove('verdict-banner--pulse');
    banner.hidden = false;
    scrollToVerdict();
    return;
  }

  if (data?.scan_status === 'processing') {
    banner.dataset.level = 'processing';
    badgeEl.textContent = '…';
    badgeEl.dataset.level = 'SAFE';
    typeEl.textContent = 'Analyzing…';
    if (lineEl) lineEl.textContent = 'Please wait while AI checks this content';
    if (scoreEl) scoreEl.textContent = '';
    banner.classList.remove('verdict-banner--pulse');
    banner.hidden = false;
    return;
  }

  const visualLevel = resolveResultRiskLevel(data);
  const scamLabel = deriveScamTypeLabel(data, visualLevel);
  const displayScore = computeDisplayScore(data);

  let badgeText = 'SAFE';
  let oneLiner = truncateText(data.summary, 100) || 'Looks safe — no major scam signals detected';

  if (visualLevel === 'MEDIUM') {
    badgeText = 'CAUTION';
    oneLiner =
      truncateText(data.summary, 100) || 'Possible scam — review before you reply or click links';
  } else if (visualLevel === 'HIGH' || visualLevel === 'EXTREME') {
    badgeText = 'HIGH RISK';
    oneLiner =
      truncateText(data.summary, 100) ||
      'Likely scam — do not send money, codes, or personal information';
  }

  banner.dataset.level = visualLevel;
  badgeEl.textContent = badgeText;
  badgeEl.dataset.level = visualLevel;
  typeEl.textContent = scamLabel;
  if (lineEl) lineEl.textContent = oneLiner;
  if (scoreEl) scoreEl.textContent = `Score ${displayScore}`;

  banner.classList.remove('verdict-banner--pulse');
  if (visualLevel === 'HIGH' || visualLevel === 'EXTREME') {
    void banner.offsetWidth;
    banner.classList.add('verdict-banner--pulse');
  }

  banner.hidden = false;
  scrollToVerdict();
}

function messageFromData(data) {
  return typeof data?.error === 'string' ? data.error : '';
}

function setScanSourceDisplay(data) {
  const box = document.getElementById('scanSourceBox');
  const headingEl = document.getElementById('scanSourceHeading');
  const titleEl = document.getElementById('scanSourceTitle');
  const metaEl = document.getElementById('scanSourceMeta');
  const statusEl = document.getElementById('scanSourceStatus');

  if (!box || !headingEl) return;

  const platform = data?.scan_platform || '';
  const rawDesc = (data?.scan_description || '').trim();
  const isJob = isLinkedInJobResult(data);
  const desc = isJob
    ? 'LinkedIn · Job post'
    : normalizeScanDescription(rawDesc, platform);
  if (!desc) {
    box.hidden = true;
    return;
  }

  let title = (data?.scan_source_title || '').trim();
  if (!title) title = extractLegacyScanTitle(rawDesc);
  const messageCount = isJob ? 0 : Number(data?.message_count) || 0;

  headingEl.textContent = desc;

  if (title) {
    titleEl.textContent = title;
    titleEl.hidden = false;
  } else {
    titleEl.textContent = '';
    titleEl.hidden = true;
  }

  const metaParts = [];
  if (linkedInJobExtractionSucceeded(data)) {
    metaParts.push('Job description analyzed');
  } else if (isLinkedInJobResult(data) && (data?.error || data?.extraction_failed)) {
    metaParts.push('Job description not loaded yet');
  } else if (messageCount > 0) {
    metaParts.push(`${messageCount} message${messageCount === 1 ? '' : 's'}`);
  }
  if (metaParts.length) {
    metaEl.textContent = metaParts.join(' · ');
    metaEl.hidden = false;
  } else {
    metaEl.textContent = '';
    metaEl.hidden = true;
  }

  if (statusEl) {
    statusEl.hidden = true;
  }

  box.dataset.status =
    data?.scan_status === 'processing' ? 'processing' : resolveResultRiskLevel(data);
  box.hidden = false;
}

function displayResults(data) {
  if (data.error) {
    destroyScoreChart();
    if (isQuotaExceededResponse(data)) {
      refreshUsageDisplay();
      return;
    } else if (isAiRateLimitResponse(data)) {
      const usage = data._usage || data.usage;
      if (usage) updateUsageUI(usage);
      else refreshUsageDisplay();
      displayAiRateLimitError(data);
    } else if (isDeviceErrorResponse(data)) {
      displayError(
        data.message || 'Reload the extension at chrome://extensions and try again.',
        data.scan_description,
        { error: 'device_error', ...data }
      );
    } else {
      displayError(data.error, data.scan_description, data);
    }
    clearPageHighlights();
    return;
  }

  const visualLevel = resolveResultRiskLevel(data);
  const displayScore = computeDisplayScore(data);
  const scoreValue = document.getElementById('scoreValue');

  updateVerdictBanner(data);
  setScanSourceDisplay(data);
  setPostScanCompactMode(true);

  scoreValue.textContent = displayScore;
  scoreValue.setAttribute('data-level', visualLevel);

  setScamTypeLabel(deriveScamTypeLabel(data, visualLevel), visualLevel);

  const riskBadge = document.getElementById('riskBadge');
  riskBadge.textContent = visualLevel;
  riskBadge.setAttribute('data-level', visualLevel);

  const categories = data.categories || {};
  updateCategoryLevel('fearLevel', categories.fear_manipulation);
  updateCategoryLevel('urgencyLevel', categories.urgency_tactics);
  updateCategoryLevel('authorityLevel', categories.authority_abuse);
  updateCategoryLevel('trustLevel', categories.trust_engineering);
  updateCategoryLevel('scarcityLevel', categories.fake_scarcity);
  updateCategoryLevel('phishingLevel', categories.phishing_signals);
  updateCategoryLevel('recruiterLevel', categories.fake_recruiter_signals);
  updateCategoryLevel('aiLevel', categories.ai_generated_content);

  document.getElementById('summaryText').textContent = data.summary || 'No summary available.';
  document.getElementById('recommendationText').textContent =
    data.recommendation || 'No recommendation available.';

  updateRiskChart(data, displayScore, visualLevel);
}

function sendHighlightMessage(data) {
  if (!data || !Array.isArray(data.dangerous_sentences)) {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      return;
    }

    chrome.tabs.sendMessage(
      tabs[0].id,
      {
        action: 'highlightSentences',
        sentences: data.dangerous_sentences,
        score: data.overall_risk_score || 0
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('Highlight message failed:', chrome.runtime.lastError.message);
        } else {
          console.log('Highlight message response:', response);
        }
      }
    );
  });
}

function clearPageHighlights() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      return;
    }

    chrome.tabs.sendMessage(
      tabs[0].id,
      {
        action: 'highlightSentences',
        sentences: [],
        score: 0
      },
      () => {}
    );
  });
}

function updateCategoryLevel(elementId, level) {
  const element = document.getElementById(elementId);
  if (!element) return;
  const raw = (level || 'LOW').toString().trim().toUpperCase();
  const normalized = ['LOW', 'MEDIUM', 'HIGH'].includes(raw) ? raw : 'LOW';
  element.textContent = normalized;
  element.setAttribute('data-level', normalized);
}

function displayAiRateLimitError(data) {
  destroyScoreChart();
  const message =
    data?.message ||
    'Our analysis service is temporarily busy. Your scan was not counted. Please try again in a few minutes.';
  const payload = {
    ...(data || {}),
    error: 'ai_rate_limited',
    message,
    scan_description: data?.scan_description,
    scan_status: 'error'
  };

  updateVerdictBanner(payload);
  setPostScanCompactMode(true);
  setScanSourceDisplay({
    ...payload,
    error: '',
    scan_status: 'error'
  });

  setScamTypeLabel('Try Again Soon', 'MEDIUM');
  document.getElementById('scoreValue').textContent = '—';
  document.getElementById('riskBadge').textContent = 'WAIT';
  document.getElementById('riskBadge').setAttribute('data-level', 'MEDIUM');

  document.getElementById('summaryText').textContent = message;
  document.getElementById('recommendationText').textContent = data?.retryAfterText
    ? `This scan did not use your daily limit. Please try again in ${data.retryAfterText}.`
    : 'This scan did not use your daily limit. Please try again in a few minutes.';
}

function displayError(message, scanDescription, data) {
  destroyScoreChart();
  const payload = {
    ...(data || {}),
    error: data?.error || message,
    scan_description: scanDescription || data?.scan_description,
    scan_status: 'error'
  };

  if (data?.error === 'quota_exceeded' || data?.error === 'ai_rate_limited') {
    return;
  }

  const extractionFailed =
    data?.extraction_failed ||
    /no text found|no linkedin messages|no job description/i.test(message || '');

  updateVerdictBanner({
    ...payload,
    extraction_hint: data?.extraction_hint || message,
    extraction_failed: extractionFailed
  });
  setPostScanCompactMode(true);

  setScanSourceDisplay({
    scan_description: scanDescription || data?.scan_description || 'Unable to complete scan',
    scan_source_title: data?.scan_source_title || '',
    scan_platform: data?.scan_platform || '',
    linkedin_content_type: data?.linkedin_content_type || '',
    extraction_hint: data?.extraction_hint || message,
    extraction_failed: extractionFailed,
    error: extractionFailed ? '' : message,
    scan_status: 'error'
  });

  const isBackend =
    /failed to analyze|backend|network|fetch|localhost/i.test(message || '') ||
    /failed to analyze|backend|network|fetch|localhost/i.test(scanDescription || '');
  const isJob =
    data?.linkedin_content_type === 'job' || /linkedin · job/i.test(scanDescription || '');
  setScamTypeLabel(
    isBackend ? 'Connection Error' : isJob ? 'Job Not Loaded' : 'Could Not Read Chat',
    'EXTREME'
  );

  document.getElementById('scoreValue').textContent = 'ERROR';
  document.getElementById('riskBadge').textContent = 'ERROR';
  document.getElementById('riskBadge').setAttribute('data-level', 'EXTREME');

  const categoryIds = [
    'fearLevel',
    'urgencyLevel',
    'authorityLevel',
    'trustLevel',
    'scarcityLevel',
    'phishingLevel',
    'recruiterLevel',
    'aiLevel'
  ];
  categoryIds.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = 'ERROR';
    element.setAttribute('data-level', 'ERROR');
  });

  const summary = data?.extraction_hint || message;
  document.getElementById('summaryText').textContent = summary;
  document.getElementById('recommendationText').textContent = data?.extraction_hint
    ? 'Open the full job description (click Show more if needed), wait for the page to finish loading, then scan again.'
    : scanDescription
      ? `${scanDescription} Then try scanning again.`
      : 'Please check your connection and try again.';
}
