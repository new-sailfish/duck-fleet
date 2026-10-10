// What a finished pairing is allowed to do to the machine list.
//
// The payload in a final report is the only thing this plugin accepts from the controlled side with no human in
// between, so it is treated as untrusted input. Two properties matter most and both are asserted here: a
// payload that is missing what a record needs is REFUSED rather than half-added, and a payload that names more
// than one address does NOT pick one — `host` is the field the machine cannot verify, and a wrong guess
// produces a machine that looks ready and only ever answers "cannot connect".
import { interpretPayload } from '../lib/pairing.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

const complete = {
  label: 'LAPTOP-1FH3BLV8',
  host: '192.168.3.171',
  user: '1',
  port: 22,
  remoteCommand: 'D:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd',
  cwd: 'C:\\Users\\1\\.dsh-fleet-workspace',
};

console.log('\na complete payload is accepted as-is:');
{
  const result = interpretPayload(complete);
  check('it is accepted', result.ok === true, result.errors?.join('; '));
  check('it needs no choice', result.needsChoice === false);
  check('the label survives', result.machine.label === 'LAPTOP-1FH3BLV8');
  check('the port is a number', result.machine.port === 22, String(result.machine.port));
  check('the workspace survives', result.machine.cwd === 'C:\\Users\\1\\.dsh-fleet-workspace');
  check('it reports one candidate', result.candidates.length === 1, result.candidates?.join(', '));
}

console.log('\nmore than one address is a QUESTION, not a choice to make here:');
{
  const result = interpretPayload({ ...complete, hostCandidates: ['192.168.3.171', '192.168.0.2'] });
  check('it is still accepted', result.ok === true, result.errors?.join('; '));
  check('but it needs the operator to choose', result.needsChoice === true);
  check('both addresses are offered', result.candidates.length === 2, result.candidates?.join(', '));
  // The chosen `host` is included, so a payload that repeats its host in the candidate list is one choice.
  const repeated = interpretPayload({ ...complete, hostCandidates: ['192.168.3.171'] });
  check('a repeated host is not a second candidate', repeated.needsChoice === false, repeated.candidates?.join(', '));
  // Duplicates in the list are collapsed for the same reason.
  const duplicated = interpretPayload({ ...complete, hostCandidates: ['192.168.3.171', '192.168.3.171', '10.0.0.5'] });
  check('duplicates collapse', duplicated.candidates.length === 2, duplicated.candidates?.join(', '));
}

console.log('\na payload that cannot address a machine is refused, not half-added:');
{
  const noHost = interpretPayload({ ...complete, host: undefined });
  check('a missing host is refused', noHost.ok === false);
  check('and says so', noHost.errors?.some((line) => line.includes('host')) === true, noHost.errors?.join('; '));

  const noUser = interpretPayload({ ...complete, user: '' });
  check('a missing account is refused', noUser.ok === false);
  check('and says so', noUser.errors?.some((line) => line.includes('user')) === true, noUser.errors?.join('; '));

  // A relative workspace would resolve against whatever directory the agent happened to start in, so the
  // record would name a directory nobody chose.
  const relative = interpretPayload({ ...complete, cwd: 'work' });
  check('a relative workspace is refused', relative.ok === false);
  check('and says why', relative.errors?.some((line) => line.includes('absolute')) === true, relative.errors?.join('; '));

  for (const [name, value] of [['not an object', 'nope'], ['an array', []], ['null', null], ['a number', 7]]) {
    const result = interpretPayload(value);
    check(`${name} is refused`, result.ok === false, JSON.stringify(result.errors));
  }
}

console.log('\nfields are normalized rather than trusted:');
{
  // A port that arrives as text is a port: the prompt asks for a number and a model may quote it.
  check('a quoted port is parsed', interpretPayload({ ...complete, port: '22' }).machine.port === 22);
  // A port that is not a port is dropped rather than stored as a broken one. The record then takes the
  // default, which is what an operator would expect from a field the machine got wrong.
  check('an impossible port is dropped', interpretPayload({ ...complete, port: 99999 }).machine.port === undefined);
  check('a negative port is dropped', interpretPayload({ ...complete, port: -1 }).machine.port === undefined);
  check('junk in the port is dropped', interpretPayload({ ...complete, port: 'ssh' }).machine.port === undefined);
  // Whitespace around a value is an artifact of how it was produced, not part of it.
  check('values are trimmed', interpretPayload({ ...complete, user: '  1  ' }).machine.user === '1');
  // A hostname is what the prompt asks for a machine name; falling back to the host keeps an otherwise
  // complete payload usable instead of failing on a cosmetic field.
  check('a missing label falls back to the host', interpretPayload({ ...complete, label: undefined }).machine.label === '192.168.3.171');
}

console.log('\nthe payload cannot smuggle in fields this plugin does not manage:');
{
  const result = interpretPayload({ ...complete, id: 'evil', provider: 'fleet-evil', unknown: 'x', registered: true, extraArgs: ['-o', 'ProxyCommand=calc'] });
  check('it is accepted', result.ok === true, result.errors?.join('; '));
  check('an injected id is dropped', result.machine.id === undefined);
  check('an injected provider is dropped', result.machine.provider === undefined);
  check('an injected extraArgs is dropped', result.machine.extraArgs === undefined, 'this is the field that could make ssh run something else');
  check('an unknown field is dropped', result.machine.unknown === undefined);
  check('the managed fields are all kept', ['label', 'host', 'user', 'port', 'remoteCommand', 'cwd'].every((field) => result.machine[field] !== undefined));
  // A dangerous value in a MANAGED field is still a value the operator can see and edit; this plugin does not
  // extract meaning from it here. Noted so the boundary is explicit rather than assumed.
  const injected = interpretPayload({ ...complete, remoteCommand: 'dsh; calc' });
  check('a managed field is taken verbatim, for the operator to review', injected.machine.remoteCommand === 'dsh; calc');
}

console.log(`\n${failures === 0 ? 'PAIRING PAYLOAD VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
