/**
 * Hand the setup prompt to the controlled machine over HTTP instead of by copy-paste.
 *
 * The prompt is long and carries a public key, so carrying it across by hand is the slowest and
 * most error-prone part of onboarding. Serving it means the other machine only needs a short address.
 *
 * Why this starts its OWN server rather than adding a route to the harness's one: measured on a real
 * controller, the harness web server binds `127.0.0.1` only, so the other machine cannot reach it at all.
 * The listener therefore binds a real interface, which puts it on the local network. Three properties keep
 * that from being an open door, and only the first one lengthens the address:
 *
 *   - **A short path segment.** `http://<ip>:<port>/<four letters>` — short enough to type on the other
 *     machine, which is the whole point. Four letters is NOT much entropy (~4.6e5), so it is a speed bump
 *     rather than a secret; the two properties below are what actually bound the exposure.
 *   - **A closing time.** The listener opens for a bounded number of minutes and then closes itself,
 *     whether or not anything fetched the prompt. Nothing stays listening after the window.
 *   - **A named reader.** When the controlled machine's address is known, only that address is served;
 *     any other host on the network gets 403, so the letters cannot be guessed by a third party at all.
 *
 * @module dsh-fleet/share
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

/** How long the listener stays open when the caller does not say. */
export const DEFAULT_SHARE_MINUTES = 5;

/** Bounds that keep a mistyped duration from leaving a port open indefinitely, or closing it instantly. */
export const MIN_SHARE_MINUTES = 1;
export const MAX_SHARE_MINUTES = 120;

/** The path segment's alphabet and length. Lowercase only: it gets typed by hand. */
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const TOKEN_LENGTH = 4;

/** Interfaces whose addresses are not usefully reachable from another machine. */
const TUNNEL_NAME = /^(tun|tap|utun|wg|ppp|ipsec|lo|docker|veth|br-|virbr|vmnet|vboxnet)/i;
const VIRTUAL_ADDRESS = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * A short, typeable path segment.
 *
 * `randomInt` rather than a modulo of `randomBytes`: reducing a byte range onto 26 values would bias the
 * early letters, and the whole point of this value is to be hard to land on by accident.
 *
 * @returns four lowercase letters.
 */
export function shortToken() {
  let token = '';
  for (let index = 0; index < TOKEN_LENGTH; index += 1) {
    token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  }
  return token;
}

/**
 * The controller's reachable IPv4 addresses, best candidate first.
 *
 * Ordering matters and is not cosmetic: a real controller reported `10.8.0.2` on a VPN tunnel before
 * `192.168.1.20` on WLAN, and only the second was on the controlled machine's network. Tunnel and virtual
 * interfaces are ranked below physical ones, and an address sharing a prefix with the target machine is
 * ranked above everything.
 *
 * @param options - `{ preferAddress }`, an address of the machine that will fetch the prompt.
 * @returns address strings, best first.
 */
export function localAddresses(options = {}) {
  const prefer = typeof options.preferAddress === 'string' ? options.preferAddress : '';
  // Compare /24 prefixes: the other machine is normally on the same LAN, not merely the same /8.
  const prefixOf = (address) => address.split('.').slice(0, 3).join('.');
  const wanted = prefer === '' ? '' : prefixOf(prefer);

  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      found.push({
        address: entry.address,
        name,
        score: (wanted !== '' && prefixOf(entry.address) === wanted ? 100 : 0)
          + (entry.address.startsWith('192.168.') ? 10 : 0)
          + (TUNNEL_NAME.test(name) ? 0 : 5)
          - (VIRTUAL_ADDRESS.test(entry.address) ? 0 : 3),
      });
    }
  }
  return found.sort((left, right) => right.score - left.score).map((entry) => entry.address);
}

/** Clamp a caller-supplied duration into the allowed window. */
function clampMinutes(value) {
  const minutes = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(minutes)) return DEFAULT_SHARE_MINUTES;
  return Math.min(MAX_SHARE_MINUTES, Math.max(MIN_SHARE_MINUTES, minutes));
}

/** Compare two short strings without leaking where they first differ. */
function tokenMatches(expected, given) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whether a socket address names the expected host.
 *
 * IPv4-mapped IPv6 (`::ffff:192.168.1.10`) is what a dual-stack listener reports for an IPv4 client, so
 * the prefix is stripped before comparing.
 *
 * @param remote - `request.socket.remoteAddress`.
 * @param expected - the address the offer was published for.
 * @returns true when they name the same host.
 */
function sameHost(remote, expected) {
  const normalize = (value) => String(value ?? '').replace(/^::ffff:/i, '');
  return normalize(remote) === normalize(expected);
}

/**
 * A time-bounded HTTP offer of one prompt.
 *
 * One offer at a time: two live addresses would be ambiguous in the panel, and the point of the address is
 * that a person can type it.
 */
export class PromptShare {
  constructor() {
    this.server = undefined;
    this.offer = undefined;
    this.port = undefined;
    this.boundAddress = undefined;
    this.closeTimer = undefined;
  }

  /** Whether a prompt is currently being served. */
  get active() {
    return this.offer !== undefined;
  }

  /**
   * Start (or restart) the listener and publish one prompt on it.
   *
   * The listener binds the controller's address that shares a network with the machine that will fetch,
   * not every interface. That is both narrower and simpler: only one address can be advertised, so the
   * address cannot name an interface the other machine cannot reach.
   *
   * `closeAfterFetch` shortens the window to the moment the prompt is handed over. That suits a PAIRING, where
   * the prompt is fetched once and the machine then reports on a separate channel: the address has done its job
   * and nothing should still be listening on it. The prompt is not worth protecting once read, but an unchanged
   * listener is still a port to explain.
   *
   * @param options - `{ prompt, minutes, preferAddress, port, token, closeAfterFetch }`.
   * @returns the address, path segment, and closing time, or throws when no port can be bound.
   */
  async publish(options) {
    const prompt = String(options.prompt ?? '');
    const minutes = clampMinutes(options.minutes);

    const addresses = localAddresses({ preferAddress: options.preferAddress });
    const bindAddress = addresses[0] ?? '0.0.0.0';
    if (this.server === undefined || this.boundAddress !== bindAddress) {
      await this.close();
      this.server = createServer((request, response) => this.#handle(request, response));
      await new Promise((resolve, reject) => {
        const onError = (error) => { this.server = undefined; reject(error); };
        this.server.once('error', onError);
        this.server.listen(options.port ?? 0, bindAddress, () => {
          this.server.off('error', onError);
          this.port = this.server.address().port;
          this.boundAddress = bindAddress;
          resolve();
        });
      });
    }

    const sameReader = typeof options.preferAddress === 'string' && options.preferAddress !== '';
    this.offer = {
      prompt,
      token: typeof options.token === 'string' && options.token !== '' ? options.token : shortToken(),
      // Only the machine that was named may fetch: it is the sole intended reader, so there is no reason to
      // serve anyone else. With no hint, the short path segment is the only guard, which is what the caller
      // asked for by not naming one.
      reader: sameReader ? options.preferAddress : undefined,
      closesAt: Date.now() + minutes * 60_000,
      closeAfterFetch: options.closeAfterFetch === true,
    };
    this.#armClose(minutes * 60_000);

    const url = `http://${bindAddress}:${String(this.port)}/${this.offer.token}`;
    return {
      url,
      urls: [url],
      token: this.offer.token,
      boundAddress: bindAddress,
      minutes,
      closesAt: this.offer.closesAt,
      reader: this.offer.reader,
      closeAfterFetch: this.offer.closeAfterFetch,
    };
  }

  /** Withdraw the offer and close the listener. */
  async withdraw() {
    const had = this.offer !== undefined || this.server !== undefined;
    await this.close();
    return had;
  }

  /** Stop listening and cancel the countdown. */
  async close() {
    this.offer = undefined;
    this.#disarmClose();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.boundAddress = undefined;
    if (server === undefined) return;
    await new Promise((resolve) => { server.close(() => { resolve(); }); });
  }

  /** Arm the self-closing timer for one window. */
  #armClose(ms) {
    this.#disarmClose();
    this.closeTimer = setTimeout(() => {
      void this.close();
    }, ms);
    this.closeTimer.unref?.();
  }

  /** Cancel a pending self-closing timer. */
  #disarmClose() {
    if (this.closeTimer === undefined) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  /**
   * Answer one request.
   *
   * The path is the four-letter segment, compared before anything else. A wrong or expired segment is
   * answered identically to an unknown path, so probing cannot tell a live offer from a closed one.
   */
  #handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const plain = (status, text) => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(text);
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      response.end('method not allowed ／ 不允许这个请求方法\n');
      return;
    }

    const offer = this.offer;
    const given = url.pathname.replace(/^\/+|\/+$/g, '');
    if (offer === undefined || given === '' || !tokenMatches(offer.token, given)) {
      return plain(404, 'not found ／ 没有找到\n');
    }
    if (Date.now() > offer.closesAt) return plain(410, 'this prompt has expired ／ 这个提示词已经过期\n');
    if (offer.reader !== undefined && !sameHost(request.socket?.remoteAddress, offer.reader)) {
      return plain(403, `this prompt is for ${offer.reader} only ／ 这个提示词只发给 ${offer.reader}\n`);
    }

    const body = Buffer.from(offer.prompt, 'utf8');
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }
}
