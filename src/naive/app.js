#!/usr/bin/env node
//
// Naive consumer app — the "before" half of the Airlock demo.
//
// This is what wiring an app straight to a scraper normally looks like: run the
// collector, reach into the response, render the fields. It trusts the response
// completely — no schema check, no null guards, no fallback to a previous value.
//
// That trust is the whole point. When the collector starts silently returning
// null or a reshaped field (which is what happens when a target site's markup
// changes), this app does not warn and does not degrade gracefully. It either
// throws on a field access or renders the bad value as if it were true. The
// Airlock-protected app in src/protected/ is the same rendering fed through the
// validator, and stays healthy on the same input.
//
// Usage:
//   node src/naive/app.js                      # run the collector live
//   node src/naive/app.js --url <book url>     # run against a specific book page
//   node src/naive/app.js --fixture <file>     # replay a saved collector response
//
// --fixture replays a response captured from a real run instead of calling the
// API, so the failure case can be shown without waiting on a live broken run.

import { readFileSync } from 'node:fs';
import { runCollector } from '../collector.js';
import { DEFAULT_URL } from '../config.js';
import { box, divider, fieldLine, textLine } from '../ui.js';

function parseArgs(argv) {
  const args = { url: DEFAULT_URL, fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') args.url = argv[i + 1];
    else if (argv[i] === '--fixture') args.fixture = argv[i + 1];
  }
  return args;
}

// --- rendering -------------------------------------------------------------
//
// The box primitives are shared with the Airlock-protected app, so the two apps
// present identically. The difference is entirely in the four lines below that
// reach into the response.

function renderBook(book) {
  // Every one of these reads assumes the field is present and the right type.
  // No optional chaining, no defaults, on purpose.
  const title = book.book_title.trim();
  const author = book.author_name.trim();
  const price = `${book.price.symbol}${book.price.value.toFixed(2)} ${book.price.currency}`;
  const availability = book.availability_status.toUpperCase();

  return box([
    textLine('NAIVE CONSUMER  (no validation, no fallback)'),
    divider,
    fieldLine('Title', title),
    fieldLine('Author', author),
    fieldLine('Price', price),
    fieldLine('Availability', availability),
  ]);
}

// --- main ------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

let run;
if (args.fixture) {
  console.log(`Replaying saved collector response: ${args.fixture}\n`);
  run = { rows: JSON.parse(readFileSync(args.fixture, 'utf8')), durationMs: 0 };
} else {
  console.log(`Running collector against ${args.url}`);
  run = await runCollector(args.url, {
    onPoll: (attempt) => process.stdout.write(attempt === 1 ? '  waiting' : '.'),
  });
  console.log(`\n  done in ${(run.durationMs / 1000).toFixed(1)}s\n`);
}

// Also unguarded: assumes the collector returned at least one row.
console.log(renderBook(run.rows[0]));
