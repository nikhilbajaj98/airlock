// Runs a collector row against the rules in rules.js.
//
// Two properties matter here:
//   - it never throws on bad input. A row can be null, a string, missing every
//     field, or have a null parent where an object is expected, and validation
//     still returns a structured verdict. If the validator could crash on bad
//     data it would be no better than the naive consumer app.
//   - it reports every failure, not just the first. The heal prompt is stronger
//     when it describes all the broken fields in one pass.

import { RULES } from './rules.js';

/**
 * Read a nested path. When a parent level is missing or is not an object, report
 * where the path broke as well as the fact that it did — "price is null" is much
 * more useful in a heal prompt than a bare "price.value is missing".
 */
function readPath(row, path) {
  let current = row;

  for (let depth = 0; depth < path.length; depth += 1) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return {
        value: undefined,
        brokeAt: depth === 0 ? null : path.slice(0, depth).join('.'),
        brokeOn: current,
      };
    }
    current = current[path[depth]];
  }

  return { value: current, brokeAt: null };
}

/** Human-readable rendering of whatever the collector actually returned. */
function describeActual({ value, brokeAt, brokeOn }) {
  if (brokeAt) {
    const parent = brokeOn === null ? 'null' : brokeOn === undefined ? 'missing' : typeof brokeOn;
    return `missing — ${brokeAt} is ${parent}`;
  }
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.trim() === '' ? 'an empty string' : `"${value}"`;
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return `${String(value)} (${typeof value})`;
}

/**
 * Validate one row.
 * Returns { valid, failures } where each failure is
 * { rule, field, expectation, actual, actualDescription, healHint }.
 */
export function validateRow(row) {
  const failures = [];

  // A missing or non-object row fails everything at once — this is what an empty
  // collector response looks like, and it must not be mistaken for "no rules ran".
  if (row === null || row === undefined || typeof row !== 'object' || Array.isArray(row)) {
    for (const rule of RULES) {
      failures.push({
        rule: rule.name,
        field: rule.path.join('.'),
        expectation: rule.expectation,
        actual: undefined,
        actualDescription: 'missing (the collector returned no usable row)',
        healHint: rule.healHint,
      });
    }
    return { valid: false, failures, skipped: [] };
  }

  const skipped = [];

  for (const rule of RULES) {
    // Some rules only apply to some rows — a price is not expected on a book that
    // is out of stock. Skipping is recorded rather than silent, so a response can
    // never look fully checked when part of the contract was stood down.
    if (rule.appliesWhen && !rule.appliesWhen(row)) {
      skipped.push(rule.name);
      continue;
    }

    const read = readPath(row, rule.path);
    if (rule.check(read.value)) continue;

    failures.push({
      rule: rule.name,
      field: rule.path.join('.'),
      expectation: rule.expectation,
      actual: read.value,
      actualDescription: describeActual(read),
      healHint: rule.healHint,
    });
  }

  return { valid: failures.length === 0, failures, skipped };
}

/**
 * Validate a whole collector response. Airlock consumes one book per run, so the
 * first row is the payload; an empty array is itself a validation failure rather
 * than an empty success.
 */
export function validateResponse(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const { failures } = validateRow(null);
    return {
      valid: false,
      failures,
      skipped: [],
      row: null,
      reason: 'the collector returned no rows',
    };
  }

  const row = rows[0];
  const { valid, failures, skipped } = validateRow(row);
  return {
    valid,
    failures,
    skipped,
    row,
    reason: valid ? null : 'one or more field rules failed',
  };
}
