#!/usr/bin/env node
// coverage.cjs — what the proof run does NOT cover.
//
// verify.cjs answers "did the things I check still work". It has never been able
// to answer the harder question: "what did I not check at all?" A suite that
// reports 661 green while a control nobody ever clicked sits broken on screen is
// not telling you the truth about the product — it is telling you the truth
// about itself.
//
// This reads the app's own wiring rather than a list someone maintains by hand:
// every element id the renderer attaches behaviour to, every named RPC command,
// every CLI verb. Then it asks which of those names never appear anywhere in
// verify.cjs. A name the checks never even mention cannot have been exercised.
//
// WHAT THIS DOES NOT MEASURE, said plainly, because a coverage number that
// overstates itself is worse than none:
//   * Mentioned is not tested. A check that types an id into a selector and
//     asserts nothing still counts as "covered" here. This finds absence, not
//     quality.
//   * Controls without an id — anything reached only by class, by role, or by
//     position — are invisible to this and are NOT in the denominator.
//   * Behaviour, states, edge cases, and every non-clickable surface (layout,
//     colour, timing, persistence) are entirely out of scope.
// So: treat every line it prints as a real gap, and never read its silence as
// coverage.
//
// Usage: node coverage.cjs            human-readable report
//        node coverage.cjs --json     machine-readable, for a check to assert on

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };

const app = read('public/app.js');
const html = read('public/index.html');
const verify = read('verify.cjs');
const cli = read('bin/winmux.cjs');

const uniq = (a) => [...new Set(a)].sort();
const all = (src, re) => { const o = []; let m; while ((m = re.exec(src))) o.push(m[1]); return o; };

// 1. Controls the renderer actually wires behaviour to. getElementById is the
//    app's own idiom for "this element does something", so it is the honest
//    denominator — not every id that happens to exist in the markup.
const wired = uniq([
  ...all(app, /getElementById\('([a-zA-Z0-9_-]+)'\)/g),
  ...all(html, /<(?:button|input|select|textarea)\b[^>]*\bid="([a-zA-Z0-9_-]+)"/g),
]);

// 2. Every command the control surface accepts — what an agent or the CLI can
//    ask the app to do.
const rpc = uniq(all(app, /cmd === '([a-z0-9-]+)'/g));

// 3. Every verb the command-line tool offers a human.
const verbs = uniq(all(cli, /cmd === '([a-z0-9-]+)'/g));

const missing = (names) => names.filter((n) => !verify.includes(n));

const groups = [
  { key: 'controls', label: 'controls the app wires up', names: wired },
  { key: 'rpc', label: 'commands the control surface accepts', names: rpc },
  { key: 'verbs', label: 'verbs the winmux command offers', names: verbs },
];

const report = groups.map((g) => {
  const gaps = missing(g.names);
  return { key: g.key, label: g.label, total: g.names.length, uncovered: gaps.length, names: gaps };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ groups: report }, null, 2));
  process.exit(0);
}

console.log('');
console.log('What the proof run does not cover');
console.log('---------------------------------');
for (const g of report) {
  const covered = g.total - g.uncovered;
  console.log('');
  console.log(g.label + ': ' + covered + ' of ' + g.total + ' are named somewhere in the checks.');
  if (!g.uncovered) { console.log('  nothing unnamed.'); continue; }
  console.log('  ' + g.uncovered + ' that no check mentions at all:');
  for (const n of g.names) console.log('    ' + n);
}
console.log('');
console.log('Read this as absence, not as a score. A name listed here has never been');
console.log('exercised by the suite. A name NOT listed may still be mentioned without');
console.log('being asserted on — and controls reached only by class or position are not');
console.log('counted at all, so the real gap is larger than what is printed above.');
console.log('');
