// Working-directory resolution for a delegated run.
//
// `cwd` on a machine record is the working directory of the LOCAL ssh process and the workspace the
// REMOTE session is created in, so one value has to satisfy both machines. When the record sets none,
// the delegating session's workspace is used instead of a fixed path — the same rule the shipped ACP
// backend applies, and for the same reason: one server process serves many sessions, each with its own
// workspace, so a fixed fallback would silently bind the child to the server's launch directory.
import { normalizeMachine } from '../lib/store.js';
import { hasPinnedWorkspace, resolveRemoteWorkspace, sshArgv, startMachineRun, testMachine } from '../lib/fleet.js';
import { MACHINE_DEFAULTS } from '../lib/store.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

const machine = (overrides = {}) => normalizeMachine({ id: 'b', host: '10.0.0.5', user: 'u', sshCommand: 'ssh', ...overrides });
const parentWith = (cwd) => ({ parent: { session: { header: cwd === undefined ? {} : { cwd } } } });

/**
 * A spawn seam that records the spec and then goes silent: stdout never yields and `done` never settles,
 * which is what an unreachable machine looks like to the driver. It exists so the spawn spec — the
 * resolved working directory — can be observed without a real ssh hop.
 */
function recordingSubprocess() {
  const seen = [];
  const service = {
    spawn(spec) {
      seen.push(spec);
      return {
        stdin: { write() {}, end() {}, on() {} },
        stdout: (async function* silent() {})(),
        stderr: (async function* silent() {})(),
        done: new Promise(() => {}),
        terminate() {},
        waitForExit: () => new Promise(() => {}),
      };
    },
  };
  return { seen, service };
}

const depsFor = (recorder) => ({
  subprocess: recorder.service,
  subprocessReady: () => true,
  onStderr: undefined,
});

console.log('the store no longer guesses a workspace:');
{
  check('the default is empty, not a fixed path', MACHINE_DEFAULTS.cwd === '', JSON.stringify(MACHINE_DEFAULTS.cwd));
  check('and it is not a Windows-only path', !String(MACHINE_DEFAULTS.cwd).includes('Users'));
  const bare = machine();
  check('a record with no cwd normalizes to empty', bare.cwd === '', JSON.stringify(bare.cwd));
  check('an explicit cwd is kept verbatim', machine({ cwd: '/srv/work' }).cwd === '/srv/work');
  check('an explicitly blank cwd stays blank', machine({ cwd: '' }).cwd === '');
  check('an unpinned record reports itself as unpinned', hasPinnedWorkspace(bare) === false);
  check('a pinned record reports itself as pinned', hasPinnedWorkspace(machine({ cwd: '/srv/work' })) === true);
}

console.log('\nresolving the REMOTE workspace:');
{
  const pinned = machine({ cwd: '/srv/work' });
  check('a pinned record wins over the session', resolveRemoteWorkspace(pinned, parentWith('/home/dev/proj')) === '/srv/work');
  const bare = machine();
  check('an unpinned record borrows the session workspace', resolveRemoteWorkspace(bare, parentWith('/home/dev/proj')) === '/home/dev/proj', String(resolveRemoteWorkspace(bare, parentWith('/home/dev/proj'))));
  check('a session without a workspace yields nothing', resolveRemoteWorkspace(bare, parentWith(undefined)) === undefined);
  check('no request at all yields nothing', resolveRemoteWorkspace(bare, undefined) === undefined);
  check('an empty session workspace is treated as absent', resolveRemoteWorkspace(bare, parentWith('')) === undefined);
  check('a blank pinned cwd falls through to the session', resolveRemoteWorkspace(machine({ cwd: '' }), parentWith('/w')) === '/w');
}

console.log('\nthe LOCAL spawn directory is never the machine workspace:');
{
  // This is the bug that made a working machine look broken. `machine.cwd` describes a path on the OTHER
  // machine, and a path that exists only there cannot be a working directory here: the subprocess resolver
  // rebases relative PATH entries onto the process directory, so a missing one made even the bare name `ssh`
  // unresolvable — measured as `ENOENT: spawn ssh ENOENT`, which reads like ssh is not installed.
  const pinnedRecorder = recordingSubprocess();
  startMachineRun(depsFor(pinnedRecorder), machine({ cwd: 'C:/Users/dev/Documents/workspace' }), {
    prompt: 'x', signal: new AbortController().signal, request: parentWith('/elsewhere'),
  });
  check('a pinned workspace does NOT become the local cwd', pinnedRecorder.seen[0]?.cwd === '/elsewhere', String(pinnedRecorder.seen[0]?.cwd));
  check('the session workspace does', pinnedRecorder.seen[0]?.cwd !== 'C:/Users/dev/Documents/workspace');

  const probeRecorder = recordingSubprocess();
  startMachineRun(depsFor(probeRecorder), machine({ cwd: 'C:/Users/dev/Documents/workspace' }), {
    prompt: '', signal: new AbortController().signal, handshakeOnly: true,
  });
  check('a probe falls back to this process directory', probeRecorder.seen[0]?.cwd === process.cwd(), String(probeRecorder.seen[0]?.cwd));

  const delegatedRecorder = recordingSubprocess();
  startMachineRun(depsFor(delegatedRecorder), machine(), {
    prompt: 'x', signal: new AbortController().signal, request: parentWith('/home/dev/proj'),
  });
  check('an unpinned record uses the session workspace locally', delegatedRecorder.seen[0]?.cwd === '/home/dev/proj', String(delegatedRecorder.seen[0]?.cwd));

  const resolveLocal = await import('../lib/fleet.js').then((m) => m.resolveLocalWorkspace);
  check('a request without a session falls back to this process directory', resolveLocal(undefined) === process.cwd(), String(resolveLocal(undefined)));
  check('and a request with one uses it', resolveLocal(parentWith('/w')) === '/w', String(resolveLocal(parentWith('/w'))));
}

console.log('\nthe ssh argv does not carry the workspace (it is a session parameter):');
{
  const argv = sshArgv(machine({ cwd: '/srv/work' }));
  check('no argument leaks the cwd into ssh', !argv.some((value) => value.includes('/srv/work')), argv.join(' '));
  const at = argv.indexOf('u@10.0.0.5');
  check('the target is present exactly once', at !== -1 && argv.indexOf('u@10.0.0.5', at + 1) === -1, argv.join(' '));
  check('the remote command and profile follow the target', argv[at + 1] === 'dsh' && argv[at + 2] === '--profile', argv.slice(at).join(' '));
}

console.log('\nthe remote command is quoted for the far shell:');
{
  // ssh does not run the remote command: it joins the words and hands the string to the far side's shell, which
  // splits it on spaces. On Windows the product installs under `AppData\Local\Programs\DeepSeek Harness`, so an
  // absolute path ALWAYS contains a space — and the symptom is "DeepSeek is not recognized", which reads like a
  // wrong path rather than a quoting mistake.
  const spaced = 'C:/Users/dev/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';
  const argv = sshArgv(machine({ remoteCommand: spaced }), { profile: 'acp' });
  check('a path with spaces is quoted', argv.includes(`"${spaced}"`), argv.at(-3));
  check('and it stays one argument, not two', argv.filter((value) => value.includes('DeepSeek')).length === 1, argv.join(' '));
  check('a bare name is left alone, so existing configs do not change', sshArgv(machine({ remoteCommand: 'dsh' })).at(-3) === 'dsh', sshArgv(machine({ remoteCommand: 'dsh' })).at(-3));
  check('a POSIX path needs no quoting either', sshArgv(machine({ remoteCommand: '/usr/local/bin/dsh' })).at(-3) === '/usr/local/bin/dsh');
  check('an embedded double quote is refused rather than mangled', (() => {
    try { sshArgv(machine({ remoteCommand: 'bad"quote' })); return false; } catch { return true; }
  })());
  // The command comes from the MACHINE record, not from the controller settings: it names the agent on that
  // machine, whose useful value is a path under that machine's own user profile.
  check('the machine record supplies it', sshArgv(machine({ remoteCommand: 'my-dsh' })).at(-3) === 'my-dsh');
  check('and the settings cannot override it', sshArgv(machine({ remoteCommand: 'my-dsh' }), { remoteCommand: 'other' }).at(-3) === 'my-dsh');
}

console.log('\nthe controller settings reach ssh (or nothing authenticates):');
{
  // Which ssh to run and which key it uses are the CONTROLLER's settings, so they are passed in rather than read
  // off the machine record. Getting this wrong is silent and total: without `-i`, ssh authenticates with whatever
  // it finds on its own.
  const settings = {
    sshCommand: '/usr/bin/ssh',
    keyFile: '/home/dev/.ssh/dsh_master_ed25519',
    profile: 'acp',
  };
  const argv = sshArgv(machine({ remoteCommand: 'dsh' }), settings);
  const at = argv.indexOf('-i');
  check('the key is passed to ssh', at !== -1, argv.join(' '));
  check('its value follows the flag', argv[at + 1] === settings.keyFile, argv[at + 1]);
  check('the configured ssh executable is used', argv[0] === settings.sshCommand, argv[0]);
  check('the remote command comes from the machine and the profile from the settings', argv.at(-3) === 'dsh' && argv.at(-1) === 'acp', argv.slice(-3).join(' '));
  check('no key means no -i, so ssh falls back to its own discovery', !sshArgv(machine(), { ...settings, keyFile: '' }).includes('-i'), sshArgv(machine(), { ...settings, keyFile: '' }).join(' '));
  check('an empty settings object still yields a usable argv', sshArgv(machine(), {})[0] === 'ssh', sshArgv(machine(), {})[0]);

  // The values must not come off the machine record for the CONTROLLER's settings: a per-machine copy would
  // silently win over the shared one, so changing the shared setting would appear to do nothing. `remoteCommand`
  // is the exception, because it names the agent on that machine.
  const record = machine();
  check('a machine record carries no controller settings',
    record.sshCommand === undefined && record.keyFile === undefined && record.profile === undefined,
    JSON.stringify(record));
  check('but it does carry its own remote command', typeof record.remoteCommand === 'string' && record.remoteCommand !== '', JSON.stringify(record.remoteCommand));

  // The runtime accessor must be SYNCHRONOUS. `config()` is async, so `config().defaults` is a promise's property
  // and always undefined — reading a setting that way dropped `-i` from every ssh command, which measured as
  // `stage: spawn, TypeError: Cannot read properties of undefined` instead of a connection.
  const runtimeSource = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../lib/runtime.js', import.meta.url), 'utf8'));
  check('the runtime exposes a synchronous settings accessor', /^\s{2}settings\(\)\s*\{/m.test(runtimeSource), 'a promise cannot be read synchronously');
  check('and it does not await anything', /settings\(\)\s*\{\s*\n\s*const defaults = this\.current\?\.defaults/.test(runtimeSource), 'it must read the cached document');
  const pluginSource = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../lib/plugin.js', import.meta.url), 'utf8'));
  check('the plugin wires that accessor into deps', pluginSource.includes('settings: () => ({'), 'deps.settings must be the synchronous one');
}

console.log('\nthe two workspaces are independent:');
{
  // Conflating them was the bug: a machine whose workspace is one of its own paths pointed the LOCAL spawn at a
  // directory that exists only over there, and ssh itself became unresolvable. The local half must always be a
  // directory on this machine; the remote half is the machine's own path and is offered to the far side only.
  const recorder = recordingSubprocess();
  startMachineRun(depsFor(recorder), machine({ cwd: 'C:/Users/dev/Documents/workspace' }), {
    prompt: 'x', signal: new AbortController().signal, request: parentWith('/home/dev/proj'),
  });
  const spec = recorder.seen[0];
  check('the local spawn runs here', spec?.cwd === '/home/dev/proj', String(spec?.cwd));
  // The remote workspace reaches session/new through `remoteWorkspace`, never as the spawn directory.
  check('the machine workspace is not passed as the spawn cwd', spec?.cwd !== 'C:/Users/dev/Documents/workspace');
  const source = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../lib/fleet.js', import.meta.url), 'utf8'));
  check('the local resolver falls back to this process directory', /return process\.cwd\(\);/.test(source), 'a probe has no session to borrow from');
  check('and never to the machine record', !/cwd:\s*machine\.cwd/.test(source), 'the machine cwd is a path over there');
}

console.log('\na probe asks for no more than it can verify:');
{
  // A probe has no delegating session, so it cannot supply a remote workspace. It must stop at
  // `initialize` rather than invent one, and it must bring its own local directory.
  const recorder = recordingSubprocess();
  startMachineRun(depsFor(recorder), machine(), {
    prompt: '', signal: new AbortController().signal, handshakeOnly: true,
  });
  check('a probe of an unpinned machine spawns the child', recorder.seen.length === 1, String(recorder.seen.length));
  check('a probe runs here, where it certainly exists', recorder.seen[0]?.cwd === process.cwd(), String(recorder.seen[0]?.cwd));

  const source = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../lib/fleet.js', import.meta.url), 'utf8'));
  check('a probe stops before session/new', /stopAfterInitialize:\s*options\.stopAfterInitialize === true \|\| remoteWorkspace === undefined/.test(source), 'the stop condition must be explicit');
  check('and it reports the caveat', source.includes('no workspace is configured for this machine'), 'the verdict must say what was not verified');
}

console.log('\nthe tool description tells the model the truth:');
{
  const source = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../lib/fleet.js', import.meta.url), 'utf8'));
  check('it no longer claims the remote agent shares "its own context"', !source.includes('works in its own context'), 'that phrasing described a local subagent');
  check('it warns that the session path is on THIS machine', source.includes('that directory is on this machine'), 'the cross-machine trap must be stated');
  check('it still demands absolute paths', source.includes('give absolute paths for anything it must reach'));
  check('it says a pinned workspace is on THAT machine', source.includes('its own working directory on that machine'));
}

console.log(`\n${failures === 0 ? 'WORKSPACE RESOLUTION VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
