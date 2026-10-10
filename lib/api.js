/**
 * The settings panel's Host door: a small JSON endpoint on the harness's own web server.
 *
 * The panel could have used a Typert Remote namespace, but that protocol's package ships only
 * inside the desktop application's `app.asar`, so a profile-installed plugin cannot import it and
 * cannot construct a Remote service. A named web route needs no import beyond the `webServer`
 * service the Host already publishes, so the panel reaches the same runtime the `fleet_*` tools use
 * through one documented extension point.
 *
 * The route lives on whatever interface the harness already serves (`127.0.0.1` by default), and
 * every request is handled by the same validated operations the tools call.
 *
 * @module dsh-fleet/api
 */

import { pruneMachine } from './prune.js';
import { ProgressListener } from './progress.js';
import { interpretPayload } from './pairing.js';
import { buildLocalSetupPrompt, buildSetup, generateKey, inspectEnvironment, listPrivateKeys, resolveKey } from './setup.js';
import { PromptShare } from './share.js';

/** The exact path the panel calls. */
export const API_PATH = '/fleet/api';

/** One share per profile: the panel only ever shows one URL at a time. */
const share = new PromptShare();

/** The reporting listener. One per profile, like the share: the panel shows one pairing at a time. */
const progress = new ProgressListener();

/**
 * Stop serving any published prompt, and stop accepting reports.
 *
 * Called when the plugin's registrations are released: both listeners belong to the plugin's lifetime, so
 * disabling the plugin row must not leave a port open on the local network.
 *
 * @returns a promise that settles once both listener are closed.
 */
export async function closePromptShare() {
  await share.close();
  await progress.close();
}

/** Refuse oversized bodies rather than buffering an accidental upload. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The pairing the panel is currently watching, so a status read needs no token.
 *
 * The token deliberately never leaves this process. Returning it to the client put it into `localStorage`, which
 * meant a controlled machine could still be holding the token of an EARLIER pairing — and that pairing, already
 * finished, accepted the report and answered success while doing nothing with it. The machine believed it had
 * reported; the pairing actually being watched had received nothing, and its last stage sat at "not reported"
 * forever. Keeping the token here removes the way that stale value could exist at all.
 */
let currentPairing;

/** Operations this endpoint exposes, mapped onto the runtime. */
const OPERATIONS = {
  async read(runtime) {
    return { ok: true, value: runtime.status() };
  },
  async save(runtime, body) {
    await runtime.apply(body?.document);
    return { ok: true, value: runtime.status() };
  },
  async upsert(runtime, body) {
    await runtime.upsertMachine(body?.machine);
    return { ok: true, value: runtime.status() };
  },
  async remove(runtime, body) {
    await runtime.removeMachine(body?.id);
    return { ok: true, value: runtime.status() };
  },
  async setDefaults(runtime, body) {
    await runtime.setDefaults(body?.patch ?? {});
    return { ok: true, value: runtime.status() };
  },
  async test(runtime, body) {
    return { ok: true, value: { results: await runtime.test(body?.id), state: runtime.status() } };
  },
  /**
   * Clear a machine's pile-up of ungrouped delegation sessions. LAB, Windows only.
   *
   * Runs the same code the `fleet_prune` tool runs, through `runtime.deps` rather than through the tool, so
   * the panel and the agent share one implementation. The machine's app goes down for the duration.
   *
   * @param runtime - the fleet runtime.
   * @param body - `{ id, keep? }`.
   * @returns `{ report, state }`.
   */
  async prune(runtime, body) {
    const id = body?.id;
    // `config()` is async; reading `.machines` off the promise is how a "no machine matches" error appears for
    // a machine that plainly exists.
    const config = await runtime.config();
    const machine = config.machines.find((entry) => entry.id === id || entry.toolName === id);
    if (machine === undefined) throw new Error(`fleet: no machine matches "${String(id)}" ／ 没有匹配 "${String(id)}" 的机器`);
    const keep = Number.isInteger(body?.keep) ? body.keep : undefined;
    const report = await pruneMachine(runtime.deps, machine, keep === undefined ? {} : { keep });
    return { ok: true, value: { report, state: runtime.status() } };
  },
  /**
   * Onboarding for the controlled side.
   *
   * `setup` reports where the key stands and returns the prompt to carry across; `key` performs the
   * one write this plugin ever does outside the workspace, and only when the panel explicitly asks
   * for it (the user pressed the button after reading what it does).
   */
  async setup(runtime, body) {
    const deps = { subprocess: runtime.subprocessService() };
    // The shared default key applies when the panel does not name one, so the wizard and the
    // `fleet_setup` tool agree on which key is being offered.
    const shared = (await runtime.config())?.defaults?.keyFile;
    const options = { ...body, keyFile: body?.keyFile ?? shared };
    const resolved = await resolveKey(deps, { sshDir: body?.sshDir, preferredKey: options.keyFile });
    const attempt = await buildSetup(deps, options);
    return {
      ok: true,
      value: {
        ...attempt,
        sshDir: resolved.sshDir,
        candidates: resolved.candidates,
        generated: resolved.generated,
      },
    };
  },
  /**
   * Serve the controlled-side prompt on the LAN for a bounded window.
   *
   * The prompt is built exactly as the copy-paste path builds it, so the two routes cannot drift. `host` is
   * used twice: to rank the controller's own addresses (only one on the controlled machine's network is
   * useful), and to name the sole reader the listener will answer.
   *
   * The address is short on purpose — `http://<ip>:<port>/` — because it gets typed on the other machine.
   * The bound that replaces a token is the closing time, so nothing stays listening.
   */
  async share(runtime, body) {
    const deps = { subprocess: runtime.subprocessService() };
    const shared = (await runtime.config())?.defaults?.keyFile;
    const attempt = await buildSetup(deps, { ...body, keyFile: body?.keyFile ?? shared });
    if (attempt.problem !== undefined) return { ok: true, value: { ...attempt, shared: false } };
    const published = await share.publish({
      prompt: attempt.prompt,
      minutes: body?.minutes,
      preferAddress: body?.host,
    });
    return { ok: true, value: { ...published, shared: true } };
  },
  /** Close the listener now, rather than waiting for the countdown. */
  async unshare() {
    const withdrawn = await share.withdraw();
    // Withdrawing the prompt withdraws the pairing too: nothing is being paired any more, so reports should be
    // refused rather than accepted into a run the operator has cancelled.
    if (currentPairing !== undefined) progress.consume(currentPairing);
    currentPairing = undefined;
    return { ok: true, value: { withdrawn, active: share.active } };
  },
  /**
   * Pair a machine: serve the prompt on the LAN AND open the channel it reports progress on.
   *
   * Two listeners with different lifetimes, which is why this is not just `share` plus a callback:
   *
   *   - the PROMPT is fetched once and is worthless afterwards, so its window is short and it closes on first
   *     read. Nothing stays listening on an address that has done its job.
   *   - the REPORTS arrive over however long the machine takes — on a bare machine, installing an SSH server
   *     first — so that listener stays up until the final report, a reported failure, or its deadline.
   *
   * The prompt that is served carries both, so the machine is told where to report before it starts.
   */
  async pair(runtime, body) {
    const deps = { subprocess: runtime.subprocessService() };
    const shared = (await runtime.config())?.defaults?.keyFile;
    const keyFile = body?.keyFile ?? shared;

    // The callback is opened FIRST, because its address and token go into the prompt: building the prompt
    // first would mean either building it twice or serving one that names a channel that does not exist yet.
    const opened = await progress.open({
      preferAddress: body?.host,
      minutes: body?.minutes,
      label: typeof body?.label === 'string' ? body.label : undefined,
      /**
       * The handshake: the machine's first report closes the prompt link.
       *
       * The prompt's lifetime is keyed on this rather than on a fetch, because a fetch proves only that some
       * request arrived. An agent whose fetch tool refuses private addresses still reaches the listener — its
       * first attempt was answered and closed the port, and its retry with a different tool found nothing
       * listening. A report cannot happen without the machine having read the prompt, so it is the first honest
       * evidence that the address has done its job.
       */
      onFirstReport: async () => { await share.close(); },
    });
    const callback = { url: opened.url, token: opened.token, address: opened.boundAddress };

    let attempt;
    try {
      attempt = await buildSetup(deps, { ...body, keyFile, callback, controllerAddress: opened.boundAddress });
    } catch (error) {
      // A prompt that cannot be built leaves a listener with nothing to report on: close it rather than let it
      // sit there until the deadline.
      progress.forget(opened.token);
      throw error;
    }
    if (attempt.problem !== undefined) {
      progress.forget(opened.token);
      return { ok: true, value: { ...attempt, shared: false } };
    }

    const published = await share.publish({
      prompt: attempt.prompt,
      minutes: body?.shareMinutes,
      preferAddress: body?.host,
      // Deliberately NOT `closeAfterFetch`. This listener stays up until the machine HANDSHAKES (its first
      // report, wired above), or until the window runs out — whichever comes first. Closing it on a fetch
      // punished the very machine it was serving: a fetch refused by the reader's own tooling still arrives here.
    });

    currentPairing = opened.token;

    return {
      ok: true,
      value: {
        shared: true,
        // What the operator reads out to the other machine.
        url: published.url,
        shareClosesAt: published.closesAt,
        // Where the machine reports. The TOKEN is not here on purpose — see `currentPairing`.
        reportUrl: opened.url,
        reportClosesAt: opened.closesAt,
        prompt: attempt.prompt,
        fingerprint: attempt.fingerprint,
        keyFile: attempt.keyFile,
      },
    };
  },
  /**
   * The state of one pairing, and the place a finished one is turned into a machine.
   *
   * The addition happens HERE rather than in a separate call, because the payload only exists once: polling is
   * what notices the final report, and re-deriving it later would mean holding the payload for a second
   * request that may never come.
   *
   * Adding is automatic only when the address is unambiguous. `host` is the one field the controlled machine
   * cannot verify, so when it reports several candidates the panel asks instead — guessing produces a machine
   * that looks ready and only ever answers "cannot connect".
   */
  async pairing(runtime, body) {
    // The caller's token is honoured when given, but the panel normally names none: it reads whichever pairing
    // this process opened, so a stale token held anywhere else cannot redirect what the operator is watching.
    const token = typeof body?.token === 'string' && body.token !== '' ? body.token : (currentPairing ?? '');
    const status = progress.status(token);
    if (status === undefined) return { ok: true, value: { active: false } };

    const state = { ...status, added: undefined, errors: undefined, needsChoice: undefined, machine: undefined, candidates: undefined };

    // A requested choice arrives with a host, and is honoured even for a payload that also had one candidate:
    // the operator overrode it.
    const chosen = typeof body?.host === 'string' && body.host.trim() !== '' ? body.host.trim() : undefined;

    // `incomplete` is a run that reported `pending`: everything it could do is done and the payload is here, so the
    // machine is added exactly as for `done`. What differs is only what the panel says about it — a step is still
    // owed, and hiding that would be worse than the step itself.
    if ((status.state === 'done' || status.state === 'incomplete') && status.payload !== undefined) {
      const interpreted = interpretPayload(chosen === undefined ? status.payload : { ...status.payload, host: chosen });
      state.needsChoice = interpreted.ok ? interpreted.needsChoice && chosen === undefined : undefined;
      state.candidates = interpreted.ok ? interpreted.candidates : undefined;
      if (!interpreted.ok) {
        state.errors = interpreted.errors;
      } else if (chosen !== undefined || !interpreted.needsChoice) {
        const machine = interpreted.machine;
        await runtime.upsertMachine(machine);
        // Verified immediately, so a machine that was added but cannot be reached says so here rather than
        // leaving the operator to discover it on the first delegation.
        let test;
        try {
          test = await runtime.test(machine.id ?? machine.label);
        } catch (error) {
          test = { ok: false, stage: 'add', message: error instanceof Error ? error.message : String(error) };
        }
        state.added = { machine, state: runtime.status(), test };
        /**
         * The pairing is marked CONSUMED, not forgotten.
         *
         * Forgetting it made a successful pairing look expired: the panel polls again a second later, finds no
         * such token, and reads `active: false` as "the deadline passed" — replacing the result it had just been
         * handed. The record stays queryable so every later poll keeps returning the same answer, and the
         * deadline sweep drops it like any other.
         */
        progress.consume(token);
      }
    }

    return { ok: true, value: state };
  },
  /**
   * Report the live offer, so the panel can show a countdown.
   *
   * `remainingMs` is computed from the listener's own closing time rather than from a timer in the panel,
   * so the countdown the operator sees is the same clock that will close the port.
   */
  async shared() {
    const offer = share.offer;
    if (offer === undefined) return { ok: true, value: { active: false } };
    return {
      ok: true,
      value: {
        active: true,
        url: share.port === undefined ? null : `http://${String(share.boundAddress)}:${String(share.port)}/${offer.token}`,
        boundAddress: share.boundAddress ?? null,
        port: share.port ?? null,
        reader: offer.reader ?? null,
        closesAt: offer.closesAt,
        remainingMs: Math.max(0, offer.closesAt - Date.now()),
      },
    };
  },
  /**
   * Whether this CONTROLLER has the SSH tools the plugin needs.
   *
   * Checked up front because a missing `ssh` otherwise surfaces much later as a bare spawn failure during
   * a delegation. When something is missing, the answer carries a prompt for the user to paste into a
   * session on this machine — installing an SSH client needs elevation, which that session can do and the
   * plugin cannot.
   */
  async environment(runtime) {
    const config = (await runtime.config())?.defaults;
    const inspected = await inspectEnvironment(
      { subprocess: runtime.subprocessService() },
      { sshCommand: config?.sshCommand },
    );
    return {
      ok: true,
      value: {
        ...inspected,
        prompt: inspected.ok ? undefined : buildLocalSetupPrompt(inspected),
      },
    };
  },
  /**
   * Generate a controller key pair.
   *
   * Always produces a NEW pair: the base name when it is free, otherwise a dated name beside it. An
   * existing key is never overwritten, because its public half may already be installed on prepared
   * machines.
   */
  async key(runtime, body) {
    return {
      ok: true,
      value: await generateKey({ subprocess: runtime.subprocessService() }, { sshDir: body?.sshDir }),
    };
  },
  /**
   * The private keys already on this controller.
   *
   * The client half has no file picker, so choosing a key means choosing from what exists here. An empty
   * list is a normal answer — it is the state in which the panel offers to generate one.
   */
  async keys(runtime, body) {
    return { ok: true, value: await listPrivateKeys({}, { sshDir: body?.sshDir }) };
  },
  /**
   * Report which revision is answering.
   *
   * Re-enabling the plugin row replaces this handler; reading the revision back is how that is
   * confirmed, instead of inferring it from behavior that a stale handler could imitate.
   */
  async version(runtime) {
    const runtimeVersion = typeof runtime.version === 'function' ? runtime.version() : {};
    return {
      ok: true,
      value: {
        ...runtimeVersion,
        apiRevision: 'api-r1',
        operations: Object.keys(OPERATIONS).sort(),
        storePath: runtime.storePath(),
      },
    };
  },
};

/** Read a request body under a hard bound. */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('fleet: request body is too large ／ 请求体太大了');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`fleet: request body is not valid JSON: ${error instanceof Error ? error.message : String(error)} ／ 请求体不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Answer one request with a JSON payload. */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Register the panel's endpoint.
 *
 * @param ctx - the Host context owning the route.
 * @param runtime - the fleet runtime the endpoint drives.
 * @returns a disposer removing the route, or `undefined` when this composition has no web server.
 */
export function registerFleetApi(ctx, runtime) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined || typeof webServer.register !== 'function') return undefined;

  const handle = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const operation = OPERATIONS[url.pathname.slice(API_PATH.length).replace(/^\//, '') || 'read'];
    if (operation === undefined) {
      sendJson(response, 404, { ok: false, error: `unknown fleet operation: ${url.pathname} ／ 未知的 fleet 操作：${url.pathname}` });
      return;
    }
    if (request.method !== 'POST' && request.method !== 'GET') {
      sendJson(response, 405, { ok: false, error: `method not allowed: ${String(request.method)} ／ 不允许的方法：${String(request.method)}` });
      return;
    }
    try {
      const body = request.method === 'POST' ? await readBody(request) : {};
      sendJson(response, 200, await operation(runtime, body));
    } catch (error) {
      ctx.logger.warn('fleet: %s failed: %o ／ %s 执行失败：%o', url.pathname, error);
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  try {
    return webServer.register({ kind: 'prefix', path: API_PATH, handler: handle });
  } catch (error) {
    // A route with this (kind, path) is already installed, which the web server treats as a
    // composition error. Reaching here means a stale route survived a re-activation, and that route
    // would keep answering every request with the previous implementation while everything else looks
    // healthy — so the failure is surfaced in the log rather than silently leaving the panel stale.
    ctx.logger.warn('fleet: the settings endpoint could not be registered, so the previous one keeps answering: %s ／ 设置面板的接口没能注册上，所以仍然由上一个接口应答：%s', String(error?.message ?? error));
    return undefined;
  }
}
