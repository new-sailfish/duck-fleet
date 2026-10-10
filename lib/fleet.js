/**
 * Fleet runtime: turn one machine record into one `ctx.subagents` provider plus one delegation
 * tool, so the model addresses a machine by name without any hand-written loader rows.
 *
 * @module dsh-fleet/fleet
 */
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAcpChild } from './acp.js';
import { composeRemotePrompt } from './preamble.js';
import { runCommandCollect } from './setup.js';
import { MACHINE_DEFAULTS, normalizeMachine } from './store.js';

/**
 * How much of the child's stderr to keep for a transport failure.
 *
 * ssh explains itself on stderr in a few lines; the cap only stops a runaway child from filling memory. Measured:
 * the message that mattered — `Host key verification failed.` — arrives within the first few hundred characters.
 */
const MAX_STDERR_CHARS = 4000;

/** Providers advertise no parent-enforced start capability: the child is a separate process. */const NO_CAPABILITIES = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
});

/** Default graces, matching the shipped ACP backend's contract. */
export const DISPOSE_EOF_GRACE_MS = 6000;
export const DISPOSE_GRACE_MS = 3000;

/** The registry name a machine's provider is registered under. */
export function providerNameFor(machine) {
  return `fleet-${machine.id}`;
}

/**
 * Quote a command for the shell that will run it on the CONTROLLED machine.
 *
 * ssh does not run the remote command itself: it joins the remaining words and hands the string to the far
 * side's shell. A path with a space is therefore split into two words there unless it is quoted, which on
 * Windows is the common case — the product installs under `AppData\Local\Programs\DeepSeek Harness`. The
 * symptom is not "not found" for the whole path but for its first fragment, which reads like a wrong path
 * rather than a quoting mistake.
 *
 * NOT exported: {@link sshArgv} is the only place that builds the argv, so it is the only place that may add
 * quoting. An exported helper invited a second caller to quote as well, and the value then reached ssh as
 * `"\"C:/Program Files/dsh.cmd\""` — quoted twice, which ssh passes through as a literal quote character.
 *
 * Double quotes are used because that is what cmd.exe and POSIX shells both honour, and a command containing a
 * double quote is refused rather than silently mangled.
 *
 * @param command - the command as configured.
 * @returns the command, quoted when it needs to be.
 */
function quoteRemoteCommand(command) {
  if (command.includes('"')) {
    throw new Error(`fleet: \`remoteCommand\` may not contain a double quote: ${command} ／ \`remoteCommand\` 不能包含双引号：${command}`);
  }
  // Only quote when necessary: an unquoted bare name is what every existing configuration uses, and quoting it
  // would change an argv that already works.
  return /[\s&|<>^()]/.test(command) ? `"${command}"` : command;
}

/**
 * Build the local argv whose stdio carries the ACP stream to the controlled machine.
 *
 * Nothing may precede the ssh executable, and ssh must produce no banner, because stdout is the protocol
 * channel.
 *
 * The controller's shared settings are passed in rather than read off the machine record: a per-machine copy
 * would silently win over the shared value and make changing it appear to do nothing. `remoteCommand` is the
 * exception — it says how to start the agent ON THAT MACHINE, so it stays on the machine record.
 *
 * @param machine - normalized machine record.
 * @param settings - `{ sshCommand, keyFile, profile }`.
 * @returns the argv array for the local spawn.
 */
export function sshArgv(machine, settings = {}) {
  const sshCommand = typeof settings.sshCommand === 'string' && settings.sshCommand !== '' ? settings.sshCommand : 'ssh';
  const profile = typeof settings.profile === 'string' && settings.profile !== '' ? settings.profile : 'acp';
  const keyFile = typeof settings.keyFile === 'string' ? settings.keyFile : '';
  const remoteCommand = typeof machine.remoteCommand === 'string' && machine.remoteCommand !== ''
    ? machine.remoteCommand
    : MACHINE_DEFAULTS.remoteCommand;

  const argv = [sshCommand];
  argv.push('-T');
  // Without `-i`, ssh authenticates with whatever it finds on its own, which is how a correctly configured
  // fleet silently fails to connect.
  if (keyFile !== '') argv.push('-i', keyFile);
  argv.push(
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
  );
  argv.push(...machine.extraArgs);
  argv.push(machine.port === 22 ? `${machine.user}@${machine.host}` : `${machine.user}@${machine.host}:${machine.port}`);
  argv.push(quoteRemoteCommand(remoteCommand), '--profile', quoteRemoteCommand(profile));
  return argv;
}

/**
 * Build a local argv that runs a SHELL COMMAND on the controlled machine, with no agent involved.
 *
 * Deliberately NOT {@link sshArgv}: that one starts `dsh --profile acp` on the far side, so anything appended
 * to it is read by the DSH CLI rather than by a shell. Measured — `cmd.exe /c echo %OS%` appended there came
 * back as `error: too many arguments. Expected 0 arguments but got 4: cmd.exe, /c, echo, Windows_NT`, and
 * `uname -s` as `error: unknown option '-s'`.
 *
 * The session-prune feature needs this because it stops and starts the app on that machine: it cannot use
 * the ACP channel it is taking down, and it needs the platform's own shell to ask what platform it is.
 *
 * @param machine - normalized machine record.
 * @param settings - `{ sshCommand, keyFile }`.
 * @returns the argv array, ending at the target so the caller appends its command.
 */
export function sshShellArgv(machine, settings = {}) {
  const sshCommand = typeof settings.sshCommand === 'string' && settings.sshCommand !== '' ? settings.sshCommand : 'ssh';
  const keyFile = typeof settings.keyFile === 'string' ? settings.keyFile : '';

  const argv = [sshCommand];
  argv.push('-T');
  if (keyFile !== '') argv.push('-i', keyFile);
  argv.push(
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  );
  argv.push(...machine.extraArgs);
  argv.push(machine.port === 22 ? `${machine.user}@${machine.host}` : `${machine.user}@${machine.host}:${machine.port}`);
  return argv;
}

/** Human-readable one-line address of a machine. */
export function machineTarget(machine) {
  return `${machine.user}@${machine.host}${machine.port === 22 ? '' : `:${machine.port}`}`;
}

/**
 * Whether an ssh failure is the "host key changed" refusal.
 *
 * The connection is not rejected because the key is UNKNOWN — `accept-new` takes those. It is rejected because a
 * stored key for that address no longer matches, which is what a machine does when its `sshd` is replaced:
 * measured on a real one, a reboot moved it from a portable user-level `sshd` to the system service, and the
 * host key changed with it. Every attempt then failed with a bare exit code, because ssh says why on stderr and
 * that was being discarded.
 */
export function isHostKeyMismatch(text) {
  const value = String(text ?? '');
  return /REMOTE HOST IDENTIFICATION HAS CHANGED/.test(value) || /Host key verification failed/.test(value);
}

/**
 * Build the argv that forgets a stored host key for one address.
 *
 * `ssh-keygen -R` rather than editing the file: it knows the hashed-name format and removes every key type for
 * that host in one pass. It is not a security decision on its own — deleting an entry only returns the address
 * to "unknown", which `accept-new` then trusts on first use, and that is what happens by hand anyway.
 *
 * @param sshKeygen - path or name of the `ssh-keygen` executable.
 * @param host - the address to forget.
 * @param port - the SSH port, so a non-default port's `[host]:port` entry is removed too.
 * @param knownHostsFile - the file to edit, when the caller keeps its own.
 * @returns the argv array.
 */
export function forgetHostKeyArgv(sshKeygen, host, port, knownHostsFile) {
  const argument = port === undefined || port === 22 ? String(host) : `[${String(host)}]:${String(port)}`;
  const argv = [sshKeygen, '-R', argument];
  if (typeof knownHostsFile === 'string' && knownHostsFile !== '') argv.push('-f', knownHostsFile);
  return argv;
}

/**
 * Resolve the workspace the REMOTE session will be created in, or `undefined` when there is none.
 *
 * An explicitly configured `machine.cwd` is a claim about the CONTROLLED machine, so it is used as given — that
 * is the whole point of pinning one.
 *
 * Otherwise a REAL delegation offers the delegating session's workspace, which at least exists somewhere the
 * operator controls. A probe has no session, so it offers nothing and the remote opens its own default
 * workspace — the only honest answer, since neither side knows a path the other is certain to have.
 *
 * @param machine - normalized machine record.
 * @param request - the start request; its `parent` is the delegating agent.
 * @returns the absolute remote workspace, or `undefined`.
 */
export function resolveRemoteWorkspace(machine, request) {
  if (typeof machine.cwd === 'string' && machine.cwd !== '') return machine.cwd;
  const parentCwd = request?.parent?.session?.header?.cwd;
  return typeof parentCwd === 'string' && parentCwd !== '' ? parentCwd : undefined;
}

/** Whether a machine record pins the workspace the remote session opens in. */
export function hasPinnedWorkspace(machine) {
  return typeof machine.cwd === 'string' && machine.cwd !== '';
}

/**
 * Resolve the directory the LOCAL ssh process runs in.
 *
 * Deliberately NOT the machine's `cwd`. That field describes a path on the other machine, and a path that exists
 * only there cannot be a working directory here: `dsh-subprocess-local` resolves relative PATH entries against
 * the process directory and `spawn({ cwd })` repoints it, so a missing directory makes even the bare name `ssh`
 * unresolvable — measured as `ENOENT: spawn ssh ENOENT`, which reads like ssh is not installed.
 *
 * @param request - the start request; its `parent` is the delegating agent.
 * @returns an absolute directory that exists on this machine.
 */
export function resolveLocalWorkspace(request) {
  const parentCwd = request?.parent?.session?.header?.cwd;
  if (typeof parentCwd === 'string' && parentCwd !== '') return parentCwd;
  return process.cwd();
}

/**
 * Spawn one controlled machine's ACP child through the harness subprocess seam.
 *
 * The two workspaces are resolved independently because they are two different machines: the local ssh process
 * needs a directory that exists HERE, and the remote session needs an absolute path that exists THERE. Conflating
 * them meant a machine whose workspace is one of its own paths (`C:\Users\dev\...`) pointed the local spawn at
 * a directory that does not exist, which made ssh itself unresolvable.
 *
 * The driver is asynchronous because a rejected spawn (a missing ssh executable, an unusable cwd) must surface as
 * a rejection rather than a synchronous throw from a tool body.
 *
 * @param deps - the plugin's context slice.
 * @param machine - normalized machine record.
 * @param options - prompt, cancellation, the delegating request, and how far to drive the handshake.
 * @returns the driver handle.
 */
export function startMachineRun(deps, machine, options) {
  const remoteWorkspace = resolveRemoteWorkspace(machine, options.request);
  return runAcpChild({
    name: providerNameFor(machine),
    argv: sshArgv(machine, deps.settings?.() ?? {}),
    cwd: resolveLocalWorkspace(options.request),
    env: {},
    permission: machine.permission,
    graceMs: DISPOSE_GRACE_MS,
    eofGraceMs: DISPOSE_EOF_GRACE_MS,
    signal: options.signal,
    prompt: options.prompt,
    handshakeOnly: options.handshakeOnly === true,
    // A run with no remote workspace stops before session creation, which is the only ACP call that
    // needs one.
    stopAfterInitialize: options.stopAfterInitialize === true || remoteWorkspace === undefined,
    remoteWorkspace,
    spawn: (spec) => deps.subprocess.spawn(spec),
    onStderrChunk: options.onStderr ?? deps.onStderr,
  });
}

/**
 * The `ctx.subagents` provider for one machine. Advertises no start-time capabilities, exactly
 * like the shipped ACP backend, because a child in another process cannot honor them.
 */
class MachineProvider {
  constructor(name, deps, machine) {
    this.name = name;
    this.capabilities = NO_CAPABILITIES;
    this.inheritsParentContext = false;
    this.deps = deps;
    this.machine = machine;
  }

  async start(request) {
    const handle = await startMachineRun(this.deps, this.machine, {
      prompt: request.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
      signal: request.signal,
      // The delegating request carries the parent session, whose workspace is the fallback working
      // directory when the machine record sets none.
      request,
    });
    return {
      id: handle.runId,
      localAgent: undefined,
      result: handle.result.then((outcome) => ({
        output: outcome.text === '' ? [] : [{ type: 'text', text: outcome.text }],
        stopReason: outcome.stopReason,
        ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
      })),
      dispose: handle.dispose,
    };
  }
}

/** Register one machine's provider and return its disposer. */
export function registerProvider(ctx, deps, machine) {
  const name = providerNameFor(machine);
  return ctx.subagents.registerProvider(new MachineProvider(name, deps, machine));
}

/**
 * Prove one machine end-to-end without spending a model turn: spawn over ssh, complete the ACP
 * initialize + session/new handshake, then tear the child down.
 *
 * @param deps - the plugin's context slice.
 * @param machine - normalized machine record.
 * @returns a structured verdict for the panel and the `fleet_test` tool.
 */
export async function testMachine(deps, machine) {
  const started = Date.now();
  if (!deps.subprocessReady()) {
    return { ok: false, stage: 'subprocess', target: machineTarget(machine), message: 'the subprocess service is unavailable in this Host composition ／ 这个 Host 组合里没有可用的 subprocess 服务' };
  }
  const first = await attemptHandshake(deps, machine, started);
  if (first.ok) return first;
  /**
   * A stored host key that no longer matches is recovered from, ONCE, and said out loud.
   *
   * This is not a security shortcut, it is the same two steps a person performs by hand: forget the stale entry,
   * then let `accept-new` trust the address on first use again. The machine is already in the configuration at
   * this point — somebody paired it and accepted it — so refusing forever on a key that changed when its `sshd`
   * was replaced leaves the operator to run `ssh-keygen -R` themselves for a change they already expect.
   *
   * What is NOT done is accepting a changed key silently on every attempt: the retry happens once per test, and
   * the outcome names the old and new fingerprints so a change that was NOT expected is visible rather than
   * absorbed.
   */
  if (!isHostKeyMismatch(first.message)) return first;

  const recovery = await forgetHostKey(deps, machine);
  if (!recovery.ok) {
    return { ...first, hostKey: { changed: true, recovered: false, detail: recovery.detail } };
  }
  const second = await attemptHandshake(deps, machine, started);
  return {
    ...second,
    hostKey: { changed: true, recovered: second.ok, fingerprint: recovery.fingerprint, detail: recovery.detail },
  };
}

/**
 * Run one handshake attempt, with no recovery behaviour.
 *
 * Split out of {@link testMachine} so the retry after a host-key change goes through exactly the same path: a
 * second implementation would be a second thing to keep in step, and the one that is only exercised on an error
 * is the one that rots.
 *
 * @param deps - host seams.
 * @param machine - normalized machine record.
 * @param started - the timestamp of the whole test, so elapsed time covers both attempts.
 * @returns the test outcome.
 */
async function attemptHandshake(deps, machine, started) {
  // A probe has no delegating session, so it has nothing to offer as the remote workspace. With a pinned `cwd`
  // on the record, that path is offered instead; otherwise the probe verifies everything up to session creation
  // and says so, rather than inventing a path. The local half needs no configuration either way.
  const controller = new AbortController();
  /**
   * The child's stderr, kept so a transport failure can say WHY.
   *
   * Reported from a real attempt: every test of one machine failed with a bare `exit code: 255`. The reason —
   * `Host key verification failed` — was printed by ssh on stderr and thrown away, so the fault was invisible and
   * the recovery below had nothing to recognise. A capped buffer, because this is a diagnostic and not a log.
   */
  const stderrChunks = [];
  let stderrLength = 0;
  const onStderr = (chunk) => {
    if (stderrLength > MAX_STDERR_CHARS) return;
    const text = String(chunk);
    stderrLength += text.length;
    stderrChunks.push(text);
  };

  let handle;
  try {
    handle = await startMachineRun(deps, machine, {
      signal: controller.signal,
      prompt: '',
      handshakeOnly: true,
      stopAfterInitialize: !hasPinnedWorkspace(machine),
      onStderr,
    });
  } catch (error) {
    return { ok: false, stage: 'spawn', target: machineTarget(machine), message: String(error) };
  }
  try {
    const outcome = await handle.result;
    const stderr = stderrChunks.join('').trim();
    if (outcome.stopReason !== 'completed') {
      // The ssh output is appended to the diagnostic rather than replacing it: the wrapper sentence says which
      // stage failed, and the child's own words say why. Both are needed to act.
      const base = outcome.diagnostic ?? `the remote agent stopped with ${outcome.stopReason} ／ 远端 agent 异常停止（${outcome.stopReason}）`;
      return {
        ok: false,
        stage: 'handshake',
        target: machineTarget(machine),
        elapsedMs: Date.now() - started,
        message: stderr === '' ? base : `${base}\n${stderr.slice(0, MAX_STDERR_CHARS)}`,
      };
    }
    return {
      ok: true,
      stage: 'handshake',
      target: machineTarget(machine),
      agent: outcome.agent,
      toolName: machine.toolName,
      sessionStarted: outcome.sessionStarted === true,
      elapsedMs: Date.now() - started,
      message: outcome.sessionStarted === true
        ? `ssh + ACP handshake succeeded (${outcome.agent ?? 'unknown agent'}) ／ ssh + ACP 握手成功（${outcome.agent ?? '未知 agent'}）`
        : `ssh + ACP initialize succeeded (${outcome.agent ?? 'unknown agent'}); no workspace is configured for this machine, so no session was created ／ ssh + ACP 初始化成功（${outcome.agent ?? '未知 agent'}）；这台机器没有配置工作目录，所以没有创建会话`,
    };
  } finally {
    await handle.dispose();
  }
}

/**
 * Forget the stored host key for one machine, and report the fingerprint that replaces it.
 *
 * The fingerprint is read back so the operator is told what the address now presents — a recovery that said only
 * "done" would hide the one fact that makes an unexpected change detectable. `ssh-keyscan` writes the key in
 * `known_hosts` form and `ssh-keygen -lf` turns it into the same `SHA256:…` string the prompt asks the machine
 * for, so the two can be compared directly.
 *
 * @param deps - host seams: `{ subprocess, settings }`.
 * @param machine - normalized machine record.
 * @returns `{ ok, fingerprint?, detail }`.
 */
async function forgetHostKey(deps, machine) {
  const settings = deps.settings?.() ?? {};
  const sshCommand = typeof settings.sshCommand === 'string' && settings.sshCommand !== '' ? settings.sshCommand : 'ssh';
  // `ssh-keygen` and `ssh-keyscan` ship beside `ssh`, and the settings name only the latter.
  const separator = sshCommand.includes('\\') ? '\\' : '/';
  const beside = (name) => (sshCommand.includes(separator)
    ? `${sshCommand.slice(0, sshCommand.lastIndexOf(separator) + 1)}${name}`
    : name);
  const keygen = beside('ssh-keygen');
  const keyscan = beside('ssh-keyscan');
  const port = machine.port ?? 22;

  const local = async (argv) => await runCommandCollect((spec) => deps.subprocess.spawn(spec), argv);

  try {
    const result = await local(forgetHostKeyArgv(keygen, machine.host, port));
    // `ssh-keygen -R` exits non-zero when the host was not present, which is not a failure here: the goal is that
    // no stale entry remains, and an absent one already satisfies it.
    if (result.started === false || (result.code !== 0 && !/not found in/i.test(`${result.stderr}`))) {
      return { ok: false, detail: `could not forget the stored host key: ${`${result.stderr}`.trim().slice(0, 300)}` };
    }
  } catch (error) {
    return { ok: false, detail: `could not forget the stored host key: ${String(error)}` };
  }

  // Best effort from here: a fingerprint that cannot be read must not turn a successful recovery into a failure.
  let fingerprint;
  try {
    const scan = await local([keyscan, '-p', String(port), '-T', '10', machine.host]);
    const line = `${scan.stdout}`.split('\n').find((entry) => entry.trim() !== '' && !entry.startsWith('#'));
    if (line !== undefined) {
      // `ssh-keygen -lf -` would read the key from stdin, but the spawn seam's stdio is `ignore` by design, so the
      // scanned line goes to a temp file instead. Removed in `finally` so a failure cannot leave it behind.
      const path = join(tmpdir(), `fleet-keyscan-${String(process.pid)}-${String(Date.now())}.pub`);
      try {
        await writeFile(path, `${line}\n`, 'utf8');
        const result = await local([keygen, '-lf', path]);
        const first = `${result.stdout}${result.stderr}`.trim().split('\n')[0];
        fingerprint = first === '' ? undefined : first;
      } finally {
        await rm(path, { force: true });
      }
    }
  } catch {
    // Left undefined on purpose: the report then says the key changed without pretending to know the new one.
  }
  return { ok: true, fingerprint, detail: 'the stored host key no longer matched, so it was forgotten and the address was trusted again' };
}

/** Convert plain text into the harness content blocks the tool result carries. */
function textBlocks(text) {
  return text === '' ? [] : [{ type: 'text', text }];
}

/**
 * Whether delegation tools advertise `run_in_background`.
 *
 * On: the job-read path is healthy on a clean registry — `job_output` and `job_list` both answer for
 * a `pwsh` job and for a delegated job this plugin started.
 *
 * An earlier run of this plugin saw `value is not lossless JSON` from both tools. That was not a
 * payload or schema problem. A job whose plugin generation is released while it is still running is
 * left with a `done` that never settles, and ONE such orphaned record makes `job_list` fail for every
 * job, because it serializes the whole registry. So the thing to avoid is reloading a generation that
 * still owns live jobs — the reads themselves are fine.
 *
 * Set this to `false` to withdraw the parameter from the model without deleting the implementation.
 */
export const EXPOSE_BACKGROUND_DELEGATION = true;

/**
 * Build the model-facing delegation tool bound to one machine.
 *
 * The definition is hand-written rather than produced by a helper, so the plugin depends on no
 * tool-authoring package: the registry requires `name`, `description`, `parameters`, and
 * `output: { schema, render }`.
 *
 * `run_in_background` is advertised only when {@link EXPOSE_BACKGROUND_DELEGATION} is on AND this
 * composition has the `jobs` service; the parameter is then accepted, and asking for it without that
 * service fails loudly instead of silently running in the foreground.
 *
 * @param deps - the plugin's context slice.
 * @param machine - normalized machine record.
 * @param options - `background: true` forces the parameter on regardless of the exposure switch,
 *   which is how the implementation is tested while the switch is off.
 * @returns a `ctx.tools.register` definition.
 */
export function machineToolDefinition(deps, machine, options = {}) {
  const label = machine.label === machine.id ? machine.id : `${machine.label} (${machine.id})`;
  const detail = machine.description === '' ? '' : ` ${machine.description}`;
  const target = machineTarget(machine);
  const backgroundCapable = () => {
    // An explicit option wins over the module switch, so both directions are testable.
    const exposed = typeof options.background === 'boolean' ? options.background : EXPOSE_BACKGROUND_DELEGATION;
    if (!exposed) return false;
    const jobs = deps.jobs;
    return jobs !== undefined && typeof jobs.start === 'function';
  };

  /** The remote answer as plain text. */
  const answerText = (outcome) => outcome.output
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  /** The failure headline, with the diagnostic and any partial answer preserved. */
  const failureText = (outcome, text) => `delegation to ${target} ended abnormally (${outcome.stopReason})`
    + (outcome.diagnostic === undefined ? '' : `\nDiagnostic: ${outcome.diagnostic}`)
    + (text === '' ? '' : `\nPartial output before the run ended:\n${text}`)
    + `\n／ 派往 ${target} 的委派异常结束（${outcome.stopReason}）`
    + (outcome.diagnostic === undefined ? '' : `\n诊断信息：${outcome.diagnostic}`)
    + (text === '' ? '' : `\n任务结束前的部分输出：\n${text}`);

  /** Settle one run into the flat payload a foreground call returns. */
  async function settle(run) {
    let outcome;
    try {
      outcome = await run.result;
    } finally {
      await run.dispose();
    }
    const text = answerText(outcome);
    if (outcome.stopReason !== 'completed') throw new Error(failureText(outcome, text));
    return {
      machine: machine.id,
      target,
      runId: String(run.id),
      stopReason: outcome.stopReason,
      output: textBlocks(text),
      ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
    };
  }

  /**
   * Settle one run into the OUTCOME a background job must resolve to.
   *
   * The registry reads this value as the job's terminal state — `job.status = outcome.status`,
   * `job.result = outcome.result` — so it must be an object carrying a status. A bare string here
   * leaves `status` undefined, the job never becomes terminal, and the resulting record is not
   * lossless JSON (an `undefined` field is illegal), which breaks `job_output` for that job and
   * `job_list` for every job in the registry.
   *
   * This mirrors the seam's own mapping in `runOutcome`: a clean stop yields `{ status: 'completed',
   * result }`; a cancelled run yields `{ status: 'killed' }`; anything else yields
   * `{ status: 'failed', detail }`.
   *
   * @param run - the started run.
   * @returns the outcome object that becomes the job's terminal state.
   */
  async function settleOutcome(run) {
    let outcome;
    try {
      outcome = await run.result;
    } catch (error) {
      return { status: 'failed', detail: String(error?.message ?? error) };
    }
    try {
      await run.dispose();
    } catch (error) {
      return { status: 'failed', detail: `dispose failed: ${String(error)}` };
    }
    const text = answerText(outcome);
    if (outcome.stopReason === 'completed') return { status: 'completed', result: text };
    if (outcome.stopReason === 'aborted' && outcome.diagnostic === undefined) return { status: 'killed' };
    return { status: 'failed', detail: failureText(outcome, text) };
  }

  return {
    name: machine.toolName,
    description:
      `Delegate a self-contained task to the agent running on machine ${label} at ${target} over SSH/ACP.${detail} `
      + 'The remote agent runs in its own session on THAT machine and returns only its final answer; its tool '
      + 'traffic and reasoning stay there. '
      + (machine.cwd === ''
        ? 'It starts in the same working directory as this session, but that directory is on this machine — '
        : `It starts in its own working directory on that machine (${machine.cwd}) — `)
      + 'so give absolute paths for anything it must reach, and state the whole task, because it sees nothing from this conversation. '
      + 'An environment preamble is prepended to `prompt` automatically: do NOT repeat those environment facts or working rules in the task you write.'
      + (backgroundCapable() ? ' Set `run_in_background: true` to return a job id immediately and collect the answer later with job_output.' : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the remote agent. Use absolute paths; it cannot see this conversation.',
        },
        ...backgroundCapable() ? {
          run_in_background: {
            type: 'boolean',
            description: 'Run as a background job and return its id (collect with job_output, stop with job_kill). Defaults to false.',
          },
        } : {},
      },
      required: ['description', 'prompt'],
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              machine: { type: 'string' },
              target: { type: 'string' },
              runId: { type: 'string' },
              stopReason: { type: 'string' },
              // Content blocks are heterogeneous (`{type:'text',text}` and friends), so each item is
              // an open object: the tool registry validates this schema and rejects an unknown
              // `type` name such as `json`.
              output: { type: 'array', items: { type: 'object' } },
              diagnostic: { type: 'string' },
            },
            required: ['machine', 'target', 'runId', 'stopReason', 'output'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string' },
              jobId: { type: 'string' },
              machine: { type: 'string' },
              target: { type: 'string' },
            },
            required: ['kind', 'jobId', 'machine', 'target'],
          },
        ],
      },
      render: (_args, value) => textBlocks(value.kind === 'background'
        ? `started background delegation to ${String(value.target)} as job ${String(value.jobId)}; collect it with job_output`
        : value.output.map((block) => (block?.type === 'text' ? block.text : '')).join('')),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') {
        throw new Error(`${machine.toolName}: \`prompt\` is required ／ \`prompt\` 是必填项`);
      }
      const requestedBackground = Object.hasOwn(args ?? {}, 'run_in_background') && args.run_in_background === true;
      const label2 = typeof args.description === 'string' && args.description !== '' ? args.description : machine.toolName;

      if (requestedBackground && !backgroundCapable()) {
        // Never treat a background request as a foreground one: that would silently change what the
        // caller asked for, and the caller would wait for a result it expected to collect later.
        throw new Error(
          `${machine.toolName}: \`run_in_background\` is not available here — `
          + (EXPOSE_BACKGROUND_DELEGATION
            ? 'this composition provides no jobs service, so the run is kept in the foreground'
            : 'background delegation is disabled in this build')
          + ' ／ `run_in_background` 在这里不可用 —— '
          + (EXPOSE_BACKGROUND_DELEGATION
            ? '这个组合没有提供 jobs 服务，所以任务只能在前台跑'
            : '这个构建里后台派活是关闭的'),
        );
      }

      if (!requestedBackground) {
        return settle(await deps.subagents.start(providerNameFor(machine), {
          label: label2,
          prompt: [{ type: 'text', text: composeRemotePrompt(machine, args.prompt) }],
          parent: exec.agent,
          signal: exec.signal,
        }));
      }

      const jobs = deps.jobs;
      if (jobs === undefined || typeof jobs.start !== 'function') {
        throw new Error(`${machine.toolName}: \`run_in_background\` requires the jobs service, which this composition does not provide ／ \`run_in_background\` 需要 jobs 服务，而这个组合没有提供`);
      }
      // A job is owned by the session that started it and only that owner can collect or stop it, so
      // a tool call with no calling agent cannot start one.
      if (exec.agent === undefined) {
        throw new Error(`${machine.toolName}: \`run_in_background\` requires a calling agent (exec.agent was undefined) ／ \`run_in_background\` 需要有一个调用方 agent（exec.agent 是 undefined）`);
      }
      // The job owns its own cancellation channel, so a remote run outlives the tool call that
      // started it and can be stopped with job_kill.
      const controller = new AbortController();
      const jobId = jobs.start({
        kind: 'subagent',
        label: label2,
        owner: exec.agent.id,
        run: (handle) => ({
          cancel: (reason) => {
            controller.abort(reason ?? 'background delegation killed');
          },
          done: (async () => {
            let run;
            try {
              run = await deps.subagents.start(providerNameFor(machine), {
                label: label2,
                prompt: [{ type: 'text', text: composeRemotePrompt(machine, args.prompt) }],
                parent: exec.agent,
                signal: controller.signal,
              });
            } catch (error) {
              // A background job reports failure through its settled value, never a rejection.
              return { status: 'failed', detail: String(error?.message ?? error) };
            }
            const outcome = await settleOutcome(run);
            // Mirror the outcome into the job's output ring so observers and the UI see the same
            // thing the model collects, while the outcome object carries the job's terminal state.
            if (outcome.status === 'completed') handle?.append(`${String(outcome.result)}\n`, { channel: 'stdout' });
            else if (outcome.detail !== undefined) handle?.append(`${String(outcome.detail)}\n`, { channel: 'stderr' });
            return outcome;
          })(),
        }),
      });
      return { kind: 'background', jobId: String(jobId), machine: machine.id, target };
    },
  };
}
