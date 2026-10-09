/**
 * Fleet configuration: one JSON document holding every controlled machine, so adding a machine is
 * one record instead of a pair of hand-written loader rows.
 *
 * The document is read once when the plugin starts and rewritten whenever the panel or a
 * `fleet_*` tool changes it; the directory is the harness home, not the profile, because this is
 * user data rather than composition.
 *
 * @module dsh-fleet/store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Fields that belong to the CONTROLLER, not to any machine it connects to.
 *
 * Which ssh binary to run, which key it authenticates with, and which profile serves ACP are answers this
 * controller gives once, and none of them depends on the machine on the other end. They are read from `defaults`
 * wherever they are needed, and they are NOT copied into a machine record: a copy would silently win over the
 * shared value, so changing the shared setting would appear to do nothing. A record that still carries one from
 * an older document is simply not read.
 *
 * `remoteCommand` is deliberately NOT here. It looks controller-ish but it is not: its useful value is the
 * ABSOLUTE path to the product's CLI on that machine, because a non-interactive ssh session inherits a much
 * smaller PATH than an interactive one and `dsh` is typically not on it. That path contains the CONTROLLED
 * machine's user name, so one controller cannot hold one value for all of them — sharing it made a second
 * machine point at the first machine's installation.
 */
const SETTINGS_FIELDS = ['sshCommand', 'keyFile', 'profile'];

/**
 * Input fields of one machine, exactly as the panel and the tools accept them.
 *
 * A field is here only when it can genuinely differ between machines: an address, an account, a port, a name,
 * the command that starts the agent on THAT machine, a working directory (a path on THAT machine), and whether
 * that machine's permission prompts are answered automatically. Everything in {@link SETTINGS_FIELDS} is shared.
 */
const MACHINE_FIELDS = [
  'id', 'label', 'host', 'user', 'port', 'toolName', 'description',
  'remoteCommand', 'cwd', 'permission', 'extraArgs',
];

/**
 * Defaults materialized into every stored machine.
 *
 * `cwd` defaults to EMPTY, which means "use the delegating session's workspace". A fixed default would
 * have to exist on both machines — it is the working directory of the local ssh process AND the
 * workspace the remote session is created in — so it cannot be guessed for a machine this controller
 * has never spoken to. Set it explicitly to pin the remote workspace to a specific absolute path.
 *
 * `keyFile` is absent for the same reason it left {@link MACHINE_FIELDS}: it is shared, not per machine. The
 * empty value keeps its meaning of "choose a key from the SSH directory".
 */
export const MACHINE_DEFAULTS = Object.freeze({
  sshCommand: 'ssh',
  keyFile: '',
  remoteCommand: 'dsh',
  profile: 'acp',
  cwd: '',
  permission: 'allow',
  port: 22,
  extraArgs: [],
});

/** Tool names must stay callable by a model and addressable by the harness. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Turn a human name into a safe slug for the INTERNAL id.
 *
 * Unicode letters and digits survive: the id is only ever a key in memory and a value inside a JSON body —
 * never a path segment — so `主力笔记本` is a perfectly good identifier and a far more debuggable one than a
 * transliteration. The id is not what the model calls, so nothing here has to be typeable.
 *
 * @param value - the human-facing name.
 * @param what - what is being named, for the error message.
 * @returns a lowercase slug.
 */
export function slug(value, what = 'name') {
  const text = String(value ?? '').trim().toLowerCase();
  // `\p{L}\p{N}` covers CJK, Cyrillic, and accented Latin alike.
  const folded = text.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  if (folded === '') throw new Error(`fleet: the machine ${what} must contain at least one letter or digit ／ 机器的 ${what} 至少要包含一个字母或数字`);
  return folded;
}

/**
 * The ASCII part of a tool name.
 *
 * Tool names are held to `[A-Za-z0-9_-]` by the harness, so a name that folds away entirely — a Chinese one,
 * for instance — cannot contribute letters. That is reported rather than papered over: a fallback like `pc`
 * or `pc_2` would be exactly the unreadable tool name this derivation exists to avoid.
 *
 * @param label - the machine's display name.
 * @returns a suffix of letters, digits, underscores, and dashes, possibly empty.
 */
function toolSuffix(label) {
  return String(label ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Derive the tool name a machine is called by, or nothing when the name cannot yield one.
 *
 * From the machine's NAME, never from its internal id. The id is a key — short and arbitrary, like `b` — so
 * deriving from it produced tool names like `pc_b`, which the model cannot tell apart and the operator cannot
 * remember.
 *
 * A name with no ASCII letters in it yields `undefined` rather than a filler such as `pc` or `pc_2`: a
 * meaningless tool name is the very thing this derivation exists to avoid, and the operator can simply type
 * one. The tool name is always theirs to change.
 *
 * @param label - the machine's display name.
 * @returns a tool name matching the harness's callable-name pattern, or `undefined`.
 */
export function toolNameFromLabel(label) {
  const suffix = toolSuffix(label);
  return suffix === '' ? undefined : `pc_${suffix}`;
}

/** Reject values that would silently misbehave later. */
function requireText(value, field, id) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`fleet: machine "${id}" needs a non-empty \`${field}\` ／ 机器 "${id}" 的 \`${field}\` 不能为空`);
  }
  return value.trim();
}

/** Normalize one stored or submitted machine into the canonical shape. */
export function normalizeMachine(input, previous) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('fleet: every machine must be an object ／ 每一台机器都必须是一个对象');
  }
  const base = previous ?? MACHINE_DEFAULTS;
  const merged = { ...base, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };

  // `id` is an internal key, not something a person chooses: it is what the store, the registration map, and
  // the tool calls address a machine by. When only a name is given, the key is derived from it, so an
  // operator never has to invent a second identifier for the same machine.
  const named = typeof merged.label === 'string' && merged.label.trim() !== '' ? merged.label : undefined;
  const id = merged.id === undefined || String(merged.id).trim() === ''
    ? slug(named ?? '', 'name')
    : requireText(merged.id, 'id', merged.id);
  const host = requireText(merged.host, 'host', id);
  const user = requireText(merged.user, 'user', id);

  const port = merged.port === undefined || merged.port === null || merged.port === ''
    ? MACHINE_DEFAULTS.port
    : Number(merged.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`fleet: machine "${id}" has an invalid ssh port: ${String(merged.port)} ／ 机器 "${id}" 的 ssh 端口无效：${String(merged.port)}`);
  }

  const permission = merged.permission ?? MACHINE_DEFAULTS.permission;
  if (permission !== 'allow' && permission !== 'reject') {
    throw new Error(`fleet: machine "${id}" permission must be "allow" or "reject" ／ 机器 "${id}" 的 permission 必须是 "allow" 或 "reject"`);
  }

  const extraArgs = merged.extraArgs ?? [];
  if (!Array.isArray(extraArgs) || extraArgs.some((value) => typeof value !== 'string')) {
    throw new Error(`fleet: machine "${id}" extraArgs must be an array of strings ／ 机器 "${id}" 的 extraArgs 必须是字符串数组`);
  }

  // The label is resolved before the tool name because the tool name derives from it, not from the id.
  const label = merged.label === undefined || String(merged.label).trim() === '' ? id : String(merged.label).trim();

  // Always the operator's to set. When they have not, it is derived from the name so that the ordinary case
  // needs no thought; when the name yields nothing (a Chinese name, say), the field stays empty and they fill
  // it in, rather than being handed a tool name nobody can read.
  const toolName = merged.toolName === undefined || String(merged.toolName).trim() === ''
    ? toolNameFromLabel(label)
    : String(merged.toolName).trim();
  if (toolName === undefined) {
    throw new Error(
      `fleet: machine "${id}" needs a \`toolName\` — the name "${label}" contains no letters the model can call, `
      + 'so give the machine an English name or set `toolName` to letters, digits, underscores, or dashes'
      + ' ／ 机器 "${id}" 需要一个 `toolName` —— 名称 "${label}" 里没有模型能调用的字母，'
      + '所以请给这台机器起一个英文名，或者把 `toolName` 设成字母、数字、下划线或短横线',
    );
  }
  if (!TOOL_NAME_PATTERN.test(toolName)) {
    throw new Error(`fleet: machine "${id}" toolName must match ${String(TOOL_NAME_PATTERN)}: ${toolName} ／ 机器 "${id}" 的 toolName 必须匹配 ${String(TOOL_NAME_PATTERN)}：${toolName}`);
  }

  // Empty is meaningful here, not "fill in the default": it selects the delegating session's workspace
  // as the working directory for both the local ssh process and the remote session.
  const cwd = merged.cwd === undefined ? MACHINE_DEFAULTS.cwd : String(merged.cwd).trim();

  // How to start the agent ON THIS MACHINE. `dsh` when it is on that machine's non-interactive PATH, otherwise
  // the absolute path to the product's CLI — which is the usual case, since ssh gives a non-interactive session
  // a much smaller PATH than an interactive one.
  const remoteCommand = merged.remoteCommand === undefined || String(merged.remoteCommand).trim() === ''
    ? MACHINE_DEFAULTS.remoteCommand
    : String(merged.remoteCommand).trim();

  return {
    id,
    label,
    description: merged.description === undefined ? '' : String(merged.description).trim(),
    host,
    user,
    port,
    toolName,
    // Not `sshCommand`, `keyFile`, or `profile`: those are the controller's, they live in `defaults`, and they are
    // read from there. Copies left in an existing document are not read, so an upgrade needs no migration step
    // and cannot leave two records disagreeing about which ssh to run.
    remoteCommand,
    cwd,
    permission,
    extraArgs: extraArgs.map((value) => String(value)),
  };
}

/**
 * The first free variant of a name, by appending a counter.
 *
 * @param base - the name already in use.
 * @param taken - names already claimed.
 * @returns `base_2`, `base_3`, … whichever is free first.
 */
function uniqueAmong(base, taken) {
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}_${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`fleet: cannot find a free variant of "${base}" ／ 找不到 "${base}" 的可用变体名`);
}

/**
 * Bounds on the archive rules.
 *
 * The floor is zero because "archive everything" is a legitimate wish; the ceilings keep a mistyped value
 * from being handed to a PowerShell parameter as something absurd.
 */
export const AUTO_ARCHIVE_LIMITS = Object.freeze({ keepLast: { min: 0, max: 500 }, maxAgeHours: { min: 0, max: 8760 } });

/**
 * Normalize the session-archive rules.
 *
 * This block configures a LAB feature: it clears the ungrouped delegation sessions the ACP path leaves
 * behind on a controlled machine. Only the Windows implementation exists and has been measured, so the rules
 * can be stored for any machine while the operation itself refuses anything else.
 *
 * A missing block means "not configured", not "enabled": pruning stops a running app on that machine, so it
 * has to be asked for rather than inherited by surprise.
 *
 * @param input - the raw `autoArchive` value.
 * @returns `{ enabled, keepLast, maxAgeHours }`.
 */
export function normalizeAutoArchive(input) {
  const source = typeof input === 'object' && input !== null ? input : {};
  const clamp = (value, { min, max }, fallback) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, number));
  };
  return {
    enabled: source.enabled === true,
    keepLast: clamp(source.keepLast, AUTO_ARCHIVE_LIMITS.keepLast, 5),
    // Zero means "no age rule"; a positive value archives anything older than that many hours.
    maxAgeHours: clamp(source.maxAgeHours, AUTO_ARCHIVE_LIMITS.maxAgeHours, 0),
  };
}

/** Normalize a whole document, disambiguating duplicate ids and duplicate tool names. */
export function normalizeConfig(input) {
  const source = typeof input === 'object' && input !== null ? input : {};
  const rawMachines = source.machines ?? [];
  if (!Array.isArray(rawMachines)) throw new Error('fleet: `machines` must be an array ／ `machines` 必须是一个数组');

  const machines = [];
  const ids = new Set();
  const toolNames = new Set();
  for (const raw of rawMachines) {
    const machine = normalizeMachine(raw);
    // Two machines named the same thing are a normal accident, not a configuration error: the name is typed by
    // a person. The second one is disambiguated instead of being refused, because the alternative is a save
    // that fails with a message about an identifier the operator never chose in the first place.
    if (ids.has(machine.id)) machine.id = uniqueAmong(machine.id, ids);
    if (toolNames.has(machine.toolName)) machine.toolName = uniqueAmong(machine.toolName, toolNames);
    ids.add(machine.id);
    toolNames.add(machine.toolName);
    machines.push(machine);
  }

  const defaults = source.defaults ?? {};
  return {
    version: 1,
    defaults: {
      sshCommand: defaults.sshCommand ?? MACHINE_DEFAULTS.sshCommand,
      // The controller's identity: one key for every machine it controls, stored once here rather than
      // repeated per machine. Empty means "pick the first usable key in the SSH directory".
      keyFile: defaults.keyFile ?? MACHINE_DEFAULTS.keyFile,
      cwd: defaults.cwd ?? MACHINE_DEFAULTS.cwd,
      permission: defaults.permission ?? MACHINE_DEFAULTS.permission,
      remoteCommand: defaults.remoteCommand ?? MACHINE_DEFAULTS.remoteCommand,
      profile: defaults.profile ?? MACHINE_DEFAULTS.profile,
      // Nested rather than flattened: the rules belong together, and a partial block left by an older
      // document is filled in rather than discarded.
      autoArchive: normalizeAutoArchive(defaults.autoArchive),
    },
    machines,
  };
}

/** An empty document, used when the file does not exist yet. */
export function emptyConfig() {
  return normalizeConfig({ machines: [] });
}

/** Resolve the fleet document path inside the harness home. */
export function resolveStorePath(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit;
  const override = process.env.DSH_FLEET_STORE;
  if (typeof override === 'string' && override.trim() !== '') return override;
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'fleet.json');
}

/**
 * Load the fleet document, materializing an empty one when the file is absent.
 *
 * A malformed document is reported rather than thrown and is never rewritten here: silently
 * replacing a hand-edited file with an empty fleet would delete the user's machines.
 *
 * @param path - document path.
 * @returns the normalized config, whether the file existed, and the parse failure if there was one.
 */
export function loadConfig(path) {
  if (!existsSync(path)) return { config: emptyConfig(), existed: false, problem: undefined };
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return { config: emptyConfig(), existed: true, problem: undefined };
  try {
    return { config: normalizeConfig(JSON.parse(text)), existed: true, problem: undefined };
  } catch (error) {
    return {
      config: emptyConfig(),
      existed: true,
      problem: `fleet: ${path} could not be read as a fleet document, so no machine is registered: ${error instanceof Error ? error.message : String(error)} ／ ${path} 读不出 fleet 配置文档，因此没有注册任何机器：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Write the document atomically so a crash never leaves a half-written fleet. */
export function saveConfig(path, config) {
  const normalized = normalizeConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return normalized;
}

/** Describe one machine the way the panel and the tools present it. */
export function machineSummary(machine) {
  return { ...machine, target: `${machine.user}@${machine.host}` };
}

export { MACHINE_FIELDS };
