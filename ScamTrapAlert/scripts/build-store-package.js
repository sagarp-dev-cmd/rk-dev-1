/**
 * Builds release/scamtrapalert-extension/ for Chrome Web Store upload.
 *
 * Usage (PowerShell):
 *   $env:SCAMTRAP_API_URL = "https://your-app.onrender.com"
 *   node scripts/build-store-package.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'release', 'scamtrapalert-extension');

const apiUrl = (process.env.SCAMTRAP_API_URL || '').trim().replace(/\/$/, '');

if (!apiUrl || !/^https:\/\/.+/i.test(apiUrl)) {
  console.error(
    'Set SCAMTRAP_API_URL to your deployed backend HTTPS URL, e.g.\n' +
      '  $env:SCAMTRAP_API_URL = "https://scamtrapalert-api.onrender.com"\n' +
      '  node scripts/build-store-package.js'
  );
  process.exit(1);
}

const SKIP = new Set(['manifest.dev.json']);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function writeConfig(destDir) {
  const content =
    '// Auto-generated for Chrome Web Store - do not edit by hand\n' +
    `const BACKEND_BASE = '${apiUrl}';\n`;
  fs.writeFileSync(path.join(destDir, 'config.js'), content, 'utf8');
}

function writeManifest(destDir) {
  const manifestPath = path.join(SRC, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  manifest.host_permissions = [
    `${apiUrl}/*`,
    'https://web.whatsapp.com/*',
    'https://www.linkedin.com/*',
    'https://mail.google.com/*'
  ];

  if (!manifest.icons) {
    console.warn('Warning: manifest.json has no icons block');
  }

  fs.writeFileSync(
    path.join(destDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );
}

function main() {
  if (fs.existsSync(OUT)) {
    fs.rmSync(OUT, { recursive: true, force: true });
  }

  copyDir(SRC, OUT);
  writeConfig(OUT);
  writeManifest(OUT);

  console.log('Store package built at:');
  console.log('  ' + OUT);
  console.log('API URL: ' + apiUrl);
  console.log('');
  console.log('Next: zip the folder and upload to Chrome Web Store.');
  console.log('  Compress-Archive -Path "release\\scamtrapalert-extension\\*" -DestinationPath "release\\scamtrapalert-extension.zip" -Force');
}

main();
