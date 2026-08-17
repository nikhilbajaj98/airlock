// Tests for the parts of Airlock that must be right without a network call:
// the validator, the heal-prompt generator, the heal status classifier, and the
// last-known-good store.
//
// Run with `npm test`. Uses node:test, so there is nothing to install.
//
// AIRLOCK_STATE_DIR is redirected to a temp directory before store.js is imported,
// so these tests never touch the store the demo reads from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'airlock-test-'));
process.env.AIRLOCK_STATE_DIR = stateDir;
process.env.BRIGHTDATA_API_KEY ??= 'test-key-not-used';

const { validateRow, validateResponse } = await import('../src/airlock/validator.js');
const { buildHealPrompt, PROMPT_MAX_LEN } = await import('../src/airlock/healPrompt.js');
const { classifyProgress, summarizeHeal } = await import('../src/airlock/heal.js');
const store = await import('../src/airlock/store.js');
const { RULES } = await import('../src/airlock/rules.js');

process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }));

const goodRow = {
  book_title: 'Murder on the Orient Express',
  author_name: 'Agatha Christie',
  price: { value: 5.79, currency: 'USD', symbol: '$' },
  availability_status: 'In Stock',
};

const failedRules = (row) => validateRow(row).failures.map((f) => f.rule).sort();

// --- validator -------------------------------------------------------------

test('a validated collector row passes every rule', () => {
  assert.equal(validateRow(goodRow).valid, true);
  assert.deepEqual(validateRow(goodRow).failures, []);
});

test('a dead price selector fails every rule that reads through price', () => {
  // This is the real failure shape: the whole price object comes back null, so
  // value, currency and symbol all go with it.
  assert.deepEqual(failedRules({ ...goodRow, price: null }), ['currency', 'price', 'symbol']);
});

test('a price missing only its symbol fails just the symbol rule', () => {
  // The shape a real heal proposed: a working price with the symbol dropped.
  const row = { ...goodRow, price: { value: 11.49, currency: 'USD' } };
  assert.deepEqual(failedRules(row), ['symbol']);
});

test('a price returned as a string fails, even when it looks right', () => {
  const row = { ...goodRow, price: { value: '5.79', currency: 'USD', symbol: '$' } };
  assert.deepEqual(failedRules(row), ['price']);
});

test('a zero or negative price fails', () => {
  assert.deepEqual(failedRules({ ...goodRow, price: { ...goodRow.price, value: 0 } }), ['price']);
  assert.deepEqual(failedRules({ ...goodRow, price: { ...goodRow.price, value: -3 } }), ['price']);
});

test('empty and whitespace-only strings fail', () => {
  assert.deepEqual(failedRules({ ...goodRow, book_title: '' }), ['title']);
  assert.deepEqual(failedRules({ ...goodRow, author_name: '   ' }), ['author']);
});

test('availability is matched case-insensitively but only against known values', () => {
  assert.equal(validateRow({ ...goodRow, availability_status: 'in stock' }).valid, true);
  assert.equal(validateRow({ ...goodRow, availability_status: 'OUT OF STOCK' }).valid, true);
  assert.deepEqual(failedRules({ ...goodRow, availability_status: 'Temporarily unavailable' }), [
    'availability',
  ]);
});

test('a null row fails every rule rather than silently passing', () => {
  const { valid, failures } = validateRow(null);
  assert.equal(valid, false);
  assert.equal(failures.length, RULES.length);
});

test('an empty response array is a failure, not an empty success', () => {
  const verdict = validateResponse([]);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, 'the collector returned no rows');
  assert.equal(verdict.failures.length, RULES.length);
});

test('the validator never throws on malformed input', () => {
  for (const input of [undefined, null, 'a string', 42, [], [[]], { price: 'not an object' }]) {
    assert.doesNotThrow(() => validateRow(input));
  }
});

// --- heal prompt -----------------------------------------------------------

test('the heal prompt names the broken field and what was expected', () => {
  const { failures } = validateRow({ ...goodRow, price: null });
  const prompt = buildHealPrompt(failures);

  assert.match(prompt, /price\.value/);
  assert.match(prompt, /number greater than 0/);
  // The parent object is what went null, and the prompt should say so.
  assert.match(prompt, /price is null/);
  // It must not invent complaints about fields that were fine.
  assert.doesNotMatch(prompt, /book_title/);
});

test('the heal prompt quotes the last-known-good value as evidence', () => {
  const { failures } = validateRow({ ...goodRow, price: null });
  const prompt = buildHealPrompt(failures, { row: goodRow });
  assert.match(prompt, /price\.value was 5\.79/);
});

test('the heal prompt stays within the API limit even when every rule fails', () => {
  const { failures } = validateRow(null);
  const prompt = buildHealPrompt(failures, { row: goodRow });
  assert.ok(
    prompt.length <= PROMPT_MAX_LEN,
    `prompt was ${prompt.length} chars, limit is ${PROMPT_MAX_LEN}`
  );
});

test('building a prompt with no failures is a programming error', () => {
  assert.throws(() => buildHealPrompt([]));
});

// --- heal status handling --------------------------------------------------

test('heal progress statuses classify the way the CLI classifies them', () => {
  assert.equal(classifyProgress({ status: 'done' }), 'done');
  assert.equal(classifyProgress({ status: 'pending_answer' }), 'awaiting_approval');
  assert.equal(classifyProgress({ status: 'failed' }), 'failed');
  assert.equal(classifyProgress({ status: 'error' }), 'failed');
  assert.equal(classifyProgress({ status: 'cancelled' }), 'failed');
  assert.equal(classifyProgress({ status: 'code_generator' }), 'running');
  assert.equal(classifyProgress({}), 'running');
  assert.equal(classifyProgress(null), 'running');
});

test('heal summary counts the correction loops Scraper Studio needed', () => {
  const summary = summarizeHeal({
    status: 'pending_answer',
    completed_steps: ['planner', 'code_generator', 'code_fixer', 'validator', 'code_fixer'],
    diff: { template_b: { steps: [1, 2, 3] } },
  });

  assert.equal(summary.stepCount, 5);
  assert.equal(summary.correctionLoops, 3);
  assert.equal(summary.proposedTemplateSteps, 3);
});

// --- last-known-good store -------------------------------------------------

test('the store round-trips a validated row', () => {
  const url = 'https://example.test/book/1';
  assert.equal(store.readLastKnownGood(url), null);

  const entry = store.writeLastKnownGood(url, goodRow, { collectorId: 'c_test' });
  const read = store.readLastKnownGood(url);

  assert.deepEqual(read.row, goodRow);
  assert.equal(read.collectorId, 'c_test');
  assert.equal(read.validatedAt, entry.validatedAt);
});

test('the store keeps entries per URL', () => {
  store.writeLastKnownGood('https://example.test/book/a', { ...goodRow, book_title: 'A' });
  store.writeLastKnownGood('https://example.test/book/b', { ...goodRow, book_title: 'B' });

  assert.equal(store.readLastKnownGood('https://example.test/book/a').row.book_title, 'A');
  assert.equal(store.readLastKnownGood('https://example.test/book/b').row.book_title, 'B');
});

test('the heal log records attempts and reports the most recent one', () => {
  store.appendHealLog({ collectorId: 'c_cooldown', prompt: 'first', failedRules: ['price'] });
  const at = store.lastHealAt('c_cooldown');

  assert.ok(typeof at === 'number' && Number.isFinite(at));
  assert.equal(store.lastHealAt('c_never_healed'), null);
});
