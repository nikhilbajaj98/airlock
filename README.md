# Airlock

A validation and continuity layer for Bright Data Scraper Studio collectors.
Built for the WeMakeDevs **Scrape-Verse** hackathon (Aug 17–23, 2026).

> "An AI agent checks Eventbrite for ticket availability. Overnight, Eventbrite
> redesigns their page, and the scraper starts silently returning empty data —
> not an error, just nothing. Today, that bad data flows straight to whoever's
> relying on it until a human happens to notice and manually fixes it. Airlock
> sits between the scraper and the app: the instant bad data shows up, it
> blocks it, keeps serving the last good value so nothing breaks, and
> automatically triggers Bright Data's self-healing — no human required. What
> Bright Data promises — 'nothing downstream ever sees a gap' — Airlock is
> what actually makes that true."

## The problem

Scraper Studio's self-healing is genuinely powerful, but today it's
reactive: a human has to notice extraction broke, then manually run
`scraper heal` with a description of what changed. In the meantime the
scraper doesn't error — it returns a "successful" response with fields
silently missing or null. Anything downstream that trusts this blindly
acts on garbage: wrong prices, false "sold out" states, stale data — for
hours or days before anyone notices.

## The solution

Airlock sits between a Scraper Studio collector and whatever consumes its
data:

1. You define validation rules for what a valid response looks like
   (e.g. `price: number > 0`, `availability: number OR "sold out"`).
2. Every collector run is validated against those rules.
3. **Valid** → data passes straight through.
4. **Invalid** → Airlock:
   - blocks the bad response from reaching the app
   - serves the last-known-good value instead (clearly timestamped), so
     nothing crashes or shows garbage
   - auto-generates a natural-language description of what failed and
     calls `scraper heal` on the same collector — no human writes the
     prompt, no human notices first
5. Once the heal completes, Airlock re-validates the fixed output against
   its own rules before trusting it again, then resumes serving live data.

Airlock doesn't just wrap the scraper — it drives the scraper's own
lifecycle (create → run → detect break → heal → approve/re-verify) end to
end, with no human in the loop. That's what makes **use of Scraper
Studio** and **reliability / self-healing** — two of the six judged
criteria — central to the project rather than incidental.

## Architecture

```
Scraper Studio collector runs
            |
            v
     Airlock validator (checks response rules)
       /                      \
  valid                     invalid
    |                          |
Data passes through     Serve last-known-good (timestamped, blocks bad data)
    |                          |
Consuming app stays     Auto-triggers heal (prompt generated from failed rule)
healthy, no gap                |
                        Scraper Studio heals (planner / code_fixer / validator)
                                |
                        re-verify, then resume live data
```

_(See the architecture diagram in this repo / hackathon submission for the
visual version.)_

## Target site

Custom Scraper Studio collector against public Eventbrite event listing
pages, extracting: event name, date, ticket price, availability status
(tickets remaining, or "sold out").

Chosen for public, low-anti-bot listing pages, high emotional stakes for
the demo narrative (an agent wrongly saying tickets are sold out, or
missing a real availability window), and visually strong event cards for
a live demo.

_Fallback targets if Eventbrite proves difficult during build:
quick-commerce/grocery listing pages, then books matched by ISBN across
independent bookstore sites, then books.toscrape.com as a zero-risk last
resort._

## Demo

Two tiny consumer apps fed by the same collector, side by side:

- **Naive version** — wired directly to raw scraper output. Crashes or
  shows garbage the moment a validation-breaking response comes through.
- **Airlock-protected version** — same feed, through Airlock. Stays
  healthy, shows last-known-good, auto-heals in the background.

The failure is triggered live and on demand via `scraper heal` with a
prompt describing a plausible field change — this doesn't depend on
Eventbrite actually redesigning during the demo window.

## How Scraper Studio is used

- **Custom collector** built with Scraper Studio (not the pre-built
  Scrapers Library) against Eventbrite event pages.
- Airlock calls the collector's API endpoint programmatically for each
  run, rather than shelling out to the CLI.
- On a validation failure, Airlock calls `scraper heal` on the collector
  itself, passing a description synthesized from the specific rule that
  broke.
- Airlock re-validates Scraper Studio's `awaiting_approval` result before
  resuming live traffic.

## Stretch goal (only if core is solid)

A risk-scoring layer on `awaiting_approval` heals, using signals already
present in Scraper Studio's own output: how many `code_fixer`/`validator`
correction loops it needed, how many fields the diff touches, and whether
the proposed new value is plausible against the last-known-good. Low-risk
heals auto-approve; risky ones get flagged for human review with the
reasoning shown.

## AI-assistant usage disclosure

This project was built with the help of Claude (Anthropic) as a coding
assistant for planning, architecture, and implementation. All submitted
code, architecture, and decisions are understood by the author and can be
explained directly to judges.

## Tech stack

- Bright Data Scraper Studio (CLI + API) — mandatory hackathon tech
- [collector runtime / backend — to be filled in during build]
- [frontend for the naive vs. Airlock demo — to be filled in during build]

## Team

Solo submission.

## Status

Submission checklist:

- [ ] Public repo with clear commit history
- [ ] README: problem, solution, architecture diagram, Scraper Studio
      usage, AI-assistant disclosure
- [ ] Example structured output from the custom scraper
- [ ] Demo video: naive vs. Airlock side by side, including a live
      auto-heal trigger
- [ ] Submitted before the deadline (Aug 23, 2026)
