// Last-known-good store — the "continuity" half of Airlock.
//
// Every row that passes validation is written here with the timestamp at which it
// was validated. When a later run fails validation, this is what gets served
// instead, so the consuming app shows slightly stale truth rather than fresh
// garbage, and never sees a gap.
//
// A JSON file on disk, keyed by book URL. Deliberately not a database: the store
// needs to be inspectable by hand during the demo, and small enough that its
// behaviour is obvious from reading it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.js';

// Overridable so tests can write to a throwaway directory instead of poisoning
// the store the demo reads from.
const STATE_DIR = process.env.AIRLOCK_STATE_DIR || join(REPO_ROOT, '.airlock-state');
const STORE_PATH = join(STATE_DIR, 'last-known-good.json');
const HEAL_LOG_PATH = join(STATE_DIR, 'heal-log.json');

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt state file must not take the consumer app down — that would be
    // the same failure mode Airlock exists to prevent.
    return fallback;
  }
}

// Write to a temp file then rename, so an interrupted write cannot leave a
// half-written store behind.
function writeJson(path, value) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tempPath, path);
}

/** The most recent validated row for a URL, or null if there has never been one. */
export function readLastKnownGood(url) {
  const store = readJson(STORE_PATH, {});
  return store[url] ?? null;
}

/** Record a row that has just passed validation. */
export function writeLastKnownGood(url, row, meta = {}) {
  const store = readJson(STORE_PATH, {});
  const entry = {
    row,
    validatedAt: new Date().toISOString(),
    collectorId: meta.collectorId ?? null,
    responseId: meta.responseId ?? null,
  };
  store[url] = entry;
  writeJson(STORE_PATH, store);
  return entry;
}

/** Append one heal attempt to the audit log. */
export function appendHealLog(entry) {
  const log = readJson(HEAL_LOG_PATH, []);
  log.push({ at: new Date().toISOString(), ...entry });
  writeJson(HEAL_LOG_PATH, log);
}

export function readHealLog() {
  return readJson(HEAL_LOG_PATH, []);
}

/**
 * When the last heal for this collector was triggered, in ms since epoch, or null.
 * Airlock uses this to avoid firing a fresh heal on every run while a previous
 * one is still settling — repeatedly healing a collector makes things worse, and
 * the AI-Flow job cap will reject the calls anyway.
 */
export function lastHealAt(collectorId) {
  const log = readHealLog();
  const relevant = log.filter((entry) => entry.collectorId === collectorId);
  if (relevant.length === 0) return null;
  return Date.parse(relevant[relevant.length - 1].at);
}

export const STORE_PATHS = { STATE_DIR, STORE_PATH, HEAL_LOG_PATH };
