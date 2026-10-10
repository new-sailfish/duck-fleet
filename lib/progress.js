/**
 * The callback channel a controlled machine reports progress on. Part of the pairing flow.
 *
 * ## Why there are two listeners rather than one
 *
 * The prompt is fetched ONCE and is worth nothing afterwards; the reports arrive MANY times over however long
 * the machine takes, which on a bare machine means installing an SSH server first. One listener cannot have
 * both lifetimes: a window short enough for the prompt is too short for the reports, and one long enough for
 * the reports leaves the prompt fetchable for the whole run. So they are separate servers on separate ports,
 * and the prompt carries both addresses.
 *
 * ## Access
 *
 * This listener binds a real interface, because the harness web server binds `127.0.0.1` and the machine could
 * not reach it. Three properties bound the exposure:
 *
 *   - a RANDOM PORT chosen by the OS, not a well-known one;
 *   - a per-pairing TOKEN that every report must carry, compared in constant time;
 *   - a LIFETIME that ends when the final report arrives, when the machine reports a failure, or when the
 *     deadline passes — whichever happens first.
 *
 * The token is not merely a guard: it identifies WHICH pairing a report belongs to, so two machines pairing at
 * once cannot be confused for each other.
 *
 * @module dsh-duck-fleet/progress
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { localAddresses } from './share.js';

/**
 * The stages every pairing reports on, in order.
 *
 * Fixed rather than free-form: the panel draws this list before anything has been reported, which is what lets
 * it show "waiting" and "stuck" at all. A machine that invented its own names would leave the panel unable to
 * say whether a run had finished or stalled.
 */
export const STAGES = ['sshd', 'firewall', 'profile', 'key', 'verify', 'done'];

/**
 * Stage states a machine may report.
 *
 * `skipped` is not a failure: the prompt tells the machine to skip what is already satisfied.
 *
 * `started` exists because a stage can take minutes — installing an SSH server on a bare machine is the long
 * one — and a list that only receives results shows nothing at all for exactly the interval the operator is
 * most anxious about. A stage reports `started`, then later reports its result.
 *
 * `pending` is not a failure either, and it exists because of a real run: Windows accepted the OpenSSH Server
 * package, left the capability in `InstallPending` behind a required reboot, and the whole pairing was thrown
 * away along with everything the machine had already done — a firewall rule, an `acp` profile patch, an
 * installed key, a created workspace. A step waiting on a reboot is a step that is COMING, not one that failed,
 * and discarding the rest of the work over it makes the operator start again for no reason.
 *
 * `waiting` is NOT in this list: it is the panel's word for "this stage has not been heard from", and a machine
 * must not be able to report it.
 */
export const STAGE_STATES = ['started', 'ok', 'pending', 'fail', 'skipped'];

/** States that END a stage. `started` is a beginning, so it never closes anything. */
export const FINAL_STAGE_STATES = ['ok', 'pending', 'fail', 'skipped'];

/** How long a pairing may stay open with no report before the panel calls it stalled. */
export const DEFAULT_PAIRING_MINUTES = 60;
export const MIN_PAIRING_MINUTES = 5;
export const MAX_PAIRING_MINUTES = 24 * 60;

/** Refuse a report larger than this: the final payload is a handful of fields, not a document. */
const MAX_REPORT_BYTES = 64 * 1024;

/** Bound on how much explanation one stage may carry into the panel. */
const MAX_DETAIL_CHARS = 2000;

/** A per-pairing secret, long enough that guessing it is not a strategy. */
function pairingToken() {
  return randomBytes(16).toString('hex');
}

/** Compare two secrets without leaking where they first differ. */
function tokenMatches(expected, given) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Clamp a caller-supplied lifetime into the allowed window. */
function clampMinutes(value) {
  const minutes = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(minutes)) return DEFAULT_PAIRING_MINUTES;
  return Math.min(MAX_PAIRING_MINUTES, Math.max(MIN_PAIRING_MINUTES, minutes));
}

/**
 * The callback listener: one server, many concurrent pairings keyed by token.
 *
 * One server rather than one per pairing, because the port has to be advertised in a prompt that is written
 * before the machine answers — reopening a port per pairing would invalidate an address already handed out.
 */
export class ProgressListener {
  constructor() {
    this.server = undefined;
    this.port = undefined;
    this.boundAddress = undefined;
    this.pairings = new Map();
    this.timer = undefined;
  }

  /** Whether the listener is up. */
  get active() {
    return this.server !== undefined;
  }

  /**
   * Start the listener if it is not up, and open one pairing on it.
   *
   * @param options - `{ preferAddress, minutes, label, onFirstReport }`. `preferAddress` is the controlled
   *   machine's address, used only to pick which of this controller's interfaces to bind.
   * @returns `{ token, url, boundAddress, port, minutes, closesAt }`.
   */
  async open(options = {}) {
    await this.#ensureServer(options.preferAddress);
    const minutes = clampMinutes(options.minutes);
    const token = pairingToken();
    const pairing = {
      token,
      label: typeof options.label === 'string' && options.label !== '' ? options.label : undefined,
      openedAt: Date.now(),
      // The full window, kept so every report can push the deadline back by this much. Storing the duration
      // rather than only the first deadline is what makes the timeout measure SILENCE.
      minutes,
      closesAt: Date.now() + minutes * 60_000,
      stages: new Map(),
      payload: undefined,
      state: 'running',
      error: undefined,
      /** What the machine says must happen next, for a run that is `pending` rather than finished. */
      next: undefined,
      /**
       * Set once the record has been added.
       *
       * The pairing is KEPT after that, not forgotten. Forgetting it is what made a successful pairing appear to
       * have expired: the next poll found no such token, and the panel read that as "the deadline passed" and
       * overwrote the result it had just been given. A consumed pairing stays queryable and is swept by the
       * deadline like any other.
       */
      consumed: false,
      reports: 0,
      /**
       * Fires once, on the first report of any kind.
       *
       * This is the HANDSHAKE the prompt link waits for. A report proves the machine READ the prompt, which a
       * fetch does not: a fetch can be refused by the reader's own tooling — a blocked private address, for
       * instance — while still reaching this server. Keying the prompt's lifetime on "somebody connected" closed
       * the address the machine still needed, on the strength of a request that delivered nothing.
       */
      onFirstReport: typeof options.onFirstReport === 'function' ? options.onFirstReport : undefined,
      handshakeDone: false,
    };
    this.pairings.set(token, pairing);
    this.#arm();
    return {
      token,
      url: `http://${String(this.boundAddress)}:${String(this.port)}/report`,
      boundAddress: this.boundAddress,
      port: this.port,
      minutes,
      closesAt: pairing.closesAt,
    };
  }

  /** The state of one pairing, shaped for the panel. */
  status(token) {
    const pairing = this.pairings.get(token);
    if (pairing === undefined) return undefined;
    return {
      token: pairing.token,
      label: pairing.label,
      state: pairing.state,
      error: pairing.error,
      next: pairing.next,
      openedAt: pairing.openedAt,
      closesAt: pairing.closesAt,
      remainingMs: Math.max(0, pairing.closesAt - Date.now()),
      reports: pairing.reports,
      payload: pairing.payload,
      consumed: pairing.consumed,
      // Always the full list in the fixed order, so the panel can render it before any report has arrived and
      // cannot be misled into thinking a run is shorter than it is.
      stages: STAGES.map((stage) => {
        const seen = pairing.stages.get(stage);
        return seen === undefined
          ? { stage, state: 'waiting' }
          : { stage, state: seen.state, detail: seen.detail, error: seen.error, at: seen.at };
      }),
    };
  }

  /** Every open pairing, newest first. */
  list() {
    return [...this.pairings.values()]
      .sort((left, right) => right.openedAt - left.openedAt)
      .map((pairing) => this.status(pairing.token));
  }

  /** Forget one pairing. The listener stays up for the others. */
  forget(token) {
    return this.pairings.delete(token);
  }

  /**
   * Mark a pairing as finished with.
   *
   * Kept rather than deleted so a poll that arrives after the addition still reads the same answer. Deleting it
   * is what made a pairing that had just succeeded report itself as expired on the next tick.
   *
   * @param token - the pairing to consume.
   * @returns whether a pairing matched.
   */
  consume(token) {
    const pairing = this.pairings.get(token);
    if (pairing === undefined) return false;
    pairing.consumed = true;
    return true;
  }

  /** Stop listening and forget every pairing. */
  async close() {
    this.pairings.clear();
    this.#disarm();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.boundAddress = undefined;
    if (server === undefined) return;
    await new Promise((resolve) => { server.close(() => { resolve(); }); });
  }

  /** Bring the server up, binding the interface most likely to reach the machine that will report. */
  async #ensureServer(preferAddress) {
    const bindAddress = localAddresses({ preferAddress })[0] ?? '0.0.0.0';
    if (this.server !== undefined && this.boundAddress === bindAddress) return;
    await this.close();
    this.server = createServer((request, response) => { void this.#handle(request, response); });
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server = undefined; reject(error); };
      this.server.once('error', onError);
      // Port 0: the OS picks. A fixed port would be guessable and would collide with a second controller.
      this.server.listen(0, bindAddress, () => {
        this.server.off('error', onError);
        this.port = this.server.address().port;
        this.boundAddress = bindAddress;
        resolve();
      });
    });
  }

  /** Arm the sweep that drops pairings past their deadline. */
  #arm() {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      let removed = false;
      for (const [token, pairing] of this.pairings) {
        if (now <= pairing.closesAt) continue;
        /**
         * A pairing that was CONSUMED is simply dropped: it has done its job and the panel already has the result.
         * It is kept only until then so a later poll can still read that result instead of finding nothing.
         */
        if (pairing.consumed) {
          this.pairings.delete(token);
          removed = true;
          continue;
        }
        /**
         * A pairing that reported progress is NOT discarded for going quiet.
         *
         * Reported from a real run: five reports in, every stage it could do finished, and it never sent the final
         * message — its operator had to start over. Its work, and the values it reported along the way, are
         * exactly what a retry needs, and the token is the only thing that can still receive them.
         *
         * So only a pairing that never reported anything is swept. One that did is kept and marked `awaiting`,
         * which also stops it being described as "no report" when it plainly made several.
         */
        if (pairing.reports > 0 && pairing.payload === undefined) {
          pairing.state = 'awaiting';
          pairing.error = 'the machine stopped reporting before the final message ／ 被控机在发出最终汇报前停止了汇报';
          continue;
        }
        pairing.state = 'expired';
        pairing.error = 'no final report before the deadline ／ 在期限内没有收到最终汇报';
        this.pairings.delete(token);
        removed = true;
      }      // Nothing left to sweep and nothing left to serve: release the port rather than hold it open.
      if (this.pairings.size === 0 && removed) void this.close();
    }, 5000);
    this.timer.unref?.();
  }

  /** Cancel the sweep timer. */
  #disarm() {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Answer one request: a report, a status read, or a refusal.
   *
   * The token is checked before the body is read, so an unauthenticated caller cannot make this process
   * allocate by sending a large body.
   */
  async #handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status, value) => {
      const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' });
      response.end(body);
    };

    const given = request.headers['x-fleet-token'];
    const token = Array.isArray(given) ? given[0] : given;
    const pairing = typeof token === 'string'
      ? [...this.pairings.values()].find((candidate) => tokenMatches(candidate.token, token))
      : undefined;
    if (pairing === undefined) return json(404, { ok: false, error: 'unknown or closed pairing ／ 未知或已结束的配对' });

    if (request.method === 'GET') return json(200, { ok: true, status: this.status(pairing.token) });
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, POST' });
      response.end('{"ok":false}\n');
      return;
    }

    let raw = '';
    try {
      raw = await new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_REPORT_BYTES) { reject(new Error('report too large')); request.destroy(); return; }
          chunks.push(chunk);
        });
        request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
        request.on('error', reject);
      });
    } catch (error) {
      return json(413, { ok: false, error: String(error.message) });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, error: 'body must be JSON ／ 请求体必须是 JSON' });
    }

    const stage = String(body?.stage ?? '');
    const state = String(body?.state ?? '');
    if (!STAGES.includes(stage)) return json(400, { ok: false, error: `unknown stage ／ 未知阶段: ${stage}` });
    if (!STAGE_STATES.includes(state)) return json(400, { ok: false, error: `stage state must be one of ${STAGE_STATES.join(', ')} ／ 阶段结果只能是：${STAGE_STATES.join(', ')}` });

    pairing.reports += 1;
    /**
     * Every report pushes the deadline back.
     *
     * The window is meant to catch a machine that went silent, so it has to measure silence — not elapsed time.
     * A fixed deadline from the start would have killed a pairing that was working correctly but slowly, which is
     * exactly the machine this flow exists for: a bare one installing an SSH server first.
     */
    pairing.closesAt = Date.now() + pairing.minutes * 60_000;
    // The handshake, fired exactly once and on ANY report: a machine reporting anything at all means it read the
    // prompt. A `fail` counts too — that step failing says nothing about whether the prompt arrived, and keeping
    // the prompt link open after the machine has clearly started would be pointless.
    if (!pairing.handshakeDone) {
      pairing.handshakeDone = true;
      try {
        await pairing.onFirstReport?.(pairing.token);
      } catch {
        // A failing handshake hook must not fail the report: the machine has done its part, and the prompt's
        // window simply expires on its own if the hook could not shorten it.
      }
    }
    pairing.stages.set(stage, {
      state,
      detail: typeof body?.detail === 'string' ? body.detail.slice(0, MAX_DETAIL_CHARS) : undefined,
      error: typeof body?.error === 'string' ? body.error.slice(0, MAX_DETAIL_CHARS) : undefined,
      at: Date.now(),
    });

    if (stage === 'done') {
      /**
       * The final report carries the record to add, and it closes the pairing.
       *
       * `fail` is the only state that discards the record, because the machine is saying it could not produce one.
       * `pending` KEEPS it: a run that is waiting on a reboot has already configured everything else, and the
       * values it reports are the values the controller needs — on a real machine, everything except the SSH
       * server itself was done and correct when Windows left the capability in `InstallPending`.
       */
      if (state === 'fail') {
        pairing.state = 'failed';
        pairing.error = typeof body?.error === 'string' ? body.error : 'the machine reported a failure ／ 被控机报告失败';
      } else {
        pairing.payload = body?.payload !== undefined && typeof body.payload === 'object' && body.payload !== null ? body.payload : undefined;
        // `pending` is its own state so the panel can say "added, but it needs a reboot" rather than either
        // "done" (which would hide a real remaining step) or "failed" (which is not what happened).
        pairing.state = pairing.payload === undefined ? 'failed' : state === 'pending' ? 'incomplete' : 'done';
        pairing.next = state === 'pending' && typeof body?.next === 'string' ? body.next.slice(0, MAX_DETAIL_CHARS) : undefined;
        if (pairing.payload === undefined) pairing.error = 'the final report carried no payload ／ 最终汇报里没有携带配置内容';
      }
      pairing.closesAt = Date.now();
      return json(200, { ok: true, closed: true });
    }

    return json(200, { ok: true, stage, state });
  }
}

/**
 * Pick the address to advertise for the CALLBACK, and say whether it was chosen or forced.
 *
 * The machine cannot reach this controller on `127.0.0.1`, so an address is taken from a real interface. When
 * more than one IPv4 interface could serve, the first is advertised and the rest are reported alongside it, so
 * the operator can be told there was a choice rather than being silently given one.
 *
 * @param options - `{ preferAddress }`, the controlled machine's address.
 * @returns `{ address, alternatives }`.
 */
export function callbackAddress(options = {}) {
  const addresses = localAddresses({ preferAddress: options.preferAddress });
  return { address: addresses[0] ?? '0.0.0.0', alternatives: addresses.slice(1) };
}
