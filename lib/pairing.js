/**
 * Turning a finished pairing's payload into a machine record.
 *
 * The payload arrives from the controlled machine over the reporting channel and is the ONLY thing this plugin
 * accepts from the other side without a human in between, so it is treated as untrusted input rather than as a
 * record: every field is validated, unknown fields are dropped, and the result is only added when the record it
 * would create is unambiguous.
 *
 * ## Why the host can block the addition
 *
 * `host` is the one field the controlled machine cannot verify — reachability is a fact about the controller's
 * network. So the machine is asked to report its candidates rather than one answer, and the decision is made
 * here:
 *
 *   - exactly one candidate: add it;
 *   - more than one: do NOT guess. The panel asks, because the wrong choice produces a machine that looks
 *     ready and only ever reports "cannot connect";
 *   - none: nothing to add.
 *
 * @module dsh-duck-fleet/pairing
 */

/** Machine fields this plugin will take from a pairing payload. Anything else is ignored. */
const ACCEPTED = ['label', 'host', 'user', 'port', 'remoteCommand', 'cwd', 'description', 'toolName'];

/**
 * Candidate addresses a payload may carry alongside the chosen host.
 *
 * Both spellings are read because the prompt asks for the candidates in prose and a model may put them in
 * either place. They are advisory: they only affect whether the addition is automatic or asked about.
 */
function candidatesOf(payload) {
  const raw = payload?.hostCandidates ?? payload?.candidates ?? payload?.addresses;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim()))];
}

/** A port is a port, not a string that looks like one. */
function normalizePort(value) {
  if (Number.isInteger(value) && value > 0 && value <= 65535) return value;
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

/**
 * Validate a payload and decide whether it can be added without asking.
 *
 * @param payload - the object the controlled machine sent as `payload` on its final report.
 * @returns `{ ok: true, machine, candidates, needsChoice }` or `{ ok: false, errors }`.
 */
export function interpretPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['the final report carried no configuration object ／ 最终汇报里没有配置对象'] };
  }

  const errors = [];
  const machine = {};
  for (const field of ACCEPTED) {
    const value = payload[field];
    if (value === undefined || value === null || value === '') continue;
    // `port` is the one numeric field, so it is normalized below rather than required to be a string here.
    // Treating it as a string rejected every correct payload: the prompt asks for a number.
    if (field === 'port') continue;
    if (typeof value !== 'string') {
      errors.push(`${field} must be a string ／ ${field} 必须是字符串`);
      continue;
    }
    machine[field] = value.trim();
  }

  const port = normalizePort(payload.port);
  if (port !== undefined) machine.port = port;

  // The two fields without which a machine record cannot address anything.
  if (machine.host === undefined) errors.push('host is required ／ 缺少 host');
  if (machine.user === undefined) errors.push('user is required ／ 缺少 user');

  // A machine name is required by the store, and a hostname is what the prompt asks for. Falling back to the
  // host keeps an otherwise-complete payload usable instead of failing on a cosmetic field.
  if (machine.label === undefined) machine.label = machine.host;

  // The workspace must be an absolute path, because the remote session is created there. A relative value
  // would silently resolve against whatever directory the agent happened to start in.
  if (machine.cwd !== undefined && !/^([A-Za-z]:[\\/]|\\\\|\/)/.test(machine.cwd)) {
    errors.push(`cwd must be an absolute path ／ cwd 必须是绝对路径: ${machine.cwd}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const candidates = candidatesOf(payload);
  // A single candidate is unambiguous. Several means the machine could not tell, so neither will this plugin:
  // the operator decides. `host` itself counts as a candidate, so a payload that names one address and also
  // lists it is still a single choice.
  const distinct = [...new Set([machine.host, ...candidates])];
  return {
    ok: true,
    machine,
    candidates: distinct,
    needsChoice: distinct.length > 1,
  };
}
