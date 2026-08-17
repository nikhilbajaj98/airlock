# Fixtures

Saved collector responses, replayable with `--fixture` on either consumer app.
They exist so the failure path can be demonstrated without waiting on a live
broken run.

- `broken-price-null.json` — hand-written stand-in for a dead price selector:
  the exact shape of a validated run, with `price` nulled out. This is the
  failure mode observed for real earlier in the project, when a hashed CSS-module
  class name changed on a frontend rebuild and the price field silently went
  null on every run while the response still reported success.

A response captured from a genuinely broken run (step 4 of the build plan
manufactures one via `scraper heal`) will be committed here alongside it.
