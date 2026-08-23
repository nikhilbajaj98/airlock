# Example output

Real responses from the custom `airlock-books` Scraper Studio collector and from
its heal lifecycle. Nothing here is hand-written.

| File | What it is |
| --- | --- |
| `create.json` | Response from `scraper create` — the collector's id, name and generation steps |
| `run1.json` | A clean validated run (Sapiens) |
| `run2.json` | A clean validated run (Murder on the Orient Express) |
| `run3-out-of-stock.json` | A clean validated run against a genuinely unavailable book — note the absent `price` field |
| `heal-awaiting-approval.json` | A real heal parked at its approval gate, captured from `GET /dca/collectors/<id>/refactor_template/progress` |
| `heal-approved-and-reverified.json` | A real heal whose proposed fix passed the gate, was approved, and was re-verified live |

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

## About `run3-out-of-stock.json`

The page for this book reads "Temporarily Unavailable. We receive fewer than 1
copy every 6 months.", shows no price, and offers Add to Wish List instead of Add
to Cart. The collector normalises that to `availability_status: "Out of Stock"`
and returns **no `price` field at all**.

That is correct data, and it exposed a bug in Airlock's own rules: an
unconditional `price.value > 0` rule blocked this response and would have fired a
heal at a collector that was working perfectly. The price rules are now
conditional on the book being purchasable — see `priceIsExpected` in
[`../src/airlock/rules.js`](../src/airlock/rules.js).

This row is also the reason the naive consumer app can be shown crashing on a
completely live URL, with no fixture and no manufactured failure.

## About `heal-approved-and-reverified.json`

A third real heal, triggered after the fix above. Unlike the first two, this
proposal's `preview_result` satisfied every rule — including `price.symbol`,
this time correctly present — so the pre-approval gate approved it
automatically instead of rejecting it. Note `save_new_template` in
`completed_steps`: that step only appears when a heal is approved with
`auto_save`, which is how this payload can be told apart from a rejection at a
glance.

Airlock then re-ran the collector for real and re-validated the fresh response
before switching back to live traffic (`outcome: 'healed_live'` in
[`../src/airlock/index.js`](../src/airlock/index.js)). A follow-up live run
confirmed the collector still validates cleanly. Together with the rejection
above, this shows the gate discriminating correctly in both directions —
turning down a fix that breaks the contract, and accepting one that doesn't —
rather than being a gate that has simply never seen a good fix to accept.
