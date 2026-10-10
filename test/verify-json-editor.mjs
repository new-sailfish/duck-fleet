// The machine editor's JSON view: the validator that stands between a paste and the document.
//
// The view is a direct edit of the machine record, so a mistake in it would otherwise travel to the Host and
// come back as a server-side sentence about an identifier the operator never chose. This validates here
// instead, and these assertions pin the field-level behaviour — including the two deliberate leniencies:
// optional fields may be absent, and a duplicate name warns rather than refuses.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** Load the bundle and pull the validator out of the panel's closure. */
function loadFactory() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let captured;
  const window = {
    __ModuleLoader__: { load(entry) { captured = entry; } },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  new Function('window', 'setTimeout', 'clearTimeout', source)(window, setTimeout, clearTimeout);
  return captured;
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Component: class Component { constructor(props) { this.props = props; } },
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
};

const entry = loadFactory();
void entry.factory(() => React);

// The validator is a module-scope function inside the bundle, reachable only through the component that uses
// it. Its source is lifted out and evaluated with `FIELDS` and a translator in scope, so this suite calls the
// real thing rather than a copy of its rules.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const fieldsStart = source.indexOf('const FIELDS = [');
const fieldsEnd = source.indexOf('];', fieldsStart) + 2;
if (fieldsStart === -1 || fieldsEnd === 1) {
  console.log('  FAIL FIELDS is in the bundle');
  process.exit(1);
}
const fieldsSource = source.slice(fieldsStart, fieldsEnd);
const start = source.indexOf('function validateMachine(');
if (start === -1) {
  console.log('  FAIL the validator is in the bundle');
  process.exit(1);
}
// Brace matching rather than a regex: the function contains nested blocks and object literals.
const bodyStart = source.indexOf('{', start);
let depth = 0;
let end = bodyStart;
for (let index = bodyStart; index < source.length; index += 1) {
  if (source[index] === '{') depth += 1;
  if (source[index] === '}') { depth -= 1; if (depth === 0) { end = index + 1; break; } }
}
const validatorSource = source.slice(start, end);
const t = (key) => key;
// eslint-disable-next-line no-new-func
const validate = new Function('t', `${fieldsSource}\n${validatorSource}\nreturn validateMachine;`)(t);

const machines = [{ id: 'b', label: 'huawei-notebook' }, { id: 'c', label: 'huawei-vm' }];

console.log('\na complete record is accepted:');
{
  const result = validate({ label: 'new-box', host: '192.168.1.9', user: 'dev' }, machines, t);
  check('no errors', Object.keys(result.errors).length === 0, JSON.stringify(result.errors));
  check('a patch is produced', result.patch !== undefined);
  check('the required three survive', result.patch.label === 'new-box' && result.patch.host === '192.168.1.9' && result.patch.user === 'dev');
  check('optional fields stay absent', result.patch.port === undefined && result.patch.cwd === undefined, JSON.stringify(result.patch));
}

console.log('\noptional fields are carried when present:');
{
  const result = validate({
    label: 'box', host: 'h', user: 'u', port: 2222, remoteCommand: 'C:/x/dsh.cmd', permission: 'allow', cwd: '', description: 'd',
  }, machines, t);
  check('no errors', Object.keys(result.errors).length === 0, JSON.stringify(result.errors));
  check('the port becomes a number', result.patch.port === 2222, JSON.stringify(result.patch.port));
  check('the remote command is kept', result.patch.remoteCommand === 'C:/x/dsh.cmd');
  check('an empty optional field is dropped rather than sent as ""', result.patch.cwd === undefined, JSON.stringify(result.patch.cwd));
}

console.log('\nthe required three are enforced, per field:');
{
  for (const missing of ['label', 'host', 'user']) {
    const record = { label: 'l', host: 'h', user: 'u' };
    delete record[missing];
    const result = validate(record, machines, t);
    check(`a missing ${missing} is reported against that field`, result.errors[missing] === 'jsonRequired', JSON.stringify(result.errors));
    check(`and no patch is produced for it`, result.patch === undefined);
  }
  const blank = validate({ label: 'l', host: '', user: 'u' }, machines, t);
  check('an empty string counts as missing', blank.errors.host === 'jsonRequired', JSON.stringify(blank.errors));
}

console.log('\na typo is rejected rather than carried into the document:');
{
  // The store ignores properties it does not know, so an unnoticed typo would mean a machine that silently
  // lacks the setting the operator thought they had set — the `remoteCommand` case in particular produces a
  // machine that cannot start its agent.
  const result = validate({ label: 'l', host: 'h', user: 'u', remotecommand: 'C:/x/dsh.cmd' }, machines, t);
  check('the unknown field is named', result.errors.remotecommand !== undefined, JSON.stringify(result.errors));
  check('and nothing is saved', result.patch === undefined);
  const nested = validate({ label: 'l', host: 'h', user: 'u', extra: 1 }, machines, t);
  check('an extra property is rejected too', nested.errors.extra !== undefined, JSON.stringify(nested.errors));
}

console.log('\ntyped fields are checked by type, not by trust:');
{
  for (const bad of [0, -1, 70000, 3.5, 'abc', '0']) {
    const result = validate({ label: 'l', host: 'h', user: 'u', port: bad }, machines, t);
    const label = typeof bad === 'string' ? `"${bad}"` : String(bad);
    check(`port ${label} is rejected`, result.errors.port !== undefined, `errors=${JSON.stringify(result.errors)}`);
  }
  for (const good of [22, 2222, '2222']) {
    const result = validate({ label: 'l', host: 'h', user: 'u', port: good }, machines, t);
    check(`port ${JSON.stringify(good)} is accepted`, result.errors.port === undefined, JSON.stringify(result.errors));
  }
  const numeric = validate({ label: 7, host: 'h', user: 'u' }, machines, t);
  check('a non-text label is rejected', numeric.errors.label === 'jsonBadType', JSON.stringify(numeric.errors));
  const choice = validate({ label: 'l', host: 'h', user: 'u', permission: 'maybe' }, machines, t);
  check('an unknown permission is rejected', choice.errors.permission !== undefined, JSON.stringify(choice.errors));
  const okChoice = validate({ label: 'l', host: 'h', user: 'u', permission: 'reject' }, machines, t);
  check('a declared permission is accepted', okChoice.errors.permission === undefined, JSON.stringify(okChoice.errors));
}

console.log('\nnot-an-object is refused as a whole:');
{
  for (const value of [null, 42, 'text', [1, 2]]) {
    const result = validate(value, machines, t);
    check(`${JSON.stringify(value)} is refused`, result.patch === undefined && Object.keys(result.errors).length > 0, JSON.stringify(result.errors));
  }
}

console.log('\na duplicate name warns but does not refuse:');
{
  // The Host disambiguates a repeated name rather than failing, so refusing here would be stricter than the
  // system it is guarding — and the operator may genuinely be adding a second machine with a similar name.
  const result = validate({ label: 'huawei-vm', host: 'h', user: 'u' }, machines, t);
  check('it is still accepted', result.patch !== undefined, JSON.stringify(result.errors));
  check('and warns', result.warning === 'jsonDuplicateLabel', String(result.warning));
  const fresh = validate({ label: 'brand-new', host: 'h', user: 'u' }, machines, t);
  check('a fresh name does not warn', fresh.warning === undefined, String(fresh.warning));
}

console.log(`\n${failures === 0 ? 'JSON VALIDATION VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
