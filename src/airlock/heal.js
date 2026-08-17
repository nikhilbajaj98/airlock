// Drives Scraper Studio's self-healing from application code.
//
// The `brightdata scraper heal` CLI command is a wrapper over three endpoints.
// Airlock calls them directly, because the whole point is that no human is at a
// terminal when a break is detected:
//
//   POST /dca/collectors/<id>/refactor_template            body {prompt, custom_input: []}
//   GET  /dca/collectors/<id>/refactor_template/progress   -> {status, step, completed_steps, diff}
//   POST /dca/collectors/<id>/resume_automation_job        body {message: true, auto_save: true}
//
// Progress statuses, matching the CLI's own interpretation:
//   'done'                                 -> finished successfully
//   'pending_answer'                       -> parked at the approval gate
//   'failed' | 'error' | 'cancelled'       -> terminally failed
//   anything else                          -> still working
//
// The trigger call can return 429 when the account is at its AI-Flow concurrent
// job cap. That is a wait-and-retry condition, not a failure, so it is retried
// with exponential backoff the way the CLI does.

import { COLLECTOR_ID } from '../config.js';
import { apiGet, apiPost } from '../http.js';

const DONE = 'done';
const AWAITING_APPROVAL = 'pending_answer';
const TERMINAL_FAILURES = ['failed', 'error', 'cancelled'];

const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 240000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Classify a progress payload into one of four outcomes. */
export function classifyProgress(progress) {
  const status = typeof progress?.status === 'string' ? progress.status : null;
  if (status === null) return 'running';
  if (status === DONE) return 'done';
  if (status === AWAITING_APPROVAL) return 'awaiting_approval';
  if (TERMINAL_FAILURES.includes(status)) return 'failed';
  return 'running';
}

/** Start a heal. Retries through the AI-Flow concurrent-job cap (429). */
export async function triggerHeal(prompt, options = {}) {
  const { collectorId = COLLECTOR_ID, maxRetries = 4, onEvent } = options;

  for (let attempt = 0; ; attempt += 1) {
    const { ok, status, text } = await apiPost(
      `/dca/collectors/${encodeURIComponent(collectorId)}/refactor_template`,
      { prompt, custom_input: [] }
    );

    if (ok) return { triggeredAt: new Date().toISOString(), attempts: attempt + 1 };

    const capReached = status === 429;
    if (!capReached || attempt >= maxRetries) {
      throw new Error(`refactor_template failed (HTTP ${status}): ${text}`);
    }

    const waitMs = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    if (onEvent) onEvent({ type: 'heal_cap_wait', waitMs, attempt: attempt + 1 });
    await sleep(waitMs);
  }
}

/** Read heal progress once. */
export async function readHealProgress(options = {}) {
  const { collectorId = COLLECTOR_ID } = options;
  const { ok, status, text, data } = await apiGet(
    `/dca/collectors/${encodeURIComponent(collectorId)}/refactor_template/progress`
  );

  if (!ok) throw new Error(`refactor_template/progress failed (HTTP ${status}): ${text}`);
  return data ?? {};
}

/**
 * Poll heal progress until it reaches a state that stops polling: done,
 * awaiting_approval, or failed.
 */
export async function awaitHeal(options = {}) {
  const {
    collectorId = COLLECTOR_ID,
    pollIntervalMs = 5000,
    timeoutMs = 600000,
    onEvent,
  } = options;

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const progress = await readHealProgress({ collectorId });
    const outcome = classifyProgress(progress);

    if (outcome !== 'running') return { outcome, progress };

    if (Date.now() >= deadline) {
      throw new Error(`Heal on ${collectorId} did not settle within ${timeoutMs}ms`);
    }

    if (onEvent) {
      onEvent({
        type: 'heal_progress',
        step: progress.step ?? 'pending',
        completedSteps: progress.completed_steps ?? [],
      });
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Answer the approval gate, then poll on to the next settled state.
 * `approve: false` rejects the proposed change instead.
 */
export async function resumeHeal(options = {}) {
  const {
    collectorId = COLLECTOR_ID,
    approve = true,
    autoSave = true,
    pollIntervalMs,
    timeoutMs,
    onEvent,
  } = options;

  // auto_save only means anything on approval; the API ignores it on a reject.
  const body = approve && autoSave ? { message: true, auto_save: true } : { message: approve };

  const { ok, status, text } = await apiPost(
    `/dca/collectors/${encodeURIComponent(collectorId)}/resume_automation_job`,
    body
  );
  if (!ok) throw new Error(`resume_automation_job failed (HTTP ${status}): ${text}`);

  if (onEvent) onEvent({ type: approve ? 'heal_approved' : 'heal_rejected' });

  return awaitHeal({ collectorId, pollIntervalMs, timeoutMs, onEvent });
}

/**
 * Signals Scraper Studio itself reports about a heal. Surfaced here because they
 * are what the stretch-goal risk scorer would judge an awaiting-approval heal on:
 * how much correction the flow needed, and how large the proposed change is.
 */
export function summarizeHeal(progress) {
  const completedSteps = Array.isArray(progress?.completed_steps) ? progress.completed_steps : [];
  const proposedSteps = Array.isArray(progress?.diff?.template_b?.steps)
    ? progress.diff.template_b.steps.length
    : null;

  return {
    status: progress?.status ?? null,
    completedSteps,
    stepCount: completedSteps.length,
    correctionLoops: completedSteps.filter((step) => /code_fixer|validator/i.test(String(step)))
      .length,
    proposedTemplateSteps: proposedSteps,
  };
}

export const HEAL_STATUSES = { DONE, AWAITING_APPROVAL, TERMINAL_FAILURES };
