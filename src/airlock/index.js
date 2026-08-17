// Airlock — the layer between a Scraper Studio collector and the app that
// consumes it.
//
// One function, one decision, made on every single run:
//
//   run collector
//        │
//        ├── passes the rules ──> forward it, and remember it as last-known-good
//        │
//        └── fails the rules ───> block it, serve the remembered value instead,
//                                 write a heal prompt from the rules that broke,
//                                 trigger Scraper Studio's self-healing,
//                                 approve the fix, re-run, and only trust live
//                                 data again once it validates
//
// Everything the caller needs to render — including whether it is looking at
// live or stale data, and what is happening to the collector right now — comes
// back in one envelope. Progress is also streamed through `onEvent` so a
// terminal app can narrate the heal as it happens.

import { readFileSync } from 'node:fs';
import { COLLECTOR_ID } from '../config.js';
import { runCollector } from '../collector.js';
import { validateResponse } from './validator.js';
import { buildHealPrompt } from './healPrompt.js';
import { awaitHeal, resumeHeal, summarizeHeal, triggerHeal } from './heal.js';
import { assessProposedFix } from './previewGate.js';
import { appendHealLog, lastHealAt, readLastKnownGood, writeLastKnownGood } from './store.js';

/** Default gap enforced between heals of the same collector: 10 minutes. */
const DEFAULT_HEAL_COOLDOWN_MS = 10 * 60 * 1000;

function emit(onEvent, event) {
  if (onEvent) onEvent(event);
}

/** Fetch rows, either live from the collector or replayed from a saved response. */
async function collectRows(url, { fixture, collectorId, onEvent }) {
  if (fixture) {
    emit(onEvent, { type: 'replay', fixture });
    return { rows: JSON.parse(readFileSync(fixture, 'utf8')), responseId: null, durationMs: 0 };
  }

  emit(onEvent, { type: 'collector_run_start', url });
  const run = await runCollector(url, {
    collectorId,
    onPoll: (attempt) => emit(onEvent, { type: 'collector_poll', attempt }),
  });
  emit(onEvent, { type: 'collector_run_done', durationMs: run.durationMs });
  return run;
}

/**
 * Run the heal cycle for a set of validation failures.
 * Never throws — a heal that fails must not take the consumer app down, because
 * the app is being served last-known-good data and is still healthy.
 */
async function healCycle(failures, lastKnownGood, options) {
  const { collectorId, autoApprove, healCooldownMs, dryRunHeal, onEvent } = options;

  const prompt = buildHealPrompt(failures, lastKnownGood);

  // Dry run: show exactly what would be sent to Scraper Studio without mutating
  // the collector. Used to rehearse the demo and to inspect generated prompts.
  if (dryRunHeal) {
    emit(onEvent, { type: 'heal_dry_run', prompt });
    return { prompt, triggered: false, skipped: 'dry_run' };
  }

  // Healing a collector that is already mid-heal makes things worse, and the
  // AI-Flow job cap would reject the call anyway.
  const previous = lastHealAt(collectorId);
  if (previous !== null && Date.now() - previous < healCooldownMs) {
    const waitMs = healCooldownMs - (Date.now() - previous);
    emit(onEvent, { type: 'heal_skipped_cooldown', waitMs });
    return { prompt, triggered: false, skipped: 'cooldown', cooldownRemainingMs: waitMs };
  }

  emit(onEvent, { type: 'heal_trigger', prompt });
  appendHealLog({
    collectorId,
    prompt,
    failedRules: failures.map((failure) => failure.rule),
    trigger: 'validation_failure',
  });

  try {
    await triggerHeal(prompt, { collectorId, onEvent });

    let { outcome, progress } = await awaitHeal({ collectorId, onEvent });
    let approved = false;

    if (outcome === 'awaiting_approval') {
      const summary = summarizeHeal(progress);
      // Hold the proposed fix to the same rules as live data before accepting it.
      const assessment = assessProposedFix(progress);

      emit(onEvent, { type: 'heal_awaiting_approval', summary, assessment });

      if (!autoApprove) {
        return { prompt, triggered: true, outcome, approved: false, summary, assessment };
      }

      // The proposed output breaks the contract. Approving it would swap one bad
      // response for another, so it is rejected and the collector left alone.
      if (assessment.action === 'reject') {
        const rejected = await resumeHeal({ collectorId, approve: false, onEvent });
        return {
          prompt,
          triggered: true,
          outcome: 'rejected_bad_preview',
          approved: false,
          summary,
          assessment,
          afterReject: rejected.outcome,
        };
      }

      // No preview to verify — defer rather than guess in either direction.
      if (assessment.action === 'park') {
        return { prompt, triggered: true, outcome, approved: false, summary, assessment };
      }

      approved = true;
      ({ outcome, progress } = await resumeHeal({ collectorId, onEvent }));
      return {
        prompt,
        triggered: true,
        outcome,
        approved,
        summary: summarizeHeal(progress),
        assessment,
      };
    }

    emit(onEvent, { type: 'heal_settled', outcome });
    return { prompt, triggered: true, outcome, approved, summary: summarizeHeal(progress) };
  } catch (error) {
    emit(onEvent, { type: 'heal_error', message: error.message });
    return { prompt, triggered: true, outcome: 'error', error: error.message };
  }
}

/**
 * Fetch one book through Airlock.
 *
 * options:
 *   fixture        replay a saved collector response instead of running live
 *   autoHeal       trigger Scraper Studio self-healing on failure (default true)
 *   autoApprove    answer the approval gate automatically (default true)
 *   reverify       re-run and re-validate after a successful heal (default true)
 *   healCooldownMs minimum gap between heals of this collector
 *   onEvent        progress callback
 */
export async function fetchThroughAirlock(url, options = {}) {
  const {
    collectorId = COLLECTOR_ID,
    fixture = null,
    autoHeal = true,
    autoApprove = true,
    reverify = true,
    dryRunHeal = false,
    healCooldownMs = DEFAULT_HEAL_COOLDOWN_MS,
    onEvent,
  } = options;

  const lastKnownGood = readLastKnownGood(url);

  const envelope = {
    url,
    collectorId,
    outcome: null,
    row: null,
    source: null,
    validatedAt: null,
    ageMs: null,
    failures: [],
    blockedRow: null,
    heal: null,
    reverification: null,
    collector: null,
    error: null,
  };

  // 1. Get a response. A transport-level failure is not a broken selector, so it
  //    serves last-known-good but does not trigger a heal — healing cannot fix
  //    an HTTP error, and firing one would be noise.
  let run;
  try {
    run = await collectRows(url, { fixture, collectorId, onEvent });
  } catch (error) {
    emit(onEvent, { type: 'collector_error', message: error.message });
    return serveLastKnownGood(envelope, lastKnownGood, {
      error: error.message,
      onEvent,
    });
  }

  envelope.collector = {
    responseId: run.responseId ?? null,
    durationMs: run.durationMs ?? null,
    replayed: Boolean(fixture),
  };

  // 2. Validate.
  const verdict = validateResponse(run.rows);
  envelope.failures = verdict.failures;

  // 3. Pass path — forward, and remember.
  if (verdict.valid) {
    const entry = writeLastKnownGood(url, verdict.row, {
      collectorId,
      responseId: run.responseId,
    });
    emit(onEvent, { type: 'validation_passed' });
    return {
      ...envelope,
      outcome: 'live',
      row: verdict.row,
      source: 'live',
      validatedAt: entry.validatedAt,
      ageMs: 0,
    };
  }

  // 4. Fail path — block, serve the remembered value, heal.
  emit(onEvent, { type: 'validation_failed', failures: verdict.failures });
  envelope.blockedRow = verdict.row;

  const served = serveLastKnownGood(envelope, lastKnownGood, { onEvent });

  if (!autoHeal) return served;

  served.heal = await healCycle(verdict.failures, lastKnownGood, {
    collectorId,
    autoApprove,
    healCooldownMs,
    dryRunHeal,
    onEvent,
  });

  // 5. Re-verification — a completed heal is a claim, not a guarantee. Live data
  //    is only trusted again once a fresh run passes the same rules.
  //
  //    This runs even when the failure was replayed from a fixture: the heal
  //    itself was real and really changed the collector, so the check has to be
  //    real too. Only a dry-run or rejected heal leaves nothing to re-verify.
  if (reverify && served.heal.outcome === 'done') {
    emit(onEvent, { type: 'reverify_start' });
    try {
      const rerun = await runCollector(url, {
        collectorId,
        onPoll: (attempt) => emit(onEvent, { type: 'collector_poll', attempt }),
      });
      const recheck = validateResponse(rerun.rows);
      served.reverification = { valid: recheck.valid, failures: recheck.failures };
      emit(onEvent, { type: 'reverify_done', valid: recheck.valid });

      if (recheck.valid) {
        const entry = writeLastKnownGood(url, recheck.row, {
          collectorId,
          responseId: rerun.responseId,
        });
        served.outcome = 'healed_live';
        served.row = recheck.row;
        served.source = 'live';
        served.validatedAt = entry.validatedAt;
        served.ageMs = 0;
        served.failures = [];
      }
    } catch (error) {
      served.reverification = { valid: false, error: error.message, failures: [] };
      emit(onEvent, { type: 'reverify_error', message: error.message });
    }
  }

  return served;
}

/** Fill an envelope with the remembered value, or mark it unavailable. */
function serveLastKnownGood(envelope, lastKnownGood, { error = null, onEvent } = {}) {
  if (!lastKnownGood) {
    emit(onEvent, { type: 'no_last_known_good' });
    return { ...envelope, outcome: 'unavailable', error };
  }

  emit(onEvent, { type: 'serving_last_known_good', validatedAt: lastKnownGood.validatedAt });
  return {
    ...envelope,
    outcome: 'last_known_good',
    row: lastKnownGood.row,
    source: 'last_known_good',
    validatedAt: lastKnownGood.validatedAt,
    ageMs: Date.now() - Date.parse(lastKnownGood.validatedAt),
    error,
  };
}

export { DEFAULT_HEAL_COOLDOWN_MS };
