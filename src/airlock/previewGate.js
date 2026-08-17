// Verifies a proposed fix before it is accepted.
//
// When Scraper Studio parks a heal at its approval gate, the progress payload
// carries `preview_result` — the output the *proposed* template produces. That
// means the fix can be held to exactly the same rules as live data, before it is
// ever approved.
//
// This matters because a heal can succeed on its own terms and still be wrong.
// The first real heal in this project returned a confident, working template that
// quietly dropped price.symbol — a field both consumer apps render. Approving it
// would have replaced a broken price with a malformed one.
//
// So auto-approval is not "the heal finished, ship it". It is "the proposed
// output passes the contract, ship it".

import { validateResponse } from './validator.js';

/**
 * Decide what to do with a heal parked at the approval gate.
 * Returns { action, reason, failures, row }, where action is:
 *   'approve' — the proposed output satisfies every rule
 *   'reject'  — the proposed output breaks at least one rule
 *   'park'    — there is no preview to check, so no automatic decision is safe
 */
export function assessProposedFix(progress) {
  const preview = progress?.preview_result;

  // No preview means the fix cannot be verified. Rejecting a possibly-good fix
  // is as bad as approving a bad one, so this defers to a human instead.
  if (preview === undefined || preview === null) {
    return { action: 'park', reason: 'no_preview_to_verify', failures: [], row: null };
  }

  const verdict = validateResponse(preview);

  if (verdict.valid) {
    return { action: 'approve', reason: 'preview_passed_rules', failures: [], row: verdict.row };
  }

  return {
    action: 'reject',
    reason: 'preview_failed_rules',
    failures: verdict.failures,
    row: verdict.row,
  };
}
