// background.js - Service worker for ScamTrapAlert Chrome extension
// Routes popup <-> content script, backend analyze, optional auto-scan on tab load

importScripts('config.js', 'lib/device.js');

const AUTO_SCAN_DEBOUNCE_MS = 15000;

const autoScanDebounce = new Map();

function isScannableUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['autoScan', 'sensitivity'], (data) => {
      resolve({
        autoScan: !!data.autoScan,
        sensitivity: data.sensitivity || 'medium'
      });
    });
  });
}

function buildAnalyzePayload(text) {
  const max = 3000;
  if (text.length <= max) return text;
  return text.substring(0, max);
}

async function analyzeText(text, sensitivity, platform, deviceIdHint) {
  const deviceId = await ensureDeviceId(deviceIdHint);
  const response = await fetch(`${BACKEND_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: buildAnalyzePayload(text),
      sensitivity: sensitivity || 'medium',
      platform: platform || '',
      deviceId
    })
  });

  const data = await response.json().catch(() => ({}));

  const quotaErr = normalizeQuotaError(data, response.status);
  if (quotaErr) {
    if (quotaErr.usage) await saveLocalUsageStatus(quotaErr.usage);
    return quotaErr;
  }

  if (!response.ok) {
    if (data.error === 'ai_rate_limited') {
      if (data.usage) await saveLocalUsageStatus(data.usage);
      return {
        error: 'ai_rate_limited',
        message: data.message,
        retryAfterText: data.retryAfterText,
        retryAfterSeconds: data.retryAfterSeconds,
        _usage: data.usage
      };
    }
    throw new Error(data.message || data.error || `Backend request failed with status ${response.status}`);
  }

  if (data._usage) await saveLocalUsageStatus(data._usage);
  return data;
}

function updateBadgeForTab(tabId, data) {
  if (data && !data.error && typeof data.overall_risk_score === 'number') {
    const score = Math.max(0, Math.min(99, Math.round(data.overall_risk_score)));
    chrome.action.setBadgeText({ tabId, text: String(score) });
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: data.overall_risk_score >= 60 ? '#FF4757' : '#1E2D52'
    });
    return;
  }
  chrome.action.setBadgeText({ tabId, text: '' });
}

async function persistAutoScanResult(tabId, url, result, extractMeta) {
  const { autoScanResults = {} } = await chrome.storage.local.get('autoScanResults');
  autoScanResults[String(tabId)] = {
    url,
    result,
    extractMeta: extractMeta || {},
    ts: Date.now()
  };
  await chrome.storage.local.set({ autoScanResults });
}

async function clearAutoScanCacheForTab(tabId) {
  const { autoScanResults = {} } = await chrome.storage.local.get('autoScanResults');
  delete autoScanResults[String(tabId)];
  await chrome.storage.local.set({ autoScanResults });
}

function sendHighlights(tabId, data) {
  if (!data || data.error || !Array.isArray(data.dangerous_sentences)) {
    return;
  }
  chrome.tabs.sendMessage(
    tabId,
    {
      action: 'highlightSentences',
      sentences: data.dangerous_sentences,
      score: data.overall_risk_score || 0
    },
    () => void chrome.runtime.lastError
  );
}

function stripInternalExtractHeaders(text) {
  if (!text) return '';
  return text
    .replace(/^=== WhatsApp chat:[\s\S]*?(?=\n\[|You:|Contact:|$)/m, '')
    .replace(/^The lines below are the ONLY messages[\s\S]*?\n\n/m, '')
    .replace(/^Your summary must describe[\s\S]*?\n\n/m, '')
    .replace(/^If payment, QR code[\s\S]*?\n\n/m, '')
    .replace(/^=== LinkedIn conversation[\s\S]*?\n\n/m, '')
    .replace(/^Analyze ONLY these message lines\.\s*\n*/m, '')
    .trim();
}

function attachScanMeta(result, response) {
  if (!response) return result;
  const safePreview =
    response.extract_preview ||
    response.preview_text ||
    stripInternalExtractHeaders(response.text || '').substring(0, 280);
  const meta = {
    scan_description: response.scan_description || '',
    scan_platform: response.platform || '',
    scan_context: response.context || '',
    scan_source_title: response.scan_source_title || '',
    linkedin_content_type: response.linkedin_content_type || '',
    extraction_hint: response.extraction_hint || '',
    extract_preview: safePreview,
    message_count: response.message_count || 0,
    extraction_method: response.extraction_method || ''
  };
  if (result && typeof result === 'object') {
    return { ...result, ...meta };
  }
  return result;
}

async function injectFreshContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (e) {
    console.warn('content.js inject:', e?.message || e);
  }
}

function requestExtractText(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'extractText' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message, _needsInject: true });
        return;
      }
      resolve(response || { text: '' });
    });
  });
}

async function extractFromTab(tabId) {
  let response = await requestExtractText(tabId);
  if (response._needsInject) {
    await injectFreshContentScript(tabId);
    response = await requestExtractText(tabId);
  }
  if (response._needsInject) delete response._needsInject;
  return response;
}

async function scanTab(tabId, sensitivity, deviceIdHint) {
  const response = await extractFromTab(tabId);

  if (response?.error && !response.text) {
    return attachScanMeta(
      { error: 'Content script not available. Refresh the page, then scan again.' },
      response
    );
  }

  if (response && response.text && response.text.trim().length > 0) {
    const platformLower = (response.platform || '').toLowerCase();
    const isWhatsApp = platformLower === 'whatsapp';
    const isLinkedIn = platformLower === 'linkedin';
    let instruction = 'Analyze ONLY the conversation or document below. Ignore any other chats, sidebars, or pages.\n\n';
    if (isWhatsApp) {
      instruction =
        `You are analyzing ONE WhatsApp chat only (${response.scan_context || 'active chat'}). ` +
        'Use ONLY the message lines in the user text. ' +
        'If QR codes, payment requests, or suspicious links are NOT literally present in the text, do NOT mention them. ' +
        'Do not invent risks from other conversations.\n\n';
    } else if (isLinkedIn) {
      const isJob = response.linkedin_content_type === 'job' || /job post/i.test(response.scan_description || '');
      instruction = isJob
        ? `You are analyzing ONE LinkedIn job posting only (${response.scan_context || 'job'}). ` +
          'Use ONLY the job description provided. Flag fake job / recruiter scams only if supported by the text.\n\n'
        : `You are analyzing ONE LinkedIn message thread only (${response.scan_context || 'messages'}). ` +
          'Use ONLY the message lines provided. Do not mix in other chats or the inbox list.\n\n';
    }
    const prefix = response.scan_description
      ? `[${response.scan_description}]\n\n`
      : '';
    const budget = 3000 - instruction.length - prefix.length;
    const body = response.text.substring(0, Math.max(200, budget));
    const payload = instruction + prefix + body;

    try {
      const result = await analyzeText(payload, sensitivity, response.platform, deviceIdHint);
      if (
        result?.error === 'quota_exceeded' ||
        result?.error === 'device_error' ||
        result?.error === 'ai_rate_limited'
      ) {
        return attachScanMeta(result, response);
      }
      const full = attachScanMeta(result, response);
      full._extractMeta = {
        preview: response.extract_preview,
        message_count: response.message_count,
        scan_description: response.scan_description
      };
      return full;
    } catch (err) {
      const detail = err?.message || 'unknown error';
      const hint =
        detail.includes('fetch') || detail.includes('Failed')
          ? 'Cannot reach AI server. In backend folder run: npm start'
          : 'Failed to analyze text';
      return attachScanMeta({ error: `${hint} (${detail})` }, response);
    }
  }

  const extractHint = response.extraction_hint || response.scan_description || '';
  const linkedInMsg =
    /linkedin/i.test(response.platform || '') &&
    /message|conversation|thread/i.test(extractHint + (response.scan_description || ''));
  const jobHint =
    response.linkedin_content_type === 'job' ||
    (/linkedin/i.test(response.platform || '') &&
      /job|select a job/i.test(extractHint + (response.scan_description || '')));

  let errorMsg = 'No text found to analyze. Follow the hint below or open a chat/email.';
  if (jobHint) {
    errorMsg =
      response.extraction_hint ||
      'No job description found. Select a job from the list, wait for it to load, then scan.';
  } else if (linkedInMsg) {
    errorMsg =
      response.extraction_hint ||
      'No LinkedIn messages found. Open a conversation on the right, scroll the thread, then scan.';
  }

  return attachScanMeta({ error: errorMsg, extraction_failed: true }, response);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'clearTabCache') {
    const tabId = request.tabId;
    if (tabId != null) {
      clearAutoScanCacheForTab(tabId).then(() => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (request.action === 'getUsage') {
    fetchUsageStatus(request.deviceId)
      .then(({ usage, deviceId }) => sendResponse({ ok: !!usage, usage, deviceId }))
      .catch(async (err) => {
        const local = await getLocalUsageStatus();
        const deviceId = await ensureDeviceId(request.deviceId);
        sendResponse({ ok: true, usage: local, deviceId, fallback: true, error: err.message });
      });
    return true;
  }

  if (request.action !== 'scan') {
    return;
  }

  const sensitivity = request.sensitivity || 'medium';
  const forceFresh = !!request.forceFresh;

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs[0]) {
      sendResponse({ error: 'No active tab found' });
      return;
    }
    const tabId = tabs[0].id;
    const deviceId = await ensureDeviceId(request.deviceId);

    if (forceFresh) {
      await clearAutoScanCacheForTab(tabId);
    }

    const result = await scanTab(tabId, sensitivity, deviceId);
    updateBadgeForTab(tabId, result);

    if (result && !result.error && tabs[0].url) {
      await persistAutoScanResult(tabId, tabs[0].url, result, result._extractMeta);
    }

    sendResponse(result);
  });

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !isScannableUrl(tab.url)) return;

  getSettings().then(({ autoScan, sensitivity }) => {
    if (!autoScan) return;

    const key = `${tabId}|${tab.url}`;
    const now = Date.now();
    const last = autoScanDebounce.get(key) || 0;
    if (now - last < AUTO_SCAN_DEBOUNCE_MS) return;
    autoScanDebounce.set(key, now);

    scanTab(tabId, sensitivity).then(async (result) => {
      updateBadgeForTab(tabId, result);
      if (result && !result.error) {
        await persistAutoScanResult(tabId, tab.url, result, result._extractMeta);
        sendHighlights(tabId, result);
      }
    });
  });
});
