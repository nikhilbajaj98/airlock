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
    path: ['price', 'value'],
    expectation: 'a number greater than 0',
    check: isPositiveNumber,
    healHint:
      'Extract the current selling price as a number (not a string, no currency '
      + 'symbol inside the number), together with its currency code and symbol.',
  },
  {
    name: 'currency',
    path: ['price', 'currency'],
    expectation: 'a non-empty currency code string, e.g. "USD"',
    check: isNonEmptyString,
    healHint: 'Report the price currency as a three-letter code such as "USD".',
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
