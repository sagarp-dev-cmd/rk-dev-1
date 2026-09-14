// server.js - Backend server for ScamTrapAlert Chrome extension
// Express: /health, /analyze (Groq)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const quota = require('./quota');

const app = express();

// Extensions call from chrome-extension:// origins; allow API from any origin for the public /health and /analyze routes.
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
  })
);
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error('Missing GROQ_API_KEY. Create backend/.env with GROQ_API_KEY=...');
  process.exit(1);
}

const BASE_SYSTEM_PROMPT =
  'You are ScamTrapAlert, an expert in detecting online scams, psychological manipulation, phishing, and social engineering. Analyze the provided text and return ONLY a valid JSON object with no extra text, no markdown, no code blocks, no explanation — just raw JSON exactly like this: {"overall_risk_score":0,"risk_level":"SAFE","scam_type":"No Clear Threat","categories":{"fear_manipulation":"LOW","urgency_tactics":"LOW","authority_abuse":"LOW","trust_engineering":"LOW","fake_scarcity":"LOW","phishing_signals":"LOW","fake_recruiter_signals":"LOW","ai_generated_content":"LOW"},"dangerous_sentences":[{"text":"exact sentence from input","reason":"why this is dangerous","manipulation_type":"type of manipulation"}],"summary":"2 to 3 sentence plain English explanation of findings","recommendation":"what the user should do"}' +
  ' The scam_type field is REQUIRED: a short plain-English headline (2–5 words) that instantly tells the user what kind of threat this is. Examples: "Phishing Attack", "Fake Job Offer", "Crypto Scam", "Romance Scam", "Payment Fraud", "Tech Support Scam", "Prize/Lottery Scam", "Impersonation Scam", "Urgency Pressure", "No Clear Threat" (use when risk is low/safe). Pick the single best match based on evidence in the text only.';

const SENSITIVITY_HINTS = {
  low: ' Sensitivity: LOW — be conservative; only flag clear manipulation or phishing. Prefer SAFE or low scores when ambiguous.',
  medium: ' Sensitivity: MEDIUM — balanced judgment.',
  high:
    ' Sensitivity: HIGH — flag suspicious or coercive patterns even when somewhat ambiguous; err toward higher category levels when in doubt.'
};

function sensitivitySettings(sensitivity) {
  const s = String(sensitivity || 'medium').toLowerCase();
  if (s === 'low') return { temperature: 0.05, hint: SENSITIVITY_HINTS.low };
  if (s === 'high') return { temperature: 0.28, hint: SENSITIVITY_HINTS.high };
  return { temperature: 0.12, hint: SENSITIVITY_HINTS.medium };
}

function parseAiJson(raw) {
  let s = String(raw).trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  return JSON.parse(s);
}

function parseGroqRetrySeconds(groqBody) {
  const msg = groqBody?.error?.message || '';
  const m = msg.match(/try again in (\d+)m([\d.]+)s/i);
  if (m) return Math.ceil(parseInt(m[1], 10) * 60 + parseFloat(m[2]));
  const s = msg.match(/try again in ([\d.]+)s/i);
  if (s) return Math.ceil(parseFloat(s[1]));
  return null;
} 

function formatRetryWait(seconds) {
  if (!seconds || seconds < 1) return 'a few minutes';
  if (seconds < 90) return `about ${seconds} seconds`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (!rem) return `about ${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `about ${hrs}h ${rem}m`;
}

function buildAiRateLimitPayload(groqBody, usageAfterRefund) {
  const retryAfterSeconds = parseGroqRetrySeconds(groqBody);
  const retryAfterText = formatRetryWait(retryAfterSeconds);
  return {
    error: 'ai_rate_limited',
    message: `Our analysis service is temporarily at capacity. Your scan was not counted. Please try again in ${retryAfterText}.`,
    retryAfterSeconds,
    retryAfterText,
    usage: usageAfterRefund
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', scansLimit: quota.FREE_DAILY_SCAN_LIMIT });
});

app.get('/usage', (req, res) => {
  const deviceId = String(req.query.deviceId || '').trim();
  if (!quota.isValidDeviceId(deviceId)) {
    return res.status(400).json({ error: 'deviceId required' });
  }
  res.json(quota.getUsageStatus(deviceId));
});

app.post('/analyze', async (req, res) => {
  try {
    const { text, sensitivity, platform, deviceId } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const deviceIdStr = String(deviceId || '').trim();
    if (!quota.isValidDeviceId(deviceIdStr)) {
      return res.status(400).json({
        error: 'device_id_required',
        message: 'Missing device ID. Reload the extension and try again.'
      });
    }

    const scanQuota = quota.tryConsumeScan(deviceIdStr);
    if (!scanQuota.ok) {
      return res.status(402).json({
        error: 'quota_exceeded',
        message: `Daily limit of ${scanQuota.scansLimit} scans reached`,
        usage: {
          scansUsed: scanQuota.scansUsed,
          scansLimit: scanQuota.scansLimit,
          scansRemaining: scanQuota.scansRemaining,
          resetsAt: scanQuota.resetsAt
        }
      });
    }

    const truncatedText = text.substring(0, 3000);
    const { temperature, hint } = sensitivitySettings(sensitivity);

    let platformHint = '';
    if (String(platform || '').toLowerCase() === 'whatsapp') {
      platformHint =
        ' The user text is from ONE open WhatsApp chat only. In summary and dangerous_sentences, use ONLY exact phrases from the input. ' +
        'Never mention QR codes, payments, or links unless they appear verbatim in the input. ' +
        'If the chat is low risk, say so clearly.';
    }
    if (String(platform || '').toLowerCase() === 'linkedin') {
      platformHint =
        ' The user text is from ONE LinkedIn conversation or job post. Use ONLY what is in the input. ' +
        'Do not invent payment requests or phishing unless literally present.';
    }

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: BASE_SYSTEM_PROMPT + hint + platformHint
          },
          {
            role: 'user',
            content: truncatedText
          }
        ],
        max_tokens: 1000,
        temperature
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiResponse = response.data.choices[0].message.content;
    const result = parseAiJson(aiResponse);
    res.json({
      ...result,
      _usage: {
        scansUsed: scanQuota.scansUsed,
        scansLimit: scanQuota.scansLimit,
        scansRemaining: scanQuota.scansRemaining,
        resetsAt: scanQuota.resetsAt
      }
    });
  } catch (error) {
    const groqStatus = error.response?.status;
    const groqBody = error.response?.data;

    if (groqStatus === 429) {
      const deviceIdStr = String(req.body?.deviceId || '').trim();
      const usageAfterRefund = quota.isValidDeviceId(deviceIdStr)
        ? quota.refundLastScan(deviceIdStr)
        : null;
      const payload = buildAiRateLimitPayload(groqBody, usageAfterRefund);
      console.warn('Groq rate limit (429):', groqBody?.error?.message || 'rate_limit_exceeded');
      return res.status(429).json(payload);
    }

    console.error('Error in /analyze:');
    if (error.response) {
      console.error('Groq status:', groqStatus);
      console.error('Groq response data:', groqBody);
    } else {
      console.error(error);
    }
    res.status(500).json({
      error: 'analysis_failed',
      message: 'Analysis could not be completed right now. Please try again in a few minutes.',
      details: groqBody || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`ScamTrapAlert backend running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
