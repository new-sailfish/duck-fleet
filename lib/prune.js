/**
 * `fleet_prune` — clear a controlled machine's pile-up of ungrouped delegation sessions. **Lab feature.**
 *
 * ## The problem
 *
 * Every delegation opens a fresh session over ACP, and the ACP server's `newSession` never calls
 * `workspace.attachSession`, so those sessions belong to no workspace and land in the sidebar's ungrouped
 * bucket. Nothing on the controller can attach them after the fact: the operation that would do it
 * (`workspaceRegistry.attachSession`) has no ACP equivalent and no HTTP route.
 *
 * What IS reachable is the archive set. `workspace.json`'s `archivedSessionIds` is a flat list, and
 * `validateStoredState` requires nothing of its contents beyond the ids existing — so ungrouped sessions can
 * be hidden without being attached to anything.
 *
 * ## Why this is a Windows-only lab feature
 *
 * Two platform-specific pieces are involved, and only the Windows forms have been measured on real
 * machines (two of them, repeatedly):
 *
 *   * the registry lives at a different path, and
 *   * putting the app back on the interactive desktop after stopping it needs a different mechanism
 *     entirely (on Windows: a scheduled task with an interactive principal; a POSIX equivalent has not
 *     been written or tested).
 *
 * A machine whose platform cannot be confirmed as Windows is refused rather than attempted, and the panel
 * and the tool description both label the feature as experimental.
 *
 * ## Why the registry edit needs the app stopped
 *
 * The registry is held in memory by the running app and persisted on each mutation, so an edit made while
 * it is alive would be overwritten. The stop step therefore proves the file can be opened for exclusive
 * write before the archive step is allowed to touch it.
 *
 * @module dsh-duck-fleet/prune
 */
import { sshShellArgv } from './fleet.js';
import { ARCHIVE_SCRIPT, DETECT_POSIX, DETECT_WINDOWS, START_SCRIPT, STOP_SCRIPT } from './prune-scripts.js';

/** How long one remote command may take before it is treated as failed. */
const COMMAND_TIMEOUT_MS = 120_000;

/** Give the restarted app time to come up before its state is read. */
const START_SETTLE_SECONDS = 20;

/** Grace period handed to the subprocess provider; it rejects a spec without one. */
const COMMAND_GRACE_MS = 3_000;

/**
 * How many sessions to leave visible.
 *
 * Bounded because the value is written into a PowerShell parameter: an absurd number would either be
 * rejected there or archive nothing, and neither is worth a round trip to discover.
 */
const MAX_KEEP = 500;

/**
 * Encode a path the way the session store does when it names a directory.
 *
 * `C:\Users\Public` becomes `--C-Users-Public--`. This is how the fleet's own sessions are found on disk:
 * the store groups session directories by the session's cwd, and the fleet's sessions all carry the
 * machine's configured cwd.
 *
 * @param path - the machine's configured cwd, or its home directory when none is pinned.
 * @returns the directory name, or `undefined` when the path cannot be encoded.
 */
export function sessionsSubdirectoryFor(path) {
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  const slug = path.trim().replace(/[:\\/]+/g, '-').replace(/[^A-Za-z0-9.-]/g, '-');
  return `--${slug}--`;
}

/** Base64 of a UTF-8 string, for values that must survive ssh → shell → PowerShell. */
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * How much base64 goes into one `echo … >> file` command.
 *
 * Windows caps a command line at about 8191 characters; 3000 leaves room for the wrapper without ever
 * approaching it. Measured: a 12 304-character payload written in 5 chunks round-tripped byte-for-byte.
 */
const TRANSFER_CHUNK = 3000;

/**
 * Plan the remote file writes that install a stage, and the command that runs it.
 *
 * ## Why the scripts are transferred rather than inlined
 *
 * Three measured walls, in the order they were hit:
 *
 *   1. **Inlined in the ssh command** — 10 268 characters of base64 against an ~8191 limit; the far shell
 *      reported that the line was too long.
 *   2. **On stdin** — a 20 KB stdin payload did arrive, but the real bootstrap hung three times: ssh's stdin
 *      peers with a PowerShell process in session 0, and a `[Console]::In.ReadToEnd()` there blocks until an
 *      EOF that does not reliably come.
 *   3. **Chunked `echo` into a file** — what this does. base64 contains no character `cmd` treats specially,
 *      so each chunk needs no quoting, and a file argument to `powershell -File` needs no quoting either.
 *
 * Arguments are passed as separate argv elements after `-File`. A base64 value is quote-free and a plain
 * integer is too, so nothing on that path needs escaping at any of the three shell layers.
 *
 * @param stages - `{ name, script, args, remoteDirectory }` entries to install and run.
 * @returns the ordered list of shell commands to send.
 */
function planInstall(stages) {
  const commands = [];
  for (const stage of stages) {
    const encoded = Buffer.from(stage.script, 'utf8').toString('base64');
    const b64Path = `${stage.remoteDirectory}/${stage.name}.b64`;
    const ps1Path = `${stage.remoteDirectory}/${stage.name}.ps1`;

    for (let index = 0; index * TRANSFER_CHUNK < encoded.length; index += 1) {
      const slice = encoded.slice(index * TRANSFER_CHUNK, (index + 1) * TRANSFER_CHUNK);
      // `>` for the first chunk, `>>` afterwards: one command both creates and clears the file.
      commands.push({ step: `write ${stage.name}`, command: `cmd /c echo ${slice}${index === 0 ? '>' : '>>'}${b64Path}` });
    }
    commands.push({
      step: `decode ${stage.name}`,
      command: `powershell -NoProfile -Command "$t=[IO.File]::ReadAllText('${b64Path}'); [IO.File]::WriteAllBytes('${ps1Path}', [Convert]::FromBase64String($t.Trim()))"`,
    });
    const argumentLine = stage.args.length === 0 ? '' : ` ${stage.args.join(' ')}`;
    commands.push({
      step: stage.name,
      command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${ps1Path}${argumentLine}`,
    });
  }
  const cleanup = stages.map((stage) => `${stage.remoteDirectory}/${stage.name}.b64 ${stage.remoteDirectory}/${stage.name}.ps1`).join(' ');
  commands.push({ step: 'cleanup', command: `cmd /c del ${cleanup}` });
  return commands;
}

/**
 * Run one shell command on a machine over ssh and collect its output.
 *
 * Uses {@link sshShellArgv}, NOT `sshArgv`: the latter starts the ACP agent on the far side, so anything
 * appended to it is parsed by the DSH CLI instead of a shell. This feature talks to the machine's own shell
 * because it has to stop and start that agent, and because the platform question is the platform's to answer.
 *
 * @param deps - the plugin's context slice, which supplies the machine-side runner.
 * @param machine - the machine record.
 * @param command - the shell command; kept as a single argv element so ssh hands it over intact.
 * @returns `{ code, stdout, stderr }`.
 */
async function ssh(deps, machine, command, input, env) {
  const run = await deps.runRemote(sshShellArgv(machine, deps.settings?.() ?? {}), command, input, env);
  return { code: run.code, stdout: run.stdout, stderr: run.stderr };
}

/**
 * Decide whether a machine is Windows, using a test that needs no shell the machine might not have.
 *
 * @param deps - the plugin's context slice.
 * @param machine - the machine record.
 * @returns `'windows'`, `'posix'`, or `'unknown'`.
 */
export async function detectPlatform(deps, machine) {
  const windows = await ssh(deps, machine, DETECT_WINDOWS);
  if (windows.code === 0 && windows.stdout.includes('Windows_NT')) return 'windows';
  const posix = await ssh(deps, machine, DETECT_POSIX);
  if (posix.code === 0 && posix.stdout.trim() !== '') return 'posix';
  return 'unknown';
}

/**
 * Where the fleet's sessions live on a machine, as the session store names the directory.
 *
 * A pinned `cwd` is a claim about that machine, so it is used as given. Without one the remote session
 * borrows the delegating session's workspace — a path that exists on the CONTROLLER — so the fleet
 * directory cannot be named, and the operator is told to pin `cwd` instead of being guessed at.
 *
 * @param machine - the machine record.
 * @param remoteHome - the machine's home directory, when it was reported.
 * @returns `{ subdirectory, path }`, or `undefined`.
 */
export function resolveFleetDirectory(machine, remoteHome) {
  const pinned = typeof machine.cwd === 'string' && machine.cwd !== '' ? machine.cwd : undefined;
  if (pinned !== undefined) {
    const subdirectory = sessionsSubdirectoryFor(pinned);
    return subdirectory === undefined ? undefined : { subdirectory, path: pinned };
  }
  if (typeof remoteHome === 'string' && remoteHome !== '') {
    const subdirectory = sessionsSubdirectoryFor(remoteHome);
    return subdirectory === undefined ? undefined : { subdirectory, path: remoteHome };
  }
  return undefined;
}

/**
 * Prune one machine: stop the app, archive all but the newest `keep` fleet sessions, start it again.
 *
 * @param deps - the plugin's context slice.
 * @param machine - the machine record.
 * @param options - `{ keep }`.
 * @returns a report describing every stage, never throwing for a machine-side failure.
 */
export async function pruneMachine(deps, machine, options = {}) {
  const report = { steps: [], ok: false, archivedBefore: undefined, archivedAfter: undefined };

  const platform = await detectPlatform(deps, machine);
  report.platform = platform;
  report.steps.push({ step: 'detect', result: platform });
  if (platform !== 'windows') {
    report.problem = platform === 'posix'
      ? 'this feature is Windows-only and has not been written or tested for POSIX machines'
      : 'the machine did not answer the platform probe, so it cannot be classified';
    return report;
  }

  const keep = Number.isInteger(options.keep) && options.keep >= 0 ? Math.min(options.keep, MAX_KEEP) : 5;
  report.keep = keep;

  const home = await ssh(deps, machine, 'echo %USERPROFILE%');
  const remoteHome = home.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
  const fleet = resolveFleetDirectory(machine, remoteHome);
  report.fleetDirectory = fleet?.path;
  if (fleet === undefined) {
    report.problem = 'cannot tell where this machine keeps its sessions — set `cwd` on the machine record to an absolute path that exists on that machine';
    return report;
  }
  report.steps.push({ step: 'fleetDirectory', result: fleet.path });

  // Installed under the machine user's own home: the path needs no quoting. `cmd` wants BACKSLASHES for its
  // own builtins — `cmd /c mkdir C:/Users/x/y` fails with "the syntax of the command is incorrect", while
  // redirection and `powershell -File` both accept either form.
  const remoteDirectory = `${remoteHome.replace(/\//g, '\\')}\\duckfleet-prune`;
  const slashDirectory = remoteDirectory.replace(/\\/g, '/');
  const stages = [
    { name: 'stop', script: STOP_SCRIPT, args: [], remoteDirectory: slashDirectory },
    {
      name: 'archive',
      script: ARCHIVE_SCRIPT,
      args: ['-FleetSessionsSubdirectoryBase64', b64(fleet.subdirectory), '-Keep', String(keep)],
      remoteDirectory: slashDirectory,
    },
    { name: 'start', script: START_SCRIPT, args: ['-SettleSeconds', String(START_SETTLE_SECONDS)], remoteDirectory: slashDirectory },
  ];

  const transcript = [];
  let failed;

  // `cmd` runs this because `mkdir` is a cmd builtin, and the path uses backslashes for the same reason.
  // Guarded rather than bare: a SECOND prune finds the directory already there, `mkdir` then fails, and that
  // would abort a run with nothing wrong with it. `2>nul` does NOT help — measured, `cmd /c mkdir <existing>
  // 2>nul` still exits 1. The guard also keeps a genuine failure visible, which suppressing the error would not.
  const prepare = await ssh(deps, machine, `cmd /c if not exist "${remoteDirectory}" mkdir "${remoteDirectory}"`);
  if (prepare.code !== 0) {
    report.problem = `could not create the working directory on the machine: ${prepare.stderr.trim() || prepare.stdout.trim()}`;
    return report;
  }

  for (const planned of planInstall(stages)) {
    const result = await ssh(deps, machine, planned.command);
    const output = `${result.stdout}${result.stderr}`.trim();
    if (output !== '') transcript.push(`[${planned.step}] ${output}`);
    // A write or decode that fails makes every later stage meaningless, so the run stops at the first one.
    // `stop` and `start` are allowed to report a failure and let the caller judge.
    if (result.code !== 0 && planned.step !== 'cleanup') {
      failed = { step: planned.step, output };
      break;
    }
    if (planned.step === 'stop' || planned.step === 'archive' || planned.step === 'start') {
      report.stdout = `${report.stdout ?? ''}--- ${planned.step} ---\n${output}\n`;
    }
  }

  const run = { code: failed === undefined ? 0 : 1, stdout: report.stdout ?? '', stderr: failed?.output ?? '' };
  report.transcript = transcript.join('\n');
  report.failedStep = failed?.step;
  report.stdout = run.stdout.trim();
  report.stderr = run.stderr.trim();
  report.code = run.code;

  const archived = /archivedSessionIds: (\d+) -> (\d+)/.exec(run.stdout);
  if (archived !== null) {
    report.archivedBefore = Number(archived[1]);
    report.archivedAfter = Number(archived[2]);
  }
  const kept = /fleet sessions: (\d+)\s+skipped\(non-ACP\): (\d+)\s+keeping: (\d+)\s+archiving: (\d+)/.exec(run.stdout);
  if (kept !== null) {
    report.fleetSessions = Number(kept[1]);
    report.skippedNonAcp = Number(kept[2]);
    report.archivedThisRun = Number(kept[4]);
  }
  report.onDesktop = /RESULT: running on an interactive desktop/.test(run.stdout);
  report.appBack = /listening 19387: yes/.test(run.stdout);

  report.ok = run.code === 0 && report.onDesktop && report.appBack;
  if (!report.ok && report.problem === undefined) {
    report.problem = run.stderr !== ''
      ? run.stderr.split(/\r?\n/)[0]
      : 'the prune ran but did not leave the app running on the interactive desktop';
  }
  return report;
}

/** How long a prune may take, for the tool's own timeout budget. */
export const PRUNE_TIMEOUT_MS = COMMAND_TIMEOUT_MS;
