# Demo runbook

Two consumer apps, one collector, side by side in two terminals. Same four
fields, same card, same rendering code — the only difference is that one reads
the collector directly and the other reads it through Airlock.

The demo's climax is not a scraper being fixed. It is Airlock **refusing a fix
that Bright Data's own healer proposed**, because the proposed output broke the
contract — while the app it protects never stops serving.

## Before recording

```bash
export BRIGHTDATA_API_KEY=...        # or copy .env.example to .env
npm test                             # 30 tests, no install needed
```

Seed the last-known-good store with one live run. A fresh clone has no
`.airlock-state/`, and the fallback has nothing to serve until a valid response
has been seen once:

```bash
node src/protected/app.js
```

Expected: `✓ live data, validated just now`.

Optionally clear heal history so the cooldown does not suppress the live heal:

```bash
rm -f .airlock-state/heal-log.json
```

## Act 1 — both apps healthy

Left terminal:

```bash
node src/naive/app.js
```

Right terminal:

```bash
node src/protected/app.js
```

Both render the same card. Point out that the right-hand one adds a provenance
line (`✓ live data, validated just now`) and nothing else. **Airlock is invisible
when the scraper is working.** That is the point.

## Act 2a — a live URL the naive app cannot survive

No fixture, no manufactured failure, no heal. A real ThriftBooks page for a book
with no copies in stock:

```bash
OOS=https://www.thriftbooks.com/w/waking-the-messiah_joanne-soper-cook/2618647/
```

The page reads "Temporarily Unavailable. We receive fewer than 1 copy every 6
months." and shows no price, so the collector correctly returns no `price` field.

Left terminal:

```bash
node src/naive/app.js --url "$OOS"
```

```
TypeError: Cannot read properties of undefined (reading 'symbol')
[exit 1]
```

Right terminal:

```bash
node src/protected/app.js --no-heal --url "$OOS"
```

```
│ Title         Waking the Messiah                               │
│ Author        JoAnne Soper-Cook                                │
│ Price         not priced while out of stock                    │
│ Availability  OUT OF STOCK                                     │
├────────────────────────────────────────────────────────────────┤
│ ✓ live data, validated just now                                │
│   not checked: price, currency, symbol (out of stock)          │
```

This is the strongest single moment in the demo, because nothing about it is
staged. It also has a story attached worth telling: Airlock's *own rules* got this
wrong at first. An unconditional `price > 0` rule blocked this correct response and
would have fired a heal at a perfectly healthy collector — the exact false alarm
the project exists to avoid causing. Rules now carry an `appliesWhen` condition,
and whatever is stood down for a row gets reported rather than silently skipped.

## Act 2b — a broken response arrives

`fixtures/broken-price-null.json` replays the failure mode this project hit for
real: a price selector goes dead and the field comes back `null` while the
response still reports success.

Left terminal — the naive app:

```bash
node src/naive/app.js --fixture fixtures/broken-price-null.json
```

```
TypeError: Cannot read properties of null (reading 'symbol')
    at renderBook (src/naive/app.js:49:31)
[exit 1]
```

Right terminal — through Airlock, heal suppressed so the fallback is the only
thing on screen:

```bash
node src/protected/app.js --fixture fixtures/broken-price-null.json --no-heal
```

```
┌────────────────────────────────────────────────────────────────┐
│ AIRLOCK-PROTECTED CONSUMER                                     │
├────────────────────────────────────────────────────────────────┤
│ Title         Murder on the Orient Express: A Hercule Poirot … │
│ Author        Agatha Christie                                  │
│ Price         $5.79 USD                                        │
│ Availability  IN STOCK                                         │
├────────────────────────────────────────────────────────────────┤
│ ⚠ last-known-good — live response was blocked                  │
│   validated 2026-08-17T20:01:26.144Z (14m ago)                 │
│   blocked: price.value — expected a number greater than 0      │
│            got missing — price is null                         │
│   blocked: price.currency — expected a non-empty currency cod… │
│            got missing — price is null                         │
│   blocked: price.symbol — expected a non-empty currency symbo… │
│            got missing — price is null                         │
└────────────────────────────────────────────────────────────────┘
[exit 0]
```

One app is down. The other is up, showing slightly stale truth, saying exactly
how stale and exactly which rules failed.

## Act 3 — the prompt writes itself

```bash
node src/protected/app.js --fixture fixtures/broken-price-null.json --dry-run-heal
```

This prints the heal prompt Airlock generated from the failed rules and sends
nothing. Nobody wrote this text:

```
The scraper is returning invalid data for ThriftBooks book pages. Fix the
extraction so these fields are correct again:
- price.value: expected a number greater than 0, got missing — price is null.
  Extract the current selling price as a number …
- price.currency: expected a non-empty currency code string, e.g. "USD", got
  missing — price is null. …
- price.symbol: expected a non-empty currency symbol string, e.g. "$", got
  missing — price is null. …
For reference, on the last run that validated: price.value was 5.79,
price.currency was "USD", price.symbol was "$".
Keep the existing output field names and shape unchanged.
```

Worth saying out loud: the prose comes from the rule definitions themselves, and
the evidence line comes from the last-known-good store. That is why the rules
carry prose alongside their predicates.

## Act 4 — the live loop, and the refusal

This is the real thing: a real heal on the real collector, ~2–4 minutes.

```bash
node src/protected/app.js --fixture fixtures/broken-price-null.json --force-heal
```

Narrate it as it streams:

1. `validation FAILED on price.value, price.currency, price.symbol — blocking`
2. `serving last-known-good from …` — the app is already safe
3. `triggering Scraper Studio self-healing` with the generated prompt
4. `healing… step: planner` → `code_fixer` → `css_selector_extractor` → …
5. `heal awaiting approval — 4 correction loop(s), 1 proposed step(s)`
6. **`proposed output BREAKS the contract — rejecting the fix:`**
   `price.symbol: expected a non-empty currency symbol string, e.g. "$", got missing`

Then the punchline. The heal response carries a `preview_result` field — the
output the proposed template *would* produce:

```
current shape:   price: { value: 5.79,  currency: "USD", symbol: "$" }
proposed shape:  price: { value: 11.49, currency: "USD" }        ← symbol dropped
```

Scraper Studio reported this heal as a success. The consumer app renders
`price.symbol`, so approving it would have printed **`undefined11.49 USD`** — a
missing price traded for a malformed one, with a green light on it.

Airlock validated the proposed fix against the same rules as live data, refused
it, left the collector untouched, and kept serving last-known-good throughout.

The collector is still healthy afterwards — show it:

```bash
node src/protected/app.js
node src/tools/heal-cli.js log
```

## The line to land on

Self-healing that is trusted blindly is just a faster way to ship bad data. The
loop needs a verifier at both ends: one that decides a response is broken, and
one that decides a fix is real. Airlock is both.

## Reproducing this claim from the committed artifacts

`example-output/heal-awaiting-approval.json` is the verbatim gate payload from a
real heal (with `diff.user` redacted). `test/previewGate.test.js` uses it as a
regression case, so the rejection is reproducible with no network:

```bash
npm test
```

## Operator commands

```bash
node src/tools/heal-cli.js status              # where the collector's heal stands
node src/tools/heal-cli.js log                 # Airlock's heal audit trail
node src/tools/heal-cli.js trigger "<prompt>"  # manufacture a change on demand
node src/tools/heal-cli.js watch               # follow a heal to its next state
node src/tools/heal-cli.js approve | reject    # answer an approval gate by hand
```

## Known limitation to state honestly if asked

The approve → re-verify → resume-live tail of the loop has **not** been observed
live. Both real heals so far proposed output that broke the contract, so the gate
rejected both and the approval path never executed against the API. The code is
in `src/airlock/index.js` and unit-tested, but do not claim it as demonstrated.
