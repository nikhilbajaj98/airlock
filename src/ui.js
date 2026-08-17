// Terminal rendering shared by both consumer apps.
//
// Both apps draw the same card from the same primitives, on purpose. The demo's
// claim is that Airlock changes nothing about the app except where its data comes
// from, so the two apps must not differ in their presentation code — only in how
// they reach for a field.

export const BOX_WIDTH = 66;
const INNER_WIDTH = BOX_WIDTH - 4;
const LABEL_WIDTH = 14;

const useColour = !process.env.NO_COLOR && process.stdout.isTTY;
const wrap = (code) => (text) => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text);

export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');

// Colour codes take up no space on screen but do count toward String#length, so
// every measurement below works in visible characters. Without this the box
// borders drift apart as soon as a status line is coloured.
const ANSI_PATTERN = /\u001b\[[0-9;]*m/;
const ANSI_GLOBAL = new RegExp(ANSI_PATTERN.source, 'g');

export const visibleLength = (text) => String(text).replace(ANSI_GLOBAL, '').length;

export function truncate(text, max = INNER_WIDTH) {
  const value = String(text);
  if (visibleLength(value) <= max) return value;

  let out = '';
  let visible = 0;

  for (let i = 0; i < value.length; ) {
    const escape = ANSI_PATTERN.exec(value.slice(i));
    if (escape && escape.index === 0) {
      out += escape[0];
      i += escape[0].length;
      continue;
    }
    if (visible >= max - 1) break;
    out += value[i];
    visible += 1;
    i += 1;
  }

  // Close any colour left open by the cut. Tested with the non-global pattern
  // on purpose: a /g regex carries lastIndex between calls and answers wrongly.
  return `${out}…${ANSI_PATTERN.test(out) ? '\u001b[0m' : ''}`;
}

/** A full-width line of text inside the box. */
export function textLine(text) {
  const content = truncate(text);
  const padding = ' '.repeat(Math.max(0, INNER_WIDTH - visibleLength(content)));
  return `│ ${content}${padding} │`;
}

/** A label/value line, e.g. "Price         $5.79 USD". */
export function fieldLine(label, value) {
  return textLine(`${String(label).padEnd(LABEL_WIDTH)}${value}`);
}

export const topBorder = `┌${'─'.repeat(BOX_WIDTH - 2)}┐`;
export const bottomBorder = `└${'─'.repeat(BOX_WIDTH - 2)}┘`;
export const divider = `├${'─'.repeat(BOX_WIDTH - 2)}┤`;

/** Wrap already-built inner lines in a border. */
export function box(lines) {
  return [topBorder, ...lines, bottomBorder].join('\n');
}

/** "4m ago" / "2h ago" — how stale the served value is, in words. */
export function formatAge(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown age';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
