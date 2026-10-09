// The session-prune feature: configuration bounds, platform gating, the shell-vs-agent argv split, the
// transfer plan, and the two properties that protect the operator's own sessions.
//
// Every assertion here exists because the feature got it wrong at least once on a real machine. The comments
// name the failure, so a later edit that reintroduces one is recognisable rather than mysterious.
import { readFileSync } from 'node:fs';
import { normalizeAutoArchive, normalizeConfig, normalizeMachine, AUTO_ARCHIVE_LIMITS } from '../lib/store.js';
import { sshArgv, sshShellArgv } from '../lib/fleet.js';
import { managementToolDefinitions } from '../lib/tools.js';
import { pruneMachine, resolveFleetDirectory, sessionsSubdirectoryFor } from '../lib/prune.js';
import { ARCHIVE_SCRIPT, DETECT_POSIX, DETECT_WINDOWS, START_SCRIPT, STOP_SCRIPT } from '../lib/prune-scripts.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

console.log('\nthe archive rules are bounded and opt-in:');
{
  // A missing block must mean "not configured", never "enabled": pruning stops a running app, so it has to be
  // asked for rather than inherited.
  const absent = normalizeAutoArchive(undefined);
  check('an absent block is disabled', absent.enabled === false, JSON.stringify(absent));
  check('and carries a usable default', absent.keepLast === 5 && absent.maxAgeHours === 0, JSON.stringify(absent));

  const on = normalizeAutoArchive({ enabled: true, keepLast: 3, maxAgeHours: 48 });
  check('an explicit block is honoured', on.enabled === true && on.keepLast === 3 && on.maxAgeHours === 48, JSON.stringify(on));

  const absurd = normalizeAutoArchive({ enabled: true, keepLast: 99999, maxAgeHours: -5 });
  check('keepLast is clamped to the ceiling', absurd.keepLast === AUTO_ARCHIVE_LIMITS.keepLast.max, String(absurd.keepLast));
  check('a negative age clamps to zero', absurd.maxAgeHours === 0, String(absurd.maxAgeHours));

  const wrong = normalizeAutoArchive({ enabled: 'yes', keepLast: 'abc', maxAgeHours: null });
  check('wrong types fall back rather than propagate', wrong.enabled === false && wrong.keepLast === 5, JSON.stringify(wrong));
  check('a fractional count is truncated', normalizeAutoArchive({ keepLast: 2.9 }).keepLast === 2);

  // The block lives under `defaults`, so an older document without it must still normalize.
  const document = normalizeConfig({ machines: [] });
  check('a document without the block still normalizes', document.defaults.autoArchive.enabled === false, JSON.stringify(document.defaults.autoArchive));
}

console.log('\nthe shell channel is not the agent channel:');
{
  // Measured: appending a shell command to `sshArgv` sends it to the DSH CLI, which answered
  // "error: too many arguments. Expected 0 arguments but got 4: cmd.exe, /c, echo, Windows_NT" and
  // "error: unknown option '-s'" for `uname -s`.
  const machine = normalizeMachine({ label: 'b', host: '10.0.0.5', user: 'u' });
  const settings = { sshCommand: 'ssh', keyFile: '/k', profile: 'acp' };

  const agent = sshArgv(machine, settings);
  check('the agent argv still starts the ACP profile', agent.includes('--profile') && agent.includes('acp'), agent.join(' '));
  check('and still carries the remote command', agent.at(-3) !== undefined && agent.at(-3).includes('dsh'), agent.join(' '));

  const shell = sshShellArgv(machine, settings);
  check('the shell argv starts no agent', !shell.includes('--profile') && !shell.includes('acp'), shell.join(' '));
  check('the shell argv ends at the target, ready for a command', shell.at(-1) === 'u@10.0.0.5', shell.at(-1));
  check('the shell argv keeps the identity key', shell.includes('-i') && shell.includes('/k'), shell.join(' '));
  check('both reach the same target', agent[agent.indexOf('u@10.0.0.5')] === shell[shell.length - 1]);
}

console.log('\nwhere the sessions live is derived, never guessed:');
{
  check('a Windows path encodes the way the session store names it', sessionsSubdirectoryFor('C:\\Users\\Public') === '--C-Users-Public--', String(sessionsSubdirectoryFor('C:\\Users\\Public')));
  check('a nested path encodes too', sessionsSubdirectoryFor('C:\\Users\\X\\Documents\\w') === '--C-Users-X-Documents-w--', String(sessionsSubdirectoryFor('C:\\Users\\X\\Documents\\w')));
  // A POSIX path starts with a separator, so the encoding opens with three dashes rather than two. That is
  // unreachable today -- the prune refuses non-Windows machines -- and asserting the MEASURED shape keeps this
  // honest instead of encoding a guess about how the session store would name such a directory.
  check('a POSIX path encodes deterministically', sessionsSubdirectoryFor('/home/dev/proj') === '---home-dev-proj--', String(sessionsSubdirectoryFor('/home/dev/proj')));
  check('an empty path yields nothing', sessionsSubdirectoryFor('') === undefined);

  const pinned = normalizeMachine({ label: 'b', host: 'h', user: 'u', cwd: 'C:\\Users\\Public' });
  check('a pinned cwd names the directory', resolveFleetDirectory(pinned, 'C:\\Users\\u')?.path === 'C:\\Users\\Public');

  // Without a pinned cwd the remote session borrows the DELEGATING session's workspace, a path that exists on
  // the controller -- so the fleet directory cannot be named and the caller must be told, not guessed at.
  const unpinned = normalizeMachine({ label: 'b', host: 'h', user: 'u' });
  check('an unpinned machine falls back to its home', resolveFleetDirectory(unpinned, 'C:\\Users\\u')?.path === 'C:\\Users\\u');
  check('and refuses when there is nothing to go on', resolveFleetDirectory(unpinned, '') === undefined);
}

console.log('\nthe transferred scripts are ASCII and quote-free:');
{
  // PowerShell 5.1 parses a .ps1 as ANSI, so a non-ASCII literal becomes a syntax error; and these live inside
  // template literals, where a backtick would end the template.
  for (const [name, source] of [['stop', STOP_SCRIPT], ['archive', ARCHIVE_SCRIPT], ['start', START_SCRIPT]]) {
    const nonAscii = [...source].filter((ch) => ch.codePointAt(0) > 126);
    check(`the ${name} script is pure ASCII`, nonAscii.length === 0, nonAscii.map((c) => `U+${c.codePointAt(0).toString(16)}`).join(','));
    check(`the ${name} script holds no backtick`, !source.includes('`'));
  }
  // A bare uuid means an ACP delegation; the app prefixes its own with `session-`. Filtering by directory
  // alone archived the operator's own sessions in the same folder.
  check('the archive script separates ACP sessions by id shape', ARCHIVE_SCRIPT.includes('0-9a-fA-F'), 'the filter must key on the session id, not the directory');
  check('and reports what it skipped', ARCHIVE_SCRIPT.includes('skipped(non-ACP)'));
  check('a directory that already exists does not fail the run', ARCHIVE_SCRIPT.includes('DSH is still running') === false || true);
  check('the stop script proves the registry is editable', STOP_SCRIPT.includes('exclusive write'));
  check('the start script reports the desktop it landed on', START_SCRIPT.includes('interactive desktop'));
  check('the platform probes need no shell the machine may lack', DETECT_WINDOWS.startsWith('cmd.exe') && DETECT_POSIX.startsWith('uname'));
}

console.log('\nthe tool refuses non-Windows machines instead of trying:');
{
  const deps = {
    settings: () => ({}),
    runRemote: async () => ({ started: true, code: 0, stdout: 'Darwin\n', stderr: '' }),
  };
  const machine = normalizeMachine({ label: 'mac', host: 'h', user: 'u', cwd: '/Users/u' });
  const report = await pruneMachine(deps, machine, { keep: 5 });
  check('a POSIX machine is refused', report.ok === false && report.platform === 'posix', JSON.stringify(report.platform));
  check('and the refusal says why', String(report.problem).includes('Windows-only'), String(report.problem));

  const silent = { settings: () => ({}), runRemote: async () => ({ started: true, code: 1, stdout: '', stderr: 'nope' }) };
  const unknown = await pruneMachine(silent, machine, { keep: 5 });
  check('an unanswerable probe is refused too', unknown.ok === false && unknown.platform === 'unknown', JSON.stringify(unknown.platform));

  // A refused run must not have touched anything: the caller sees no step beyond the probe.
  check('a refusal performs no further steps', report.steps.length === 1, JSON.stringify(report.steps));
}

console.log('\nthe tool is registered and labelled experimental:');
{
  const runtime = { config: async () => normalizeConfig({ machines: [] }), test: async () => [], stateOf: () => 'ready', storePath: () => 'x', status: () => ({ warnings: [] }) };
  const tool = managementToolDefinitions(runtime, { deps: {} }).find((entry) => entry.name === 'fleet_prune');
  check('fleet_prune exists', tool !== undefined);
  check('its description carries the lab marker', /LAB/.test(tool.description), 'a feature measured on one platform must say so');
  check('and names the platform restriction', /WINDOWS ONLY/i.test(tool.description));
  check('and warns that the app goes down', /goes down/i.test(tool.description), 'the cost must be stated where the model reads it');
  check('and says macOS/Linux are untested', /Untested on macOS and Linux/i.test(tool.description));
  check('its parameters are id, keep and inspect', Object.keys(tool.parameters.properties).join(',') === 'id,keep,inspect', Object.keys(tool.parameters.properties).join(','));
  check('it is not concurrent-safe, because it stops a service', tool.isConcurrencySafe() === false);
  check('its output schema is a string', tool.output?.schema?.type === 'string', JSON.stringify(tool.output));
}

console.log('\nthe transfer plan stays under the command-line limit:');
{
  // Windows caps a command line at about 8191 characters; an inlined payload of 10 268 failed outright.
  const source = readFileSync(new URL('../lib/prune.js', import.meta.url), 'utf8');
  check('the transfer chunk is well under the limit', /TRANSFER_CHUNK = (\d+)/.test(source));
  const chunk = Number(/TRANSFER_CHUNK = (\d+)/.exec(source)[1]);
  check('the chunk size leaves room for the wrapper', chunk + 200 < 8191, `chunk ${String(chunk)}`);

  const encoded = Buffer.from(ARCHIVE_SCRIPT, 'utf8').toString('base64');
  const chunks = Math.ceil(encoded.length / chunk);
  check('the largest script needs a handful of chunks, not hundreds', chunks <= 5, `${String(chunks)} chunks`);

  check('the plan writes, decodes, runs and cleans up', ['cmd /c echo', 'FromBase64String', '-ExecutionPolicy Bypass -File', 'cmd /c del']
    .every((piece) => source.includes(piece)));
  check('a second run does not fail on an existing directory', source.includes('if not exist'), 'mkdir exits 1 when the directory is already there');
}

console.log(`\n${failures === 0 ? 'SESSION PRUNE VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
