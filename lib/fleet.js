/**
 * Fleet runtime: turn one machine record into one `ctx.subagents` provider plus one delegation
 * tool, so the model addresses a machine by name without any hand-written loader rows.
 *
 * @module dsh-fleet/fleet
 */
import { runAcpChild } from './acp.js';
import { MACHINE_DEFAULTS, normalizeMachine } from './store.js';

/** Providers advertise no parent-enforced start capability: the child is a separate process. */
const NO_CAPABILITIES = Object.freeze({
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

/** Human-readable one-line address of a machine. */
export function machineTarget(machine) {
  return `${machine.user}@${machine.host}${machine.port === 22 ? '' : `:${machine.port}`}`;
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
    onStderrChunk: deps.onStderr,
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
  // A probe has no delegating session, so it has nothing to offer as the remote workspace. With a pinned `cwd`
  // on the record, that path is offered instead; otherwise the probe verifies everything up to session creation
  // and says so, rather than inventing a path. The local half needs no configuration either way.
  const controller = new AbortController();
  let handle;
  try {
    handle = await startMachineRun(deps, machine, {
      signal: controller.signal,
      prompt: '',
      handshakeOnly: true,
      stopAfterInitialize: !hasPinnedWorkspace(machine),
    });
  } catch (error) {
    return { ok: false, stage: 'spawn', target: machineTarget(machine), message: String(error) };
  }
  try {
    const outcome = await handle.result;
    if (outcome.stopReason !== 'completed') {
      return {
        ok: false,
        stage: 'handshake',
        target: machineTarget(machine),
        elapsedMs: Date.now() - started,
        message: outcome.diagnostic ?? `the remote agent stopped with ${outcome.stopReason} ／ 远端 agent 异常停止（${outcome.stopReason}）`,
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
      + 'so give absolute paths for anything it must reach, and state the whole task, because it sees nothing from this conversation.'
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
          prompt: [{ type: 'text', text: args.prompt }],
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
                prompt: [{ type: 'text', text: args.prompt }],
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
