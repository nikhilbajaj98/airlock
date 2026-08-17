// The pre-approval gate, tested against the real payload that motivated it.
//
// A heal can finish successfully and still propose a template that breaks the
// contract. These tests pin the decision: approve only what passes the rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BRIGHTDATA_API_KEY ??= 'test-key-not-used';

const { assessProposedFix } = await import('../src/airlock/previewGate.js');

// Verbatim from GET /dca/collectors/<id>/refactor_template/progress on the first
// real heal of this collector. The proposed fix silently dropped price.symbol,
// which both consumer apps render — so it must not be auto-approved.
const REAL_GATE_PAYLOAD = {
  status: 'pending_answer',
  step: 'user_approval',
  completed_steps: ['planner', 'code_fixer', 'request_fulfillment_validator'],
  diff: { template_b: { steps: [{ name: 'New ide-automation template' }] } },
  preview_result: [
    {
      book_title: 'Sapiens: A Brief History of Humankind',
      author_name: 'Yuval Noah Harari',
      price: { value: 11.49, currency: 'USD' },
      availability_status: 'In Stock',
    },
  ],
};

const GOOD_PREVIEW = [
  {
    book_title: 'Sapiens: A Brief History of Humankind',
    author_name: 'Yuval Noah Harari',
    price: { value: 11.49, currency: 'USD', symbol: '$' },
    availability_status: 'In Stock',
  },
];

test('the real heal that dropped price.symbol is rejected', () => {
  const assessment = assessProposedFix(REAL_GATE_PAYLOAD);

  assert.equal(assessment.action, 'reject');
  assert.equal(assessment.reason, 'preview_failed_rules');
  assert.deepEqual(assessment.failures.map((f) => f.field), ['price.symbol']);
});

test('a proposed fix that satisfies every rule is approved', () => {
  const assessment = assessProposedFix({ ...REAL_GATE_PAYLOAD, preview_result: GOOD_PREVIEW });

  assert.equal(assessment.action, 'approve');
  assert.equal(assessment.reason, 'preview_passed_rules');
  assert.deepEqual(assessment.failures, []);
});

test('a fix with no preview is parked for a human, not guessed at', () => {
  // Rejecting a possibly-good fix is as harmful as approving a bad one.
  for (const preview of [undefined, null]) {
    const assessment = assessProposedFix({ ...REAL_GATE_PAYLOAD, preview_result: preview });
    assert.equal(assessment.action, 'park');
    assert.equal(assessment.reason, 'no_preview_to_verify');
  }
});

test('an empty preview array is a rejection, not a park', () => {
  // The field exists and says the fix extracts nothing. That is a verifiable
  // failure, not missing information.
  const assessment = assessProposedFix({ ...REAL_GATE_PAYLOAD, preview_result: [] });
  assert.equal(assessment.action, 'reject');
});

test('the gate does not throw on a malformed progress payload', () => {
  for (const input of [undefined, null, {}, { preview_result: 'nonsense' }, { preview_result: [null] }]) {
    assert.doesNotThrow(() => assessProposedFix(input));
  }
});
