// Device ID + daily scan quota helpers (works in popup and service worker)
// Scan limit comes from backend FREE_DAILY_SCAN_LIMIT (.env) via /health and /usage

function generateDeviceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'sr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function storageSet(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, resolve);
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function midnightUtcIso() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

function buildUsageStatus(used, limit) {
  const scansUsed = Math.max(0, Number(used) || 0);
  const scansLimit = Math.max(0, Number(limit) || 0);
  return {
    scansUsed,
    scansLimit,
    scansRemaining: scansLimit > 0 ? Math.max(0, scansLimit - scansUsed) : 0,
    resetsAt: midnightUtcIso()
  };
}

async function saveScanLimitConfig(scansLimit) {
  const n = Number(scansLimit);
  if (!n || n <= 0) return;
  await storageSet({ scanLimitConfig: { scansLimit: n } });
}

async function fetchScanLimitConfig() {
  try {
    const response = await fetch(`${BACKEND_BASE}/health`);
    if (!response.ok) return null;
    const data = await response.json();
    const limit = Number(data.scansLimit);
    if (limit > 0) {
      await saveScanLimitConfig(limit);
      return limit;
    }
  } catch (e) {
    console.warn('fetchScanLimitConfig:', e?.message || e);
  }
  return null;
}

async function resolveScanLimit(hint) {
  const fromHint = Number(hint);
  if (fromHint > 0) {
    await saveScanLimitConfig(fromHint);
    return fromHint;
  }

  const fetched = await fetchScanLimitConfig();
  if (fetched > 0) return fetched;

  const { scanLimitConfig } = await storageGet(['scanLimitConfig']);
  const cached = Number(scanLimitConfig?.scansLimit);
  if (cached > 0) return cached;

  return null;
}

async function enrichUsage(usage) {
  if (!usage) return usage;
  const limit = await resolveScanLimit(usage.scansLimit);
  if (!limit) return usage;
  const used = Number(usage.scansUsed) || 0;
  return {
    ...usage,
    scansLimit: limit,
    scansRemaining: Math.max(0, limit - used),
    resetsAt: usage.resetsAt || midnightUtcIso()
  };
}

async function ensureDeviceId(hint) {
  const fromHint = hint && String(hint).trim();
  if (fromHint && fromHint.length >= 8) {
    await storageSet({ deviceId: fromHint });
    return fromHint;
  }

  const data = await storageGet(['deviceId']);
  const stored = data.deviceId && String(data.deviceId).trim();
  if (stored && stored.length >= 8) {
    return stored;
  }

  const id = generateDeviceId();
  await storageSet({ deviceId: id });
  return id;
}

async function getLocalUsageStatus() {
  const { dailyScanUsage } = await storageGet(['dailyScanUsage']);
  const today = todayUtc();
  const used =
    !dailyScanUsage || dailyScanUsage.date !== today ? 0 : Number(dailyScanUsage.count) || 0;
  const limit = await resolveScanLimit(dailyScanUsage?.limit);
  return buildUsageStatus(used, limit);
}

async function saveLocalUsageStatus(usage) {
  if (!usage) return;
  const limit = Number(usage.scansLimit) || (await resolveScanLimit());
  await storageSet({
    dailyScanUsage: {
      date: todayUtc(),
      count: usage.scansUsed,
      limit: limit || usage.scansLimit
    }
  });
  if (limit > 0) await saveScanLimitConfig(limit);
}

async function fetchUsageStatus(deviceIdHint) {
  const deviceId = await ensureDeviceId(deviceIdHint);
  try {
    const response = await fetch(
      `${BACKEND_BASE}/usage?deviceId=${encodeURIComponent(deviceId)}`
    );
    if (response.ok) {
      const usage = await enrichUsage(await response.json());
      await saveLocalUsageStatus(usage);
      return { usage, deviceId };
    }
  } catch (e) {
    console.warn('fetchUsageStatus:', e?.message || e);
  }
  const local = await enrichUsage(await getLocalUsageStatus());
  return { usage: local, deviceId };
}

function normalizeQuotaError(data, status) {
  if (status === 402 || data?.error === 'quota_exceeded') {
    return {
      error: 'quota_exceeded',
      message: data?.message || 'Daily scan limit reached. Resets at midnight UTC.',
      usage: data?.usage || null
    };
  }
  if (status === 400 && data?.error === 'device_id_required') {
    return {
      error: 'device_error',
      message: data?.message || 'Device ID missing. Reload the extension and try again.'
    };
  }
  return null;
}

// Legacy name used by background.js
async function getOrCreateDeviceId() {
  return ensureDeviceId();
}
