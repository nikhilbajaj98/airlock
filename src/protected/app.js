#!/usr/bin/env node
//
// Airlock-protected consumer app — the "after" half of the demo.
//
// Same collector, same four fields, same card as src/naive/app.js. The only
// difference is one line: it calls fetchThroughAirlock() instead of
// runCollector(). Everything else it gains — blocking bad responses, serving
// last-known-good, triggering and approving a heal, re-verifying afterwards —
// comes from that swap.
//
// Note what this app is allowed to assume. It reads fields without null guards,
// exactly like the naive app does, and that is safe here for one reason: any row
// Airlock hands over has already passed every rule in src/airlock/rules.js. The
// naive app makes the same assumption without having earned it.
//
// Usage:
//   node src/protected/app.js                    # run live, heal automatically
//   node src/protected/app.js --url <book url>
//   node src/protected/app.js --fixture <file>   # replay a saved response
//   node src/protected/app.js --dry-run-heal     # show the heal prompt, send nothing
//   node src/protected/app.js --no-heal          # validate and fall back only
//   node src/protected/app.js --no-approve       # stop at the approval gate
//   node src/protected/app.js --no-reverify      # skip the post-heal re-run
//   node src/protected/app.js --force-heal       # ignore the heal cooldown

import { fetchThroughAirlock } from '../airlock/index.js';
import { priceIsExpected } from '../airlock/rules.js';
import { DEFAULT_URL } from '../config.js';
import { box, dim, divider, fieldLine, formatAge, green, red, textLine, yellow } from '../ui.js';

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    fixture: null,
    autoHeal: true,
    autoApprove: true,
    reverify: true,
    dryRunHeal: false,
    healCooldownMs: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--url':
        args.url = argv[i + 1];
        break;
      case '--fixture':
        args.fixture = argv[i + 1];
        break;
      case '--no-heal':
        args.autoHeal = false;
        break;
      case '--no-approve':
        args.autoApprove = false;
        break;
      case '--no-reverify':
        args.reverify = false;
        break;
      case '--dry-run-heal':
        args.dryRunHeal = true;
        break;
      // Demo handle: the 10-minute cooldown is right in production but gets in
      // the way when deliberately running the loop twice in a row on stage.
      case '--force-heal':
        args.healCooldownMs = 0;
        break;
      default:
        break;
    }
  }

  return args;
}

// --- narration -------------------------------------------------------------
//
// Airlock streams progress events so the app can say what is happening while it
// happens. On the demo video this is the part that shows the loop running rather
// than just its outcome.

function narrate(event) {
  switch (event.type) {
    case 'replay':
      console.log(dim(`  replaying saved response ${event.fixture}`));
      break;
    case 'collector_run_start':
      console.log(dim(`  running collector against ${event.url}`));
      break;
    case 'collector_poll':
      process.stdout.write(dim(event.attempt === 1 ? '  waiting' : '.'));
      break;
    case 'collector_run_done':
      console.log(dim(`\n  collector finished in ${(event.durationMs / 1000).toFixed(1)}s`));
      break;
    case 'collector_error':
      console.log(red(`  collector call failed: ${event.message}`));
      break;
    case 'validation_passed':
      console.log(green('  validation passed — forwarding live data'));
      break;
    case 'validation_failed':
      console.log(
        red(`  validation FAILED on ${event.failures.map((f) => f.field).join(', ')} — blocking`)
      );
      break;
    case 'serving_last_known_good':
      console.log(yellow(`  serving last-known-good from ${event.validatedAt}`));
      break;
    case 'no_last_known_good':
      console.log(red('  no last-known-good available to fall back on'));
      break;
    case 'heal_dry_run':
      console.log(dim('\n  --- heal prompt Airlock would send ---'));
      console.log(dim(event.prompt.replace(/^/gm, '  ')));
      console.log(dim('  --- nothing sent (dry run) ---\n'));
      break;
    case 'heal_trigger':
      console.log(dim('  triggering Scraper Studio self-healing with generated prompt:'));
      console.log(dim(event.prompt.replace(/^/gm, '    ')));
      break;
    case 'heal_cap_wait':
      console.log(
        dim(`  AI-Flow job cap hit, waiting ${Math.round(event.waitMs / 1000)}s (attempt ${event.attempt})`)
      );
      break;
    case 'heal_progress':
      console.log(dim(`  healing… step: ${event.step}`));
      break;
    case 'heal_awaiting_approval': {
      console.log(
        yellow(
          `  heal awaiting approval — ${event.summary.correctionLoops} correction loop(s), `
            + `${event.summary.proposedTemplateSteps ?? '?'} proposed step(s)`
        )
      );
      // The proposed fix is checked against the same rules as live data before
      // it is accepted, so a heal that "succeeded" can still be turned down.
      const { action, failures } = event.assessment;
      if (action === 'approve') {
        console.log(green('  proposed output passes every rule — approving'));
      } else if (action === 'reject') {
        console.log(red('  proposed output BREAKS the contract — rejecting the fix:'));
        for (const failure of failures) {
          console.log(red(`    ${failure.field}: expected ${failure.expectation}, got ${failure.actualDescription}`));
        }
      } else {
        console.log(yellow('  no preview to verify — leaving the heal for human review'));
      }
      break;
    }
    case 'heal_approved':
      console.log(dim('  approved the proposed fix'));
      break;
    case 'heal_settled':
      console.log(dim(`  heal settled: ${event.outcome}`));
      break;
    case 'heal_skipped_cooldown':
      console.log(
        dim(`  heal suppressed: cooldown, ${Math.round(event.waitMs / 1000)}s remaining`)
      );
      break;
    case 'heal_error':
      console.log(red(`  heal failed: ${event.message}`));
      break;
    case 'reverify_start':
      console.log(dim('  re-verifying healed collector before trusting live data'));
      break;
    case 'reverify_done':
      console.log(
        event.valid
          ? green('  re-verification passed — resuming live data')
          : yellow('  re-verification failed — staying on last-known-good')
      );
      break;
    case 'reverify_error':
      console.log(red(`  re-verification could not run: ${event.message}`));
      break;
    default:
      break;
  }
}

// --- rendering -------------------------------------------------------------

/** The four fields, or dashes when there is genuinely nothing to show. */
function fieldLines(row) {
  if (!row) {
    return [
      fieldLine('Title', '—'),
      fieldLine('Author', '—'),
      fieldLine('Price', '—'),
      fieldLine('Availability', '—'),
    ];
  }

  // Safe without guards because this row passed validation. That is the trade
  // Airlock offers: validate once at the boundary, then trust the data inside.
  //
  // The one field read conditionally is price, and the condition is the same
  // function the rules use — so the app trusts exactly what the contract
  // guarantees, no more. An out-of-stock book has no price, and that is correct.
  const price = priceIsExpected(row)
    ? `${row.price.symbol}${row.price.value.toFixed(2)} ${row.price.currency}`
    : dim('not priced while out of stock');

  return [
    fieldLine('Title', row.book_title.trim()),
    fieldLine('Author', row.author_name.trim()),
    fieldLine('Price', price),
    fieldLine('Availability', row.availability_status.toUpperCase()),
  ];
}

/** Provenance footer: where this data came from and how far behind it is. */
function statusLines(result) {
  const lines = [divider];

  switch (result.outcome) {
    case 'live':
      lines.push(textLine(`${green('✓')} live data, validated just now`));
      break;
    case 'healed_live':
      lines.push(textLine(`${green('✓')} live data restored by auto-heal, re-verified just now`));
      break;
    case 'last_known_good':
      lines.push(
        textLine(`${yellow('⚠')} last-known-good — live response was blocked`),
        textLine(`  validated ${result.validatedAt} (${formatAge(result.ageMs)})`)
      );
      break;
    case 'unavailable':
      lines.push(
        textLine(`${red('✗')} no valid data, and no last-known-good to fall back on`)
      );
      break;
    default:
      break;
  }

  if (result.error) lines.push(textLine(`  collector error: ${result.error}`));

  // Say when part of the contract was stood down, so a partially-checked
  // response never reads as a fully-checked one.
  if (result.skipped?.length) {
    lines.push(textLine(dim(`  not checked: ${result.skipped.join(', ')} (out of stock)`)));
  }

  for (const failure of result.failures) {
    lines.push(textLine(`  blocked: ${failure.field} — expected ${failure.expectation}`));
    lines.push(textLine(`           got ${failure.actualDescription}`));
  }

  if (result.heal) {
    const heal = result.heal;
    const state = heal.skipped
      ? `not sent (${heal.skipped})`
      : `${heal.outcome}${heal.approved ? ', auto-approved' : ''}`;
    lines.push(textLine(`  heal: ${state}`));
    if (heal.error) lines.push(textLine(`        ${heal.error}`));

    if (heal.summary) {
      lines.push(
        textLine(`        ${heal.summary.correctionLoops} correction loop(s) needed`)
      );
    }

    // Why a proposed fix was accepted or turned down.
    if (heal.assessment) {
      lines.push(textLine(`        proposed fix: ${heal.assessment.reason.replace(/_/g, ' ')}`));
      for (const failure of heal.assessment.failures) {
        lines.push(textLine(`          would break ${failure.field} (${failure.actualDescription})`));
      }
    }
  }

  if (result.reverification) {
    lines.push(
      textLine(`  re-verified: ${result.reverification.valid ? 'passed' : 'still failing'}`)
    );
  }

  return lines;
}

function render(result) {
  return box([
    textLine('AIRLOCK-PROTECTED CONSUMER'),
    divider,
    ...fieldLines(result.row),
    ...statusLines(result),
  ]);
}

// --- main ------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

const result = await fetchThroughAirlock(args.url, {
  fixture: args.fixture,
  autoHeal: args.autoHeal,
  autoApprove: args.autoApprove,
  reverify: args.reverify,
  dryRunHeal: args.dryRunHeal,
  healCooldownMs: args.healCooldownMs,
  onEvent: narrate,
});

console.log(`\n${render(result)}`);

// The app is healthy whenever it had something valid to show — including when it
// fell back. It only reports failure when there was genuinely nothing to serve.
process.exit(result.outcome === 'unavailable' ? 1 : 0);
