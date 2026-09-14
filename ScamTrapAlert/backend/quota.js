// Daily scan quota per anonymous device ID (no sign-in required)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const FREE_DAILY_SCAN_LIMIT = parseInt(process.env.FREE_DAILY_SCAN_LIMIT || '10', 10);

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getTodayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function getMidnightUtcIso() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

function getUsageToday(deviceId) {
  if (!deviceId) return 0;
  const usage = readJson(USAGE_FILE, {});
  const today = getTodayUtc();
  return usage[deviceId]?.[today] || 0;
}

function getUsageStatus(deviceId) {
  const used = getUsageToday(deviceId);
  return {
    scansUsed: used,
    scansLimit: FREE_DAILY_SCAN_LIMIT,
    scansRemaining: Math.max(0, FREE_DAILY_SCAN_LIMIT - used),
    resetsAt: getMidnightUtcIso()
  };
}

function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.trim().length >= 8;
}

function tryConsumeScan(deviceId) {
  if (!isValidDeviceId(deviceId)) {
    return { ok: false, invalidDevice: true, ...getUsageStatus('') };
  }
  deviceId = deviceId.trim();

  const usage = readJson(USAGE_FILE, {});
  const today = getTodayUtc();
  const used = usage[deviceId]?.[today] || 0;

  if (used >= FREE_DAILY_SCAN_LIMIT) {
    return { ok: false, ...getUsageStatus(deviceId) };
  }

  if (!usage[deviceId]) usage[deviceId] = {};
  usage[deviceId][today] = used + 1;
  writeJson(USAGE_FILE, usage);

  return { ok: true, ...getUsageStatus(deviceId) };
}

/** Undo one scan for today when AI fails after quota was consumed (e.g. Groq rate limit). */
function refundLastScan(deviceId) {
  if (!isValidDeviceId(deviceId)) return getUsageStatus('');
  deviceId = deviceId.trim();

  const usage = readJson(USAGE_FILE, {});
  const today = getTodayUtc();
  const used = usage[deviceId]?.[today] || 0;
  if (used <= 0) return getUsageStatus(deviceId);

  usage[deviceId][today] = used - 1;
  if (usage[deviceId][today] <= 0) delete usage[deviceId][today];
  if (Object.keys(usage[deviceId] || {}).length === 0) delete usage[deviceId];
  writeJson(USAGE_FILE, usage);

  return getUsageStatus(deviceId);
}

module.exports = {
  getUsageStatus,
  tryConsumeScan,
  refundLastScan,
  isValidDeviceId,
  FREE_DAILY_SCAN_LIMIT
};
