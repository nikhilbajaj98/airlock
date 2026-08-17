// Shared configuration for both consumer apps and the Airlock layer.
//
// Deliberately dependency-free: a hand-rolled 15-line .env reader instead of
// pulling in dotenv, so every line of this project is walkable start to finish.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Read .env into process.env without overwriting variables already exported in
// the shell. Missing file is fine — the shell may already have the key set.
function loadDotEnv() {
  let contents;
  try {
    contents = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

export const API_BASE = 'https://api.brightdata.com';

// The custom Scraper Studio collector built for this project ("airlock-books").
// Creation response is committed at example-output/create.json.
export const COLLECTOR_ID = process.env.AIRLOCK_COLLECTOR_ID || 'c_msxm9dky3p0ydhbm3';

export function requireApiKey() {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) {
    throw new Error(
      'BRIGHTDATA_API_KEY is not set. Export it in your shell or copy .env.example to .env.'
    );
  }
  return key;
}

// Book pages the collector was validated against. Used as demo defaults.
export const SAMPLE_URLS = {
  sapiens:
    'https://www.thriftbooks.com/w/from-animals-into-gods-a-brief-history-of-humankind_yuval-noah-harari/1015082/',
  orientExpress:
    'https://www.thriftbooks.com/w/murder-on-the-orient-express-by-agatha-christie/261456/',
};

export const DEFAULT_URL = SAMPLE_URLS.orientExpress;
