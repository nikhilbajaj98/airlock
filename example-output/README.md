# Example output

Real responses from the custom `airlock-books` Scraper Studio collector and from
its heal lifecycle. Nothing here is hand-written.

| File | What it is |
| --- | --- |
| `create.json` | Response from `scraper create` — the collector's id, name and generation steps |
| `run1.json` | A clean validated run (Sapiens) |
| `run2.json` | A clean validated run (Murder on the Orient Express) |
| `heal-awaiting-approval.json` | A real heal parked at its approval gate, captured from `GET /dca/collectors/<id>/refactor_template/progress` |

## About `heal-awaiting-approval.json`

This is the payload that motivated Airlock's pre-approval gate, so it is worth
reading closely.

Airlock detected an invalid price, generated a heal prompt from the failed rules,
and triggered Scraper Studio's self-healing. The flow needed six
`code_fixer` / `request_fulfillment_validator` correction loops, then parked at
`status: "pending_answer"` awaiting approval.

The interesting field is `preview_result` — the output the *proposed* template
would produce:

```json
{ "book_title": "…", "author_name": "…",
  "price": { "value": 11.49, "currency": "USD" },
  "availability_status": "In Stock" }
```

Compare that to the shape the collector produces today:

```json
"price": { "value": 11.49, "currency": "USD", "symbol": "$" }
```

The proposed fix silently drops `price.symbol`, a field both consumer apps
render. The heal reports success; the result would have rendered
`undefined11.49 USD`. Approving it would have traded a missing price for a
malformed one.

That is why Airlock validates `preview_result` against the same rules as live
data before approving anything, and why the rule set now covers every field the
consumer renders. Two separate heals proposed this same regression, the second
even after the generated prompt explicitly asked to keep the currency symbol.

`diff.user` has been redacted; everything else is verbatim.
