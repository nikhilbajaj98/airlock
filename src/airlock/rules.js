// The contract Airlock holds the collector to.
//
// This is the heart of the project: a declarative description of what a valid
// response looks like. It drives two things at once —
//   1. validation (src/airlock/validator.js), and
//   2. the natural-language heal prompt (src/airlock/healPrompt.js).
//
// That double duty is why each rule carries prose as well as a predicate. When a
// rule breaks, Airlock already has the words to describe the break to Scraper
// Studio, so no human has to write the heal prompt.
//
// Field names and shapes below match the collector's actual locked output
// schema, confirmed against live runs (see example-output/run1.json):
//
//   { book_title, author_name, price: { value, currency, symbol }, availability_status }

/** Values the availability field is allowed to take, compared case-insensitively. */
export const ALLOWED_AVAILABILITY = ['in stock', 'out of stock'];

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

const isPositiveNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** True only when the row explicitly says the book cannot be bought. */
export const isOutOfStock = (row) =>
  typeof row?.availability_status === 'string'
  && row.availability_status.trim().toLowerCase() === 'out of stock';

/**
 * Whether a price is supposed to be present at all.
 *
 * Confirmed against a live out-of-stock page: ThriftBooks shows no price for a
 * book it has no copies of, and the collector correctly returns no `price` field.
 * That is right data, not a broken selector — so demanding a price there made
 * Airlock block a correct response and, worse, fire a heal at a healthy
 * collector. Exactly the false alarm this project is meant to avoid causing.
 *
 * Anything other than an explicit "out of stock" is treated as needing a price,
 * so a garbled or missing availability value fails loudly rather than quietly
 * excusing the price fields too.
 */
export const priceIsExpected = (row) => !isOutOfStock(row);

export const RULES = [
  {
    name: 'title',
    // Path into the row. Nested paths report as e.g. "price.value".
    path: ['book_title'],
    expectation: 'a non-empty string',
    check: isNonEmptyString,
    // Field-specific guidance handed to Scraper Studio when this rule breaks.
    healHint: 'Extract the book title from the product page heading as plain text.',
  },
  {
    name: 'author',
    path: ['author_name'],
    expectation: 'a non-empty string',
    check: isNonEmptyString,
    healHint: 'Extract the author name shown under the book title as plain text.',
  },
  {
    name: 'price',
    appliesWhen: priceIsExpected,
    path: ['price', 'value'],
    expectation: 'a number greater than 0',
    check: isPositiveNumber,
    healHint:
      'Extract the current selling price as a number (not a string, no currency '
      + 'symbol inside the number), together with its currency code and symbol.',
  },
  {
    name: 'currency',
    appliesWhen: priceIsExpected,
    path: ['price', 'currency'],
    expectation: 'a non-empty currency code string, e.g. "USD"',
    check: isNonEmptyString,
    healHint: 'Report the price currency as a three-letter code such as "USD".',
  },
  {
    // Added after a real heal proposed a template that dropped this field. Both
    // consumer apps render it, so leaving it out of the contract meant a "valid"
    // response could still render "undefined11.49 USD". The rule to draw from
    // that: every field the consumer renders must be a field the rules cover.
    name: 'symbol',
    appliesWhen: priceIsExpected,
    path: ['price', 'symbol'],
    expectation: 'a non-empty currency symbol string, e.g. "$"',
    check: isNonEmptyString,
    healHint: 'Keep reporting the currency symbol shown on the page, such as "$".',
  },
  {
    name: 'availability',
    path: ['availability_status'],
    expectation: `one of ${ALLOWED_AVAILABILITY.map((v) => `"${v}"`).join(' or ')} (any capitalisation)`,
    check: (value) =>
      isNonEmptyString(value) && ALLOWED_AVAILABILITY.includes(value.trim().toLowerCase()),
    healHint:
      'Report stock state as exactly "In Stock" or "Out of Stock" — normalise any '
      + 'other wording the page uses onto one of those two values.',
  },
];
