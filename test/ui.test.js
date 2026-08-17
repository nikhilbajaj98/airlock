// The card is the demo. If a coloured or over-long status line pushed the border
// out of alignment, the side-by-side comparison would look broken rather than
// deliberate — so the geometry is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  BOX_WIDTH,
  box,
  divider,
  fieldLine,
  formatAge,
  textLine,
  truncate,
  visibleLength,
} = await import('../src/ui.js');

const ESC = '\u001b';
const coloured = (text) => `${ESC}[33m${text}${ESC}[0m`;

test('visible length ignores colour codes', () => {
  assert.equal(visibleLength(coloured('warn')), 4);
  assert.equal(visibleLength('warn'), 4);
});

test('every kind of line is exactly the box width', () => {
  const lines = [
    textLine('short'),
    textLine(''),
    textLine('x'.repeat(200)),
    textLine(`${coloured('⚠')} last-known-good — live response was blocked`),
    fieldLine('Availability', 'IN STOCK'),
    fieldLine('Title', 'A book title long enough to need truncating '.repeat(4)),
    divider,
  ];

  for (const line of lines) {
    assert.equal(
      visibleLength(line),
      BOX_WIDTH,
      `line was ${visibleLength(line)} wide, expected ${BOX_WIDTH}: ${JSON.stringify(line)}`
    );
  }
});

test('a rendered box has borders that line up with its contents', () => {
  const rendered = box([textLine('AIRLOCK-PROTECTED CONSUMER'), divider, fieldLine('Price', '$5.79')]);
  const widths = new Set(rendered.split('\n').map(visibleLength));
  assert.deepEqual([...widths], [BOX_WIDTH]);
});

test('truncation preserves colour codes and closes them', () => {
  const cut = truncate(coloured('y'.repeat(100)), 20);
  assert.equal(visibleLength(cut), 20);
  assert.ok(cut.endsWith(`${ESC}[0m`), 'expected the colour to be reset after the cut');
});

test('truncation is stable when called repeatedly', () => {
  // Guards against a stateful global regex leaking lastIndex between calls.
  const input = coloured('z'.repeat(100));
  const first = truncate(input, 20);
  for (let i = 0; i < 5; i += 1) assert.equal(truncate(input, 20), first);
});

test('age reads as words', () => {
  assert.equal(formatAge(0), '0s ago');
  assert.equal(formatAge(45_000), '45s ago');
  assert.equal(formatAge(4 * 60_000), '4m ago');
  assert.equal(formatAge(3 * 3_600_000), '3h ago');
  assert.equal(formatAge(50 * 3_600_000), '2d ago');
  assert.equal(formatAge(null), 'unknown age');
});
