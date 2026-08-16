/**
 * SLICING SOURCE FOR GUARDS — shared by the test suite.
 *
 * WHY THIS EXISTS
 *   Guards read the shipped source and assert against a region of it. The
 *   obvious way to bound that region is a character count — `src.slice(i, i +
 *   1500)` — and it is wrong in a way that never announces itself: the day
 *   somebody adds a branch above the assertion, the window stops reaching it
 *   and the test goes on passing while guarding nothing.
 *
 *   That happened three times in one week. The Stripe webhook grew a
 *   balance-payment branch and two payment-flow assertions silently fell off
 *   the end of their 3000-character window; the pay-info route grew six
 *   columns and its stripeReady assertion fell off a 1500-character one. All
 *   three still reported green.
 *
 *   So: bound a region by something that MEANS something — the next route
 *   declaration, the closing brace of the function, the end of the table cell.
 *   If the boundary cannot be found, throw, rather than quietly returning a
 *   slice that covers the wrong code.
 */

/** Everything from `marker` up to the next thing that ends it.
 *  `stops` are regexes; the earliest match after the marker wins. Falls back
 *  to end-of-file, which is correct for the last route in a file. */
function regionFrom(src, marker, stops) {
  const start = typeof marker === 'number' ? marker : src.indexOf(marker);
  if (start === -1) throw new Error('regionFrom: marker not found: ' + marker);
  let end = src.length;
  for (const re of stops || []) {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    r.lastIndex = start + 1;
    const m = r.exec(src);
    if (m && m.index < end) end = m.index;
  }
  return src.slice(start, end);
}

/** One Express route handler, bounded by the next route declaration. */
function routeBlock(src, decl) {
  return regionFrom(src, decl, [/\nrouter\.(?:get|post|patch|put|delete|use)\(/]);
}

/** A function body, bounded by its own matching brace — not by the first
 *  `\n}\n`, which truncates the moment a helper lands inside the range. */
function braceBody(src, from) {
  const open = src.indexOf('{', from);
  if (open === -1) throw new Error('braceBody: no opening brace after ' + from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('braceBody: unbalanced braces from ' + from);
}

/** `function name(...) { … }` — the declaration line plus its balanced body. */
function fnBlock(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('fnBlock: no function ' + name + '()');
  return src.slice(start, src.indexOf('{', start)) + '{' + braceBody(src, start) + '}';
}

module.exports = { regionFrom, routeBlock, braceBody, fnBlock };
