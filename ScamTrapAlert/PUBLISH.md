# ScamTrapAlert — Publish to Chrome Web Store

Step-by-step plan. **Done in repo** vs **you must do** is marked on each step.

---

## Overview

| Phase | What | Who |
|-------|------|-----|
| A | Backend on HTTPS (Render) | **You** deploy; repo has `render.yaml` |
| B | Extension store package | **You** run one command after deploy |
| C | Privacy policy online | **You** host `docs/privacy-policy.html` |
| D | Chrome Web Store listing | **You** ($5 account + upload ZIP) |

---

## Phase A — Deploy backend (you)

### Step A1 — Groq API key

1. Go to [Groq Console](https://console.groq.com/).
2. Create an API key.
3. Keep it secret — only set it on Render, never in the extension.

### Step A2 — Deploy to Render

1. Push this repo to GitHub (if not already).
2. [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint** (or **Web Service**).
3. Connect the repo; set **Root Directory** to `backend`.
4. Render reads `render.yaml` in the repo root (or configure manually):
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment variables:**
     - `GROQ_API_KEY` = your key
     - `FREE_DAILY_SCAN_LIMIT` = `15` (or your choice)
     - `NODE_ENV` = `production`
5. After deploy, copy your service URL, e.g. `https://scamtrapalert-api.onrender.com`.

### Step A3 — Verify backend

Open in browser:

- `https://YOUR-URL.onrender.com/health` → should show `{"status":"ok",...}`

### Step A4 — Persistent quota (recommended)

Free Render disks reset on redeploy. For stable daily limits:

- Add a **Render Disk** mounted at `/opt/render/project/src/backend/data`, **or**
- Later move quota to Redis/Postgres.

Until then, quotas may reset when Render redeploys — acceptable for early beta.

---

## Phase B — Build extension ZIP (you, one command)

Replace `YOUR-URL` with your real Render URL (no trailing slash).

**PowerShell (from repo root):**

```powershell
$env:SCAMTRAP_API_URL = "https://YOUR-URL.onrender.com"
node scripts/build-store-package.js
```

**Output:** `release/scamtrapalert-extension/` — folder ready to zip.

**Zip for upload:**

```powershell
Compress-Archive -Path "release\scamtrapalert-extension\*" -DestinationPath "release\scamtrapalert-extension.zip" -Force
```

### Local development (keep using localhost)

In `extension/config.js` set:

```javascript
const SCAMTRAP_DEV_MODE = true;
```

Reload extension in `chrome://extensions`. Backend: `cd backend && npm start`.

Before building for the store, set `SCAMTRAP_DEV_MODE = false` (the build script also forces production URL).

---

## Phase C — Privacy policy online (you)

1. Open `docs/privacy-policy.html`.
2. Replace `YOUR_CONTACT_EMAIL@example.com` with your email.
3. Host the file publicly, for example:
   - GitHub Pages (enable on repo → copy URL to `docs/privacy-policy.html`)
   - Netlify drop
   - Your own website
4. Test the URL in an incognito window — Chrome reviewers must open it.

Save that URL for the store listing.

---

## Phase D — Chrome Web Store (you)

### Step D1 — Developer account

1. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Pay **one-time $5** registration fee.
3. Complete identity verification if asked.

### Step D2 — Upload package

1. **New item** → upload `release/scamtrapalert-extension.zip`.
2. Do **not** upload the whole repo or `backend/` folder.

### Step D3 — Store listing (copy ideas)

- **Name:** ScamTrapAlert
- **Short description:** AI-powered scam and phishing detection for WhatsApp Web, Gmail, LinkedIn, and more.
- **Category:** Productivity or Privacy & Security
- **Screenshots:** At least 1 (1280×800). Capture popup + scan result on WhatsApp or Gmail.
- **Privacy policy:** URL from Phase C

### Step D4 — Permission justifications (paste/adapt)

| Permission | Justification |
|------------|----------------|
| `activeTab` / `tabs` / `scripting` | Read page text only when the user clicks Scan or enables auto-scan on the active tab. |
| `storage` | Save settings, scan history, and anonymous device ID for daily scan quota. |
| `notifications` | Optional alerts for high-risk scans. |
| Host permissions (WhatsApp, LinkedIn, Gmail) | Extract messages from supported sites the user is viewing. |
| `<all_urls>` content script | Inject scan UI and highlights on pages where the user runs a scan. |
| Backend host | Send selected text to our server for AI analysis; API key stays on server. |

### Step D5 — Single purpose

> Help users detect scams, phishing, and manipulation in text on web pages they choose to scan.

### Step D6 — Submit for review

Review often takes **1–7 days**. You may get questions about broad site access and data handling — answer using your privacy policy.

---

## What is already done in the repo

- [x] `extension/config.js` — dev vs production mode
- [x] `scripts/build-store-package.js` — production ZIP folder
- [x] `extension/icons/` — 16, 48, 128 PNGs
- [x] `extension/manifest.json` — icons + cleaned name (store build strips localhost)
- [x] `docs/privacy-policy.html` — template to host
- [x] `render.yaml` — Render deploy template
- [x] `backend/.gitignore` — ignores `.env` and `data/`

---

## Checklist before submit

- [ ] Backend `/health` works on HTTPS
- [ ] Built ZIP with **your** `SCAMTRAP_API_URL`
- [ ] Tested unpacked build from `release/scamtrapalert-extension/` (Load unpacked)
- [ ] Privacy policy URL live
- [ ] Screenshots + descriptions ready
- [ ] `GROQ_API_KEY` never committed to git

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extension says "Cannot reach AI server" | Wrong `SCAMTRAP_API_URL`; rebuild ZIP; check Render service is running |
| Quota resets daily for everyone | Render redeploy cleared `data/` — add disk or database |
| Review rejected for `<all_urls>` | Narrow `matches` in manifest to specific sites (more work, easier approval) |
| Groq 429 errors | Wait or upgrade Groq plan; backend refunds scan on 429 |

---

## Order of operations (quick)

1. Deploy backend → get URL  
2. `$env:SCAMTRAP_API_URL = "https://..."; node scripts/build-store-package.js`  
3. Zip `release/scamtrapalert-extension/`  
4. Host privacy policy  
5. Upload to Chrome Web Store  
