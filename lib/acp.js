/**
 * Minimal ACP (Agent Client Protocol) driver over newline-delimited JSON-RPC 2.0.
 *
 * This is the same wire the shipped `@deepseek-ai/dsh-subagent-acp` package speaks, implemented
 * here with Node built-ins only so the fleet plugin carries no package dependency: the protocol
 * is small and fully specified, and one implementer keeps parent and child in step.
 *
 * Validated against a real DSH 0.2.0-rc.2 child over SSH: `initialize` -> `session/new` ->
 * `session/prompt` streams `session/update` notifications carrying `agent_message_chunk` text and
 * settles with a `session/prompt` result whose `stopReason` is `end_turn`.
 *
 * @module dsh-fleet/acp
 */
import { randomUUID } from 'node:crypto';

/** ACP wire protocol version implemented by this driver. */
export const ACP_PROTOCOL_VERSION = 1;

/** Methods the child (agent) accepts from us (client). */
const AGENT = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
};

/** Methods we accept from the child. */
const CLIENT = {
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
};

/**
 * Normalize the stdio member the subprocess seam exposed into an async iterable of bytes.
 * The seam hands back raw streams without narrowing their flavor, and a defensive conversion
 * costs nothing when the stream is already a Node Readable.
 *
 * @param stream - the handle's `stdout`.
 * @returns an async iterable yielding Uint8Array chunks.
 */
export function byteIterable(stream) {
  if (stream === undefined || stream === null) throw new Error('acp: the child exposed no stdout stream ／ 子进程没有暴露 stdout 流');
  if (typeof stream[Symbol.asyncIterator] === 'function') return stream;
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value !== undefined) yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }
  throw new Error('acp: unrecognized stdout stream flavor ／ 无法识别的 stdout 流类型');
}

/**
 * Build the write half of the protocol channel from a subprocess handle's stdin.
 *
 * A missing stream, a closed stream, and a stream that reports an error are all recorded as the
 * channel's failure. That matters because the failure is reported back through `send`, which fails
 * every pending request instead of letting a write go nowhere and leaving the caller waiting.
 *
 * @param stdin - the handle's `stdin`.
 * @returns `write`, `end`, and a `failed` accessor reporting the first write failure.
 */
export function stdinChannel(stdin) {
  if (stdin === undefined || stdin === null) throw new Error('acp: the child exposed no stdin stream ／ 子进程没有暴露 stdin 流');
  let failure;
  stdin.on?.('error', (error) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  });
  const write = (text) => {
    if (failure !== undefined) return;
    try {
      // `write` returns false for backpressure and throws (or emits) once the pipe is gone; both
      // mean the protocol channel can no longer carry a request.
      stdin.write(text);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  };
  const end = () => {
    try {
      stdin.end();
    } catch {
      // The child may already be gone; EOF is best effort.
    }
  };
  return { write, end, failed: () => failure };
}

/** Collect the text of an ACP content block; non-text blocks contribute nothing. */
function contentText(content) {
  return content !== null && typeof content === 'object' && content.type === 'text' && typeof content.text === 'string'
    ? content.text
    : '';
}

/** Map an ACP stop reason onto the harness vocabulary. */
export function acpStopReason(reason) {
  switch (reason) {
    case 'end_turn': return 'completed';
    case 'max_tokens': return 'max-tokens';
    case 'refusal': return 'refusal';
    case 'cancelled': return 'aborted';
    default: return 'error';
  }
}

/** Select the first permission option that grants access. */
function allowOption(options) {
  if (!Array.isArray(options)) return undefined;
  return options.find((option) => option?.kind === 'allow_once' || option?.kind === 'allow_always');
}

/** Default bound on reaching a ready remote session; long-running prompts are not bounded by it. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;

/**
 * Spawn one ACP child and drive it to a terminal result.
 *
 * The returned promise resolves only with a terminal run outcome; every failure before the run is
 * published rejects. The caller owns disposal: `dispose()` ends the child's stdin, waits out the
 * EOF grace, then escalates through `terminate()`.
 *
 * A startup watchdog guarantees the handshake settles: this promise must never stay pending,
 * because its callers are tool invocations a person is waiting on. A transport that closes without
 * an exit fact (an unreachable or wedged ssh being the observed case) is turned into a typed
 * `stage: initialize` failure and the child is terminated.
 *
 * @param options - spawn seam, process spec, and the run's cancellation signal.
 * @returns the run handle: `result` (never rejects after publication), `diagnostic`, and `dispose`.
 */
export async function runAcpChild(options) {
  const {
    spawn,
    argv,
    cwd,
    env,
    permission,
    graceMs,
    eofGraceMs,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    signal,
    onStderrChunk,
  } = options;

  if (signal.aborted) throw new Error('fleet: the delegation was cancelled before the remote agent started ／ 在远程 agent 启动之前，这次派活已被取消');

  const child = spawn({
    argv,
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: onStderrChunk === undefined ? 'inherit' : 'pipe' },
    graceMs,
    env,
  });

  const channel = stdinChannel(child.stdin);
  const stdin = child.stdin;
  const stdout = byteIterable(child.stdout);
  if (onStderrChunk !== undefined && child.stderr !== undefined) {
    void (async () => {
      try {
        for await (const chunk of byteIterable(child.stderr)) onStderrChunk(Buffer.from(chunk).toString('utf8'));
      } catch {
        // Diagnostic only.
      }
    })();
  }

  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let diagnostic;
  const outputChunks = [];

  const terminateImmediately = () => {
    try {
      child.terminate();
    } catch {
      // Already terminated.
    }
  };

  const send = (frame) => {
    if (closed) return;
    channel.write(`${JSON.stringify(frame)}\n`);
    const failure = channel.failed();
    if (failure !== undefined) {
      closed = true;
      terminateImmediately();
      for (const [, entry] of pending) entry.reject(failure);
      pending.clear();
    }
  };

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: '2.0', id, method, params });
  });

  const answer = (id, result) => send({ jsonrpc: '2.0', id, result });

  let sessionId;
  const handleFrame = (frame) => {
    if (typeof frame !== 'object' || frame === null) return;

    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const entry = pending.get(frame.id);
      if (entry === undefined) return;
      pending.delete(frame.id);
      if (frame.error !== undefined) entry.reject(new Error(`acp ${entry.method}: ${JSON.stringify(frame.error)}`));
      else entry.resolve(frame.result);
      return;
    }

    if (frame.method === CLIENT.sessionUpdate) {
      const update = frame.params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk') outputChunks.push(contentText(update.content));
      return;
    }

    if (frame.method === CLIENT.requestPermission) {
      const allow = permission === 'allow' ? allowOption(frame.params?.options) : undefined;
      answer(frame.id, allow === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: allow.optionId } });
      return;
    }

    if (frame.id !== undefined && typeof frame.method === 'string') {
      // An unrecognized client-side request must still be answered, or the child waits forever.
      answer(frame.id, {});
      return;
    }
  };

  const pump = (async () => {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      for await (const chunk of stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === '') continue;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            // A stray non-protocol line on stdout is not fatal; the child's own logs go to stderr.
            continue;
          }
          handleFrame(frame);
        }
      }
    } catch (error) {
      diagnostic ??= `acp: reading the child stream failed (${String(error)})`;
    }
  })();

  const processDone = Promise.resolve(child.done).then(
    (outcome) => ({ ok: true, outcome }),
    (error) => ({ ok: false, error }),
  );

  /**
   * A child that exits takes every unanswered request with it.
   *
   * Without this, a machine that is unreachable (ssh failing after its own connect timeout) leaves
   * the handshake promise pending forever and the delegation tool never returns. Rejecting on exit
   * turns "the process is gone" into a diagnosis instead of a hang.
   */
  let exitSettled;
  const failPending = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    // Marked so the settle path reports the process exit immediately instead of waiting out a grace
    // period for facts it already has.
    error.exitObserved = true;
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };
  void processDone.then((settled) => {
    exitSettled = settled;
    const code = settled.ok ? settled.outcome?.exitCode : undefined;
    failPending(new Error(
      settled.ok
        ? `the remote agent process exited before answering (exit code: ${String(code ?? 'none')}) ／ 远程 agent 进程还没应答就退出了（退出码：${String(code ?? '无')}）`
        : `the remote agent process failed: ${String(settled.error)} ／ 远程 agent 进程失败：${String(settled.error)}`,
    ));
  });

  const abort = new AbortController();
  const onAbort = () => {
    if (sessionId !== undefined) send({ jsonrpc: '2.0', method: AGENT.sessionCancel, params: { sessionId } });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  abort.signal.addEventListener('abort', onAbort, { once: true });

  /**
   * Bound the startup window.
   *
   * This is the guarantee that the returned result always settles: an unreachable or wedged
   * transport can close the protocol stream without ever producing a process-exit fact, and a tool
   * call must never stay pending on one. The timer is cleared once a session exists, because a
   * remote agent's own turn may legitimately run far longer than a connection handshake ever should.
   */
  let startupTimedOut = false;
  const clearStartupTimer = () => clearTimeout(startupTimer);
  const startupTimer = setTimeout(() => {
    if (sessionId !== undefined) return;
    startupTimedOut = true;
    failPending(new Error(
      `the remote agent did not complete the ACP handshake within ${String(startupTimeoutMs)}ms `
      + '(ssh unreachable, the remote profile not serving ACP, or a stalled transport)'
      + ` ／ 远程 agent 在 ${String(startupTimeoutMs)}ms 内没有完成 ACP 握手`
      + '（ssh 连不上、远程 profile 没有提供 ACP，或者传输卡住了）',
    ));
    // Even an exit that never arrives must not strand the caller: end the child outright.
    terminateImmediately();
  }, startupTimeoutMs);
  startupTimer.unref?.();

  const settle = async () => {
    let observedAgent;
    try {
      const init = await request(AGENT.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const agentName = init?.agentInfo?.name;
      if (typeof agentName !== 'string') {
        throw new Error('fleet: the remote agent did not complete the ACP handshake ／ 远程 agent 没有完成 ACP 握手');
      }
      observedAgent = agentName;

      // A reachability probe can stop here: `initialize` already proves the transport works, that the
      // remote command runs, and that it serves ACP. Creating a session additionally requires a
      // workspace that exists on the REMOTE machine, which a probe has no way to know.
      if (options.stopAfterInitialize === true) {
        clearStartupTimer();
        return { text: '', stopReason: 'completed', diagnostic: undefined, agent: observedAgent, sessionStarted: false };
      }

      const session = await request(AGENT.sessionNew, { cwd: options.remoteWorkspace ?? cwd, mcpServers: [] });
      const remoteSessionId = session?.sessionId;
      if (typeof remoteSessionId !== 'string') throw new Error('fleet: the remote agent published no session id ／ 远程 agent 没有返回 session id');
      sessionId = remoteSessionId;
      // The remote session exists, so the handshake is done and the run may take as long as it takes.
      clearStartupTimer();

      if (options.handshakeOnly === true) {
        return { text: '', stopReason: 'completed', diagnostic: undefined, agent: observedAgent, sessionStarted: true };
      }

      if (signal.aborted) {
        return { text: '', stopReason: 'aborted', diagnostic: undefined, agent: observedAgent };
      }

      const prompt = await request(AGENT.sessionPrompt, {
        sessionId,
        prompt: [{ type: 'text', text: options.prompt }],
      });
      return {
        text: outputChunks.join(''),
        stopReason: acpStopReason(prompt?.stopReason),
        diagnostic,
        agent: observedAgent,
      };
    } catch (error) {
      // The process exit has already been observed when the failure came from a rejected pending
      // request, so there is nothing left to wait for; otherwise give the child its grace window to
      // report structured exit facts.
      const exit = error?.exitObserved === true
        ? exitSettled
        : await Promise.race([
          processDone,
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(undefined), graceMs);
            timer.unref?.();
          }),
        ]);
      const exitFact = exit?.ok === true && exit.outcome !== undefined
        ? `; exit code: ${String(exit.outcome.exitCode ?? 'none')}`
        : '';
      const stage = sessionId === undefined ? 'initialize' : 'prompt';
      // A startup timeout is its own category: it means the transport never answered at all, which
      // is a different diagnosis from a child that answered and then failed.
      const category = signal.aborted ? 'cancelled' : startupTimedOut ? 'startup-timeout' : 'transport';
      return {
        text: outputChunks.join(''),
        stopReason: signal.aborted ? 'aborted' : 'error',
        diagnostic: `Subagent failure (provider: fleet-acp; stage: ${stage}; category: ${category}${exitFact}) ／ 子 agent 失败（provider: fleet-acp；阶段：${stage}；类别：${category}${exitFact}）`,
        agent: observedAgent,
        cause: error,
      };
    } finally {
      clearStartupTimer();
    }
  };

  let disposal;
  const dispose = () => {
    disposal ??= (async () => {
      closed = true;
      clearStartupTimer();
      signal.removeEventListener('abort', onAbort);
      channel.end();
      const exited = await Promise.race([
        processDone.then(() => true, () => true),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), eofGraceMs);
          timer.unref?.();
        }),
      ]);
      if (!exited) {
        terminateImmediately();
        await Promise.race([
          processDone.then(() => true, () => true),
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), graceMs);
            timer.unref?.();
          }),
        ]);
      }
      abort.abort();
      void pump.catch(() => {});
    })();
    return disposal;
  };

  // Started last: `settle` may resolve synchronously against an already-recorded process exit, and
  // the exit recorder plus the startup watchdog must exist by then. Only STARTUP is bounded — a
  // remote agent's own turn is deliberately unbounded, because a real task may take hours.
  const result = settle();

  return {
    name: options.name ?? 'fleet-acp',
    runId: randomUUID(),
    result,
    dispose,
    cancel: () => abort.abort(),
  };
}
