// Turns validation failures into the heal prompt.
//
// This is the step that removes the human from the loop. Normally someone has to
// notice extraction broke, work out which field, and write a description for
// `scraper heal`. Because every rule in rules.js carries prose alongside its
// predicate, Airlock can assemble that description itself from the specific rules
// that failed.
//
// The API caps heal prompts at 1000 characters, so this builds the prompt in
// priority order — the instruction first, then per-field detail, then the
// last-known-good evidence — and drops the lowest-priority parts if it runs long.

const PROMPT_MAX_LEN = 1000;

const HEADER =
  'The scraper is returning invalid data for ThriftBooks book pages. '
  + 'Fix the extraction so these fields are correct again:';

const FOOTER =
  'Keep the existing output field names and shape unchanged.';

function failureLine(failure, { withHint }) {
  const base = `- ${failure.field}: expected ${failure.expectation}, got ${failure.actualDescription}.`;
  return withHint ? `${base} ${failure.healHint}` : base;
}

/** Short evidence line quoting the last value that did validate, if there is one. */
function evidenceLine(failures, lastKnownGood) {
  if (!lastKnownGood?.row) return null;

  const examples = [];
  for (const failure of failures) {
    const previous = failure.field
      .split('.')
      .reduce((current, key) => (current == null ? undefined : current[key]), lastKnownGood.row);
    if (previous !== undefined && previous !== null && typeof previous !== 'object') {
      examples.push(`${failure.field} was ${JSON.stringify(previous)}`);
    }
  }

  if (examples.length === 0) return null;
  return `For reference, on the last run that validated: ${examples.join(', ')}.`;
}

/**
 * Build the heal prompt for a set of validation failures.
 * Returns a string of at most 1000 characters.
 */
export function buildHealPrompt(failures, lastKnownGood = null) {
  if (!Array.isArray(failures) || failures.length === 0) {
    throw new Error('buildHealPrompt requires at least one validation failure');
  }

  const evidence = evidenceLine(failures, lastKnownGood);

  // Richest version first, then progressively cheaper fallbacks. The first one
  // that fits the API limit wins.
  const candidates = [
    [HEADER, ...failures.map((f) => failureLine(f, { withHint: true })), evidence, FOOTER],
    [HEADER, ...failures.map((f) => failureLine(f, { withHint: true })), FOOTER],
    [HEADER, ...failures.map((f) => failureLine(f, { withHint: false })), FOOTER],
    [HEADER, ...failures.map((f) => failureLine(f, { withHint: false }))],
  ];

  for (const parts of candidates) {
    const prompt = parts.filter(Boolean).join('\n');
    if (prompt.length <= PROMPT_MAX_LEN) return prompt;
  }

  // Every field broke and the prose still overflows: hard-truncate rather than
  // let the API reject the call outright.
  const longest = candidates[candidates.length - 1].filter(Boolean).join('\n');
  return `${longest.slice(0, PROMPT_MAX_LEN - 1)}…`;
}

export { PROMPT_MAX_LEN };
