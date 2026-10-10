// The panel's two dictionaries must stay in step, since a key missing from one renders as the raw key.
//
// Written as a file rather than an inline one-liner because the quoting needed to express a regex over
// quoted keys does not survive a PowerShell command line — which cost several rounds of debugging before
// this existed.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
// A Windows checkout stores this file with CRLF, so splitting on `\n` leaves a trailing `\r` on every line.
// The first version of this parser did not account for it, its closing-brace test never matched, and the scan
// ran past BOTH dictionaries into the rest of the component — reporting `FIELDS` keys as orphans.
const lines = source.split(/\r?\n/);
const start = lines.findIndex((line) => line.includes('const DICTIONARIES'));

/**
 * Read one dictionary out of the source by INDENTATION, which is the structure the file actually has:
 *
 *     const DICTIONARIES = {
 *       en: {
 *         title: '…',          <- entries: 8 spaces
 *       },
 *       zh: { … },
 *     };
 *
 * Scanning by indentation rather than by brace counting or a guessed terminator: the first attempt used a
 * closing string that did not exist, so `indexOf` returned -1 and the slice swept in the rest of the file,
 * reporting `FIELDS` keys and button options as dictionary orphans.
 */
function dictionaryKeys(language) {
  const begins = lines.findIndex((line, index) => index > start && line.trim() === `${language}: {`);
  if (begins === -1) return { keys: [], begins: -1, ends: -1 };
  const keys = [];
  let ends = -1;
  for (let index = begins + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // The dictionary ends at its own closing brace, which is shallower than an entry.
    if (/^ {6}\},?$/.test(line)) { ends = index; break; }
    const entry = /^ {8}([A-Za-z][A-Za-z0-9_]*): (?=['"])/.exec(line);
    if (entry !== null) keys.push(entry[1]);
  }
  return { keys, begins, ends };
}

const enBlock = dictionaryKeys('en');
const zhBlock = dictionaryKeys('zh');
const en = enBlock.keys;
const zh = zhBlock.keys;
/** Last line of the dictionary object, so the orphan check can tell code from declarations. */
const dictionaryEnd = Math.max(enBlock.ends, zhBlock.ends);

console.log('\nthe two dictionaries describe the same keys:');
check('both were found', en.length > 0 && zh.length > 0);
check('neither is empty', en.length > 50 && zh.length > 50, `en=${String(en.length)} zh=${String(zh.length)}`);

const onlyEn = en.filter((key) => !zh.includes(key));
const onlyZh = zh.filter((key) => !en.includes(key));
check('no key is missing from zh', onlyEn.length === 0, onlyEn.join(', '));
check('no key is missing from en', onlyZh.length === 0, onlyZh.join(', '));
check('the counts agree', en.length === zh.length, `en=${String(en.length)} zh=${String(zh.length)}`);

console.log('\nevery key the panel asks for exists:');
{
  // `t('key')` is how the component reads a string, so a key used but not declared shows the operator the
  // identifier itself. This is the check that catches that.
  const used = [...new Set([...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_]*)'\)/g)].map((match) => match[1]))];
  const missing = used.filter((key) => !en.includes(key));
  check(`all ${String(used.length)} directly referenced keys are declared`, missing.length === 0, missing.join(', '));

  // Indirect lookups exist too: `t(field.label)` renders the field rows, and `archiveField(…, 'pruneEnabled', …)`
  // passes the key as an argument. A key reachable only that way still has to be declared.
  const indirect = ['label', 'host', 'user', 'port', 'remoteCommand', 'cwd', 'permission', 'toolName', 'description'];
  const absent = indirect.filter((key) => !en.includes(key));
  check('the keys reached through t(field.x) are declared', absent.length === 0, absent.join(', '));
}

console.log('\nno key is declared and then never used:');
{
  // A leftover renders nothing and misleads whoever reads the dictionary next — and it is exactly how the two
  // languages drift apart, since an orphan survives in one after being dropped from the other.
  //
  // The test is "does this key appear anywhere OUTSIDE the dictionaries", not "is it written as t('key')":
  // counting only the literal form reported `pruneEnabled` as an orphan while it was being passed to
  // `archiveField` as a string, and would have reported the field labels for the same reason.
  const body = lines.filter((_, index) => index < start || index > dictionaryEnd).join('\n');
  // Dynamic lookups are real lookups. The stage labels are reached as a template, `t(\`pairStage${stage}\`)`, so
  // the key never appears whole and matching the literal form reported all six as orphans.
  const dynamic = [...body.matchAll(/\bt\(`([A-Za-z][A-Za-z0-9_]*)\$\{/g)].map((match) => match[1]);
  check('the dynamic key prefixes were found', dynamic.length > 0, 'a rewrite that drops the template would silently skip this exemption');
  const unused = en.filter((key) => !new RegExp(`\\b${key}\\b`).test(body) && !dynamic.some((prefix) => key.startsWith(prefix)));
  check('no orphans', unused.length === 0, unused.join(', '));
}

console.log(`\n${failures === 0 ? 'DICTIONARIES VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
