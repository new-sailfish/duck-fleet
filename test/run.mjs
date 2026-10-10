#!/usr/bin/env node
/**
 * DuckFleet regression runner.
 *
 * Runs every suite in this directory and reports one line each, plus a total. A suite that prints fewer than
 * `MIN_EXPECTED` assertions is treated as a failure even when it printed no `FAIL`: a suite that dies early —
 * a bad import, a renamed helper — otherwise reports all-green because it never reached its checks. That
 * happened once and turned 24 assertions into 13 with no visible error, so the count is guarded.
 *
 * The suites import the plugin by relative path, so this works from a checkout with no install step. They run
 * under a Node-compatible host; `pnpm test` supplies one.
 *
 * Usage: node test/run.mjs [suite-name…]
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Below this, a suite is presumed to have exited early rather than passed.
 *
 * Per-suite rather than global, because the suites differ by an order of magnitude: the dictionary check makes
 * eight assertions about one file, while the setup suite makes a hundred and thirty-five. A single floor high
 * enough to catch a truncation in the large suites reports the small ones as broken.
 */
const MIN_EXPECTED = { default: 10, 'verify-dictionaries.mjs': 8 };

const wanted = process.argv.slice(2);
const suites = readdirSync(here)
  // `harness.mjs` is a shared helper, not a suite.
  .filter((name) => name.endsWith('.mjs') && name !== 'run.mjs' && name !== 'harness.mjs')
  .filter((name) => wanted.length === 0 || wanted.some((prefix) => name.includes(prefix)))
  .sort();

if (suites.length === 0) {
  console.error(`no suite matched: ${wanted.join(', ')}`);
  process.exit(1);
}

let assertions = 0;
let failures = 0;
const broken = [];

for (const suite of suites) {
  const result = spawnSync(process.execPath, [join(here, suite)], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = (output.match(/ {2}ok /g) ?? []).length;
  const bad = (output.match(/ {2}FAIL /g) ?? []).length;
  assertions += ok;
  failures += bad;

  const early = ok < (MIN_EXPECTED[suite] ?? MIN_EXPECTED.default);
  if (bad > 0 || early) {
    broken.push(suite);
    console.log(`  [CHECK] ${suite}  ok=${String(ok)} fail=${String(bad)}${early ? '  (exited early?)' : ''}`);
    for (const line of output.split('\n').filter((l) => / {2}FAIL |Error|error:/.test(l)).slice(0, 6)) {
      console.log(`          ${line.trim().slice(0, 140)}`);
    }
  } else {
    console.log(`  [PASS] ${suite}  ok=${String(ok)}`);
  }
}

console.log(`\n${String(assertions)} assertions, ${String(failures)} failures, ${String(suites.length)} suites`);
process.exit(failures === 0 && broken.length === 0 ? 0 : 1);
