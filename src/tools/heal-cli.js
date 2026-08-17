#!/usr/bin/env node
//
// Operator tool for the collector's heal lifecycle.
//
// Airlock heals automatically in normal operation. This exists for the two cases
// where a human is deliberately in the loop:
//
//   1. Manufacturing a failure on demand for the demo, so the whole detect →
//      block → serve → heal → re-verify loop can be shown without waiting for
//      ThriftBooks to change its markup.
//   2. Inspecting or answering an approval gate by hand — reviewing what Scraper
//      Studio proposes before it is accepted, and rejecting it if it looks wrong.
//
// Usage:
//   node src/tools/heal-cli.js status
//   node src/tools/heal-cli.js trigger "<prompt>"     # start a heal, do not wait
//   node src/tools/heal-cli.js watch                  # poll to the next settled state
//   node src/tools/heal-cli.js approve
//   node src/tools/heal-cli.js reject
//   node src/tools/heal-cli.js log                    # Airlock's own heal audit log
//
// `trigger` is the sabotage handle: a prompt describing a change that has not
// actually happened will make the collector extract the wrong thing, which is
// exactly the silent failure Airlock is built to catch.

import { COLLECTOR_ID } from '../config.js';
import { awaitHeal, classifyProgress, readHealProgress, resumeHeal, summarizeHeal, triggerHeal } from '../airlock/heal.js';
import { appendHealLog, readHealLog } from '../airlock/store.js';
import { dim, green, red, yellow } from '../ui.js';

const [command, ...rest] = process.argv.slice(2);

function printSummary(progress) {
  const outcome = classifyProgress(progress);
  const summary = summarizeHeal(progress);

  const colour =
    outcome === 'done' ? green : outcome === 'failed' ? red : outcome === 'awaiting_approval' ? yellow : dim;

  console.log(`  state: ${colour(outcome)}  (raw status: ${summary.status ?? 'none'})`);
  console.log(`  completed steps (${summary.stepCount}): ${summary.completedSteps.join(' → ') || 'none'}`);
  console.log(`  correction loops (code_fixer / validator): ${summary.correctionLoops}`);
  console.log(`  proposed template steps: ${summary.proposedTemplateSteps ?? 'unknown'}`);
  if (progress?.step) console.log(`  current step: ${progress.step}`);
}

const narrate = (event) => {
  if (event.type === 'heal_progress') console.log(dim(`  healing… step: ${event.step}`));
  if (event.type === 'heal_cap_wait') {
    console.log(dim(`  job cap hit, waiting ${Math.round(event.waitMs / 1000)}s`));
  }
  if (event.type === 'heal_approved') console.log(dim('  approval sent'));
  if (event.type === 'heal_rejected') console.log(dim('  rejection sent'));
};

switch (command) {
  case 'status': {
    const progress = await readHealProgress();
    console.log(`Collector ${COLLECTOR_ID}`);
    if (!progress || Object.keys(progress).length === 0) {
      // An empty body means no heal job exists yet — the API does not distinguish
      // "never healed" from "job not created yet", so say so rather than guess.
      console.log(dim('  no heal job on record (or one has only just been created)'));
      break;
    }
    printSummary(progress);
    break;
  }

  case 'trigger': {
    const prompt = rest.join(' ').trim();
    if (!prompt) {
      console.error('trigger needs a prompt describing what to change.');
      process.exit(1);
    }

    console.log(`Triggering heal on ${COLLECTOR_ID}`);
    console.log(dim(`  prompt: ${prompt}`));

    // Logged to the same audit trail Airlock's automatic heals use, so the
    // cooldown accounts for manual heals too.
    appendHealLog({ collectorId: COLLECTOR_ID, prompt, trigger: 'manual_cli' });
    await triggerHeal(prompt, { onEvent: narrate });
    console.log(green('  heal started — use `watch` to follow it'));
    break;
  }

  case 'watch': {
    const { outcome, progress } = await awaitHeal({ onEvent: narrate });
    console.log(`\nHeal settled: ${outcome}`);
    printSummary(progress);
    break;
  }

  case 'approve':
  case 'reject': {
    const approve = command === 'approve';
    const before = await readHealProgress();
    if (classifyProgress(before) !== 'awaiting_approval') {
      console.error(
        `Collector is not at an approval gate (state: ${classifyProgress(before)}). Nothing to ${command}.`
      );
      process.exit(1);
    }

    console.log(`${approve ? 'Approving' : 'Rejecting'} the proposed change:`);
    printSummary(before);

    const { outcome, progress } = await resumeHeal({ approve, onEvent: narrate });
    console.log(`\nAfter ${command}: ${outcome}`);
    printSummary(progress);
    break;
  }

  case 'log': {
    const log = readHealLog();
    if (log.length === 0) {
      console.log(dim('No heals recorded yet.'));
      break;
    }
    for (const entry of log) {
      console.log(`${entry.at}  ${entry.trigger ?? 'unknown'}  ${entry.collectorId}`);
      if (entry.failedRules) console.log(dim(`  failed rules: ${entry.failedRules.join(', ')}`));
      console.log(dim(`  prompt: ${entry.prompt}`));
    }
    break;
  }

  default:
    console.error('Usage: heal-cli.js status | trigger "<prompt>" | watch | approve | reject | log');
    process.exit(1);
}
