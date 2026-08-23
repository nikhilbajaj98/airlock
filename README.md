# Airlock

A validation and continuity layer for Bright Data Scraper Studio collectors.
Built for the WeMakeDevs **Scrape-Verse** hackathon (Aug 17–23, 2026).

> An AI shopping agent watches a book's price and stock status. Overnight the
> bookstore reworks its markup, and the scraper starts returning a price of
> `null` — not an error, just nothing. Today that empty value flows straight to
> whoever relies on it until a human notices and manually runs a heal. Airlock
> sits between the scraper and the app: the instant bad data appears, it blocks
> it, keeps serving the last good value so nothing breaks, and automatically
> triggers Bright Data's self-healing — then refuses the fix if the fix is also
> wrong. What Scraper Studio promises, "nothing downstream ever sees a gap,"
> Airlock is what actually makes true.

## The problem

Scraper Studio's self-healing is genuinely powerful, but today it is reactive: a
human has to notice extraction broke, then manually run `scraper heal` with a
description of what changed. In the meantime the scraper does not error — it
returns a "successful" response with fields silently missing or null. Anything
downstream that trusts this blindly acts on garbage: wrong prices, false
"sold out" states, stale data, for hours or days before anyone notices.

This is not hypothetical. Both halves of it happened during this build.

**A selector died silently.** An earlier version of this project targeted
Eventbrite event pages. The ticket-price selector,
`.LiveEventPanelInfo-module-scss-module___rD3Sa__container`, was a hashed
CSS-module class name that changed on a frontend rebuild. Every run afterwards
reported success and returned `null` for price on confirmed-paid events. Two
`scraper heal` attempts and a manual edit to the parse code did not recover it,
and the collector's locked output schema then began rejecting edited runs with
`output_schema_incompatible` (422). Nothing anywhere said "this is broken" —
which is exactly the failure Airlock detects.

**Then a heal proposed a regression.** With Airlock running against the current
collector, a real heal completed successfully and proposed a template that
quietly dropped `price.symbol` — a field the consumer app renders. Reported as a
success; would have rendered `undefined11.49 USD`. A second heal dropped the same
field again, even though the generated prompt explicitly asked to keep it. See
[`example-output/heal-awaiting-approval.json`](example-output/heal-awaiting-approval.json).

So a self-healing loop needs a verifier at **both** ends: one that decides a
response is broken, and one that decides a proposed fix is real.

## The solution

Airlock sits between a Scraper Studio collector and whatever consumes its data:

1. You define validation rules for what a valid response looks like — for this
   collector, `price.value` must be a number greater than 0, `availability_status`
   must be one of two known values, and so on
   ([`src/airlock/rules.js`](src/airlock/rules.js)).
2. Every collector run is validated against those rules.
3. **Valid** → data passes straight through, and is remembered as
   last-known-good.
4. **Invalid** → Airlock:
   - blocks the bad response from reaching the app
   - serves the last-known-good value instead, clearly timestamped, so nothing
     crashes or shows garbage
   - generates a natural-language heal description from the specific rules that
     failed and calls the collector's heal endpoint — no human writes the prompt,
     no human notices first
5. **Before approving the fix**, Airlock validates the proposed output — Scraper
   Studio returns it as `preview_result` at the approval gate — against the same
   rules. A fix that breaks a rule is rejected. A fix with no preview to check is
   parked for a human, because rejecting a possibly-good fix is as harmful as
   approving a bad one.
6. **After a fix is approved**, Airlock re-runs the collector and re-validates
   before trusting live data again. A completed heal is a claim, not a guarantee.

Airlock does not just wrap the scraper — it drives the scraper's own lifecycle
(create → run → detect break → heal → assess → approve/reject → re-verify) end to
end, with no human in the loop. That is what makes **use of Scraper Studio** and
**reliability / self-healing** central to the project rather than incidental.

## Architecture

```
Scraper Studio collector runs
            |
            v
     Airlock validator  (rules.js — every field the consumer renders)
       /                      \
  valid                     invalid
    |                          |
Data passes through     Block bad response, serve last-known-good (timestamped)
    |                          |
Remembered as           Generate heal prompt from the failed rules
last-known-good                |
    |                   POST /dca/collectors/<id>/refactor_template
Consuming app stays            |
healthy, no gap         Scraper Studio heals (planner / code_fixer / validator)
                               |
                        Approval gate — validate `preview_result`
                          /              \
                    passes rules      breaks rules
                         |                  |
                     approve            reject the fix,
                         |              keep serving last-known-good
                  re-run + re-validate
                         |
                  resume live data
```

## Target site

A custom Scraper Studio collector (`airlock-books`) against public ThriftBooks
book pages, extracting book title, author name, price (value, currency, symbol)
and availability status. Validated clean across two different book URLs with
matching field shapes and no schema drift — see
[`example-output/`](example-output/).

Chosen after two earlier targets were ruled out: Eventbrite, for the silent
hashed-selector failure described above, which could not be recovered through
either healing or manual edits; and Bookshop.org, which was blocked by a WAF at
the browser level, not merely at the scraper level. Book pages turned out to be a
better demo subject anyway — price and stock status are exactly the fields an
agent would act on, and exactly the fields whose silent corruption does damage.

## Demo

Two tiny consumer apps fed by the same collector, side by side in two terminals:

- **Naive version** ([`src/naive/app.js`](src/naive/app.js)) — wired directly to
  raw scraper output. No validation, no fallback, no null guards. Crashes the
  moment a validation-breaking response comes through.
- **Airlock-protected version** ([`src/protected/app.js`](src/protected/app.js))
  — same feed, same card, same rendering code, one line different. Stays healthy,
  shows last-known-good with its age, names the rules that failed, and drives the
  heal in the background.

Both apps read fields without null guards. That is safe in exactly one of them,
for exactly one reason: the row has already passed every rule.

Full runbook, including the live heal and the refusal, in [`DEMO.md`](DEMO.md).

```bash
export BRIGHTDATA_API_KEY=...
npm test                                    # 30 tests, nothing to install

node src/protected/app.js                   # live run, seeds last-known-good
node src/naive/app.js     --fixture fixtures/broken-price-null.json   # crashes
node src/protected/app.js --fixture fixtures/broken-price-null.json   # survives
```

The failure is triggered on demand from a replayed response, and the heal it
provokes is real — so the demo does not depend on ThriftBooks changing its layout
during the submission window.

## How Scraper Studio is used

- **Custom collector** built with Scraper Studio (not the pre-built Scrapers
  Library) against ThriftBooks book pages.
- Airlock calls the collector's **API endpoints directly** from application code
  rather than shelling out to the CLI, because nobody is at a terminal when a
  break is detected:
  - `POST /dca/trigger_immediate?collector=<id>` → poll `GET /dca/get_result`
  - `POST /dca/collectors/<id>/refactor_template` to heal
  - `GET /dca/collectors/<id>/refactor_template/progress` to follow it
  - `POST /dca/collectors/<id>/resume_automation_job` to approve or reject
- On a validation failure, Airlock heals the collector with a description
  synthesized from the specific rules that broke.
- At the approval gate, Airlock validates Scraper Studio's own `preview_result`
  against those same rules before accepting the change.
- After approval, Airlock re-runs and re-validates before resuming live traffic.

## What is proven, and what is not

Honesty matters more here than a tidy story.

**Observed live against the real collector, both branches of the gate:**

- *Reject:* detect → block → serve last-known-good → generate prompt →
  trigger heal → follow the flow to its approval gate → validate the proposed
  output → reject it → collector left untouched → app still serving, exit 0.
  Happened twice — once human-answered, once fully autonomous — both times
  because the proposed fix silently dropped `price.symbol`.
- *Approve:* the same flow, but a third real heal proposed output that
  satisfied every rule. The gate approved it automatically, Airlock re-ran the
  collector for real, re-validated the fresh response, and only then resumed
  live traffic (`outcome: 'healed_live'`) — see
  [`example-output/heal-approved-and-reverified.json`](example-output/heal-approved-and-reverified.json)
  for the captured payload (note `save_new_template` in `completed_steps`,
  which only appears on an approved, saved heal).

So the gate has now been shown to discriminate correctly in both directions —
rejecting a fix that breaks the contract, and approving one that doesn't —
rather than being a rejector that has simply never seen a fix worth accepting.
Every branch in [`src/airlock/index.js`](src/airlock/index.js)'s `healCycle()`
has now executed against the live API.

**Both availability values are now confirmed live.** A genuinely unavailable book
returns exactly `"Out of Stock"`
([`example-output/run3-out-of-stock.json`](example-output/run3-out-of-stock.json)),
and the collector normalises other page wordings — "Almost Gone, Only 1 Left!"
comes back as `"In Stock"`.

Checking that also found a bug in Airlock itself. ThriftBooks shows no price for a
book it has no copies of, so the collector returns no `price` field — correct
data that an unconditional `price.value > 0` rule rejected. Airlock blocked a good
response and would have fired a heal at a healthy collector: the false alarm this
project exists to avoid causing. The price rules are now conditional on the book
being purchasable (`priceIsExpected` in [`src/airlock/rules.js`](src/airlock/rules.js)),
and rules that are stood down for a row are reported as `skipped` rather than
passing silently.

**Known limitation — Airlock validates shape and domain, not truth.** A book on
backorder ("On Backorder", $64.99, no Add to Cart) is reported by the collector as
`"In Stock"`. That is wrong, but it is a legal value in a well-formed response, so
no rule can catch it. Airlock detects missing, malformed and out-of-domain values;
it cannot detect a plausible lie. Closing that would need either a rule with
outside knowledge of the page, or a heal that teaches the collector to distinguish
backorder from stocked.

## Reliability decisions worth explaining

- **Transport errors do not trigger a heal.** A 500 or a timeout is not a broken
  selector; healing cannot fix it. Those serve last-known-good and record the
  error.
- **Heals are rate-limited** to one per collector per 10 minutes, recorded in an
  audit log. Repeatedly healing a collector degrades it, and Bright Data's
  AI-Flow job cap would reject the calls anyway (the client backs off through
  429s).
- **The validator never throws.** A validator that can crash on malformed input
  is no better than the naive app it replaces.
- **Every field the consumer renders must be a field the rules cover.** This was
  learned the hard way: `price.symbol` was rendered but unvalidated, which is
  precisely how the first proposed regression slipped past.
- **A rule that is right for most rows can be wrong for some.** Requiring a price
  is correct for a book on sale and wrong for one that is out of stock. An
  over-strict validator does real harm — it blocks good data and provokes
  unnecessary heals — so rules carry an `appliesWhen` condition, and any rule
  stood down for a row is reported rather than quietly skipped.

## Stretch goal

Risk-scoring `awaiting_approval` heals using signals Scraper Studio already
reports. The most valuable part of this is already built — the pre-approval gate
validates the proposed output itself, which is a stronger signal than any
heuristic. The remaining heuristics are surfaced but not yet scored:
`summarizeHeal()` in [`src/airlock/heal.js`](src/airlock/heal.js) exposes how many
`code_fixer` / `validator` correction loops the flow needed and how many steps the
proposed template contains.

## Tech stack

- Bright Data Scraper Studio (CLI for authoring, HTTP API for everything Airlock
  does) — mandatory hackathon tech
- Node.js 22, ES modules, **zero runtime dependencies** — no framework, no
  `node_modules`. Every line is walkable, which was a deliberate constraint:
  everything submitted here has to be explainable to a judge on the spot.
- `node:test` for the test suite (30 tests)
- Terminal UI, shared by both consumer apps so they cannot drift apart

## AI-assistant usage disclosure

This project was built with the help of Claude (Anthropic) as a coding assistant
— for planning and architecture in conversation, and for implementation in Claude
Code. All submitted code, architecture, and decisions are understood by the author
and can be explained directly to judges.

## Team

Solo submission.

## Status

- [x] Public repo with clear commit history
- [x] README: problem, solution, architecture, Scraper Studio usage,
      AI-assistant disclosure
- [x] Custom Scraper Studio collector (not from the Scrapers Library)
- [x] Example structured output — two clean runs plus a real heal gate payload
- [x] Naive and Airlock-protected consumer apps, with the loop proven live
- [ ] Demo video: naive vs. Airlock side by side, including the live heal and
      the refusal ([`DEMO.md`](DEMO.md) is the script)
- [ ] Submitted before the deadline (Aug 23, 2026)
