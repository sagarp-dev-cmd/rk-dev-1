// Backend API — see PUBLISH.md for Chrome Web Store build
//
// Local dev:  SCAMTRAP_DEV_MODE = true  → http://localhost:3000
// Store build: run scripts/build-store-package.js (sets production URL)

const SCAMTRAP_DEV_MODE = true;

const SCAMTRAP_PRODUCTION_API = 'https://REPLACE-WITH-YOUR-RENDER-URL.onrender.com';

const BACKEND_BASE = SCAMTRAP_DEV_MODE
  ? 'http://localhost:3000'
  : SCAMTRAP_PRODUCTION_API;
