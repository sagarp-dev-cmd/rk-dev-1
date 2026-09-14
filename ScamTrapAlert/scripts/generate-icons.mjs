/**
 * Generate extension/icons/*.png from assets/icon128-source.png
 * Run: node scripts/generate-icons.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'icon128-source.png');
const OUT_DIR = path.join(ROOT, 'extension', 'icons');

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('Missing source image:', SOURCE);
    process.exit(1);
  }

  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('Install sharp: npm install sharp --save-dev');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sizes = [16, 48, 128];

  for (const size of sizes) {
    const out = path.join(OUT_DIR, `icon${size}.png`);
    await sharp(SOURCE).resize(size, size).png().toFile(out);
    console.log('Wrote', out);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
