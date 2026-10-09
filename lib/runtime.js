/**
 * Fleet runtime: owns the machine document, keeps one ACP provider and one delegation tool
 * registered per machine, and re-registers them live whenever the document changes.
 *
 * The provider names are stable (`fleet-<id>`), so a settings change re-registers a machine's
 * provider, and any tool call in flight against the old provider fails loudly instead of silently
 * reaching a stale configuration.
 *
 * @module dsh-fleet/runtime
 */
import { machineTarget, providerNameFor, registerProvider, testMachine } from './fleet.js';
import { MACHINE_DEFAULTS, loadConfig, normalizeConfig, normalizeMachine, resolveStorePath, saveConfig } from './store.js';

export class FleetRuntime {
  /**
   * @param ctx - the Host context that owns every registration.
   * @param deps - the context slice the machine providers use.
   * @param options - store path override and the plugin's logger.
   */
  constructor(ctx, deps, options = {}) {
    this.ctx = ctx;
    this.deps = deps;
    this.logger = options.logger;
    this.path = resolveStorePath(options.storePath);
    /** @type {Map<string, Array<() => void>>} registrations per machine id, innermost last */
    this.registrations = new Map();
    const loaded = loadConfig(this.path);
    this.current = loaded.config;
    this.warnings = loaded.problem === undefined ? [] : [loaded.problem];
  }

  /** Path of the fleet document, for display. */
  storePath() {
    return this.path;
  }

  /** The subprocess service, used for the short-lived setup commands (ssh-keygen). */
  subprocessService() {
    return this.deps.subprocess;
  }

  /** What this process is running: the revision, the loaded generation, and the tool list. */
  version() {
    return typeof this.deps.version === 'function' ? this.deps.version() : { revision: 'unknown' };
  }

  /** The current document, as a detached copy. */
  async config() {
    return normalizeConfig(this.current);
  }

  /**
   * The controller's shared settings, read synchronously.
   *
   * Synchronous on purpose: these are needed while building an ssh argv and a tool description, both of which
   * are plain calls, not awaited ones. `config()` is async, so `config().defaults` is a promise's property and
   * always undefined — reading a setting that way silently dropped `-i` from every ssh command.
   *
   * `remoteCommand` is NOT here: it belongs to the machine, whose agent it starts.
   *
   * @returns `{ sshCommand, keyFile, profile }`.
   */
  settings() {
    const defaults = this.current?.defaults ?? {};
    return {
      sshCommand: defaults.sshCommand ?? MACHINE_DEFAULTS.sshCommand,
      keyFile: defaults.keyFile ?? MACHINE_DEFAULTS.keyFile,
      profile: defaults.profile ?? MACHINE_DEFAULTS.profile,
    };
  }

  /**
   * What the panel shows: the document plus each machine's live registration state.
   *
   * Every stored field is included, not just a summary: the panel's edit form is seeded from this
   * snapshot, so a field omitted here becomes an empty input — which is exactly how a machine looked
   * like it had lost its host and user.
   *
   * @returns a JSON-safe snapshot.
   */
  status() {
    return {
      storePath: this.path,
      defaults: this.current.defaults,
      warnings: [...this.warnings],
      machines: this.current.machines.map((machine) => ({
        ...machine,
        target: machineTarget(machine),
        provider: providerNameFor(machine),
        registered: this.registrations.has(machine.id),
        toolVisible: this.#toolVisible(machine.toolName),
      })),
    };
  }

  /** One machine's live state as a short phrase, for the list view. */
  stateOf(id) {
    const machine = this.current.machines.find((entry) => entry.id === id);
    if (machine === undefined) return 'unknown';
    if (!this.registrations.has(id)) return 'NOT registered';
    return this.#toolVisible(machine.toolName) ? 'ready' : 'provider ready, tool name taken by another layer';
  }

  /**
   * Whether the global tool layer already exposes a name, so a tool-name clash can be reported
   * rather than thrown. A tools registry without the lookup degrades to "not taken".
   */
  #toolVisible(name) {
    const tools = this.ctx.tools;
    if (tools === undefined || typeof tools.get !== 'function') return false;
    try {
      return tools.get(name) !== undefined;
    } catch {
      return false;
    }
  }

  /** The normalized record for one machine, or a diagnostic naming what is missing. */
  machine(id) {
    const key = String(id ?? '').trim();
    if (key === '') throw new Error('fleet: a machine id is required ／ 需要提供机器 id');
    const machine = this.current.machines.find((entry) => entry.id === key || entry.toolName === key);
    if (machine === undefined) {
      const known = this.current.machines.map((entry) => entry.id).join(', ') || '(none)';
      throw new Error(`fleet: no machine "${key}"; configured machines: ${known} ／ 没有名为 "${key}" 的机器；已配置的机器：${known}`);
    }
    return machine;
  }

  /**
   * Register one machine's provider and delegation tool.
   *
   * The two registrations are deliberately independent. A registered provider is the machine being
   * usable; a delegation tool that cannot register because another composition layer already owns
   * that name is a naming conflict to report, not a reason to make the machine unusable — and
   * rolling the provider back in that case would hide a working machine behind an unrelated clash.
   */
  #register(machine) {
    this.#unregister(machine.id);
    const providerDispose = registerProvider(this.ctx, this.deps, machine);
    let toolDispose;
    if (!this.#toolVisible(machine.toolName)) {
      try {
        toolDispose = this.ctx.tools.register(this.deps.toolDefinition(machine));
      } catch (error) {
        this.warnings.push(
          `fleet: machine "${machine.id}" is registered, but its tool "${machine.toolName}" could not be added: ${String(error)} ／ 机器 "${machine.id}" 已注册，但它的工具 "${machine.toolName}" 没能加上：${String(error)}`,
        );
      }
    } else {
      this.warnings.push(
        `fleet: machine "${machine.id}" is registered as provider "${providerNameFor(machine)}", but the tool name "${machine.toolName}" is already taken by another composition layer; `
        + 'delegation still works through that existing tool. Give this machine a different `id` or `toolName` to get its own tool.'
        + ` ／ 机器 "${machine.id}" 已注册为 provider "${providerNameFor(machine)}"，但工具名 "${machine.toolName}" 已被另一个组合层占用；`
        + '派活仍然可以通过那个已有的工具进行。给这台机器换一个 `id` 或 `toolName`，它才会拥有自己的工具。',
      );
    }
    this.registrations.set(machine.id, [providerDispose, ...toolDispose === undefined ? [] : [toolDispose]]);
  }

  /** Drop one machine's registrations. */
  #unregister(id) {
    const disposers = this.registrations.get(id);
    if (disposers === undefined) return;
    this.registrations.delete(id);
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        this.warnings.push(`fleet: cleanup of machine "${id}" failed: ${String(error)} ／ 清理机器 "${id}" 失败：${String(error)}`);
      }
    }
  }

  /**
   * Apply a whole document: persist it, then converge the live registrations onto it.
   *
   * @param input - the candidate document.
   * @returns the stored document.
   */
  async apply(input) {
    const next = saveConfig(this.path, input);
    this.current = next;
    const carried = this.warnings.filter((warning) => warning.startsWith('fleet: ') && warning.includes('could not be read as a fleet document'));
    this.warnings = carried;
    for (const id of [...this.registrations.keys()]) {
      if (!next.machines.some((machine) => machine.id === id)) this.#unregister(id);
    }
    for (const machine of next.machines) {
      try {
        this.#register(machine);
      } catch (error) {
        this.warnings.push(`fleet: machine "${machine.id}" is configured but not registered: ${String(error)} ／ 机器 "${machine.id}" 已配置但未注册：${String(error)}`);
        this.logger?.warn(`fleet: machine "%s" is configured but not registered: %o ／ 机器 "%s" 已配置但未注册：%o`, machine.id, error);
      }
    }
    return next;
  }

  /** Materialize the initial registrations for the document loaded at startup. */
  async start() {
    return this.apply(this.current);
  }

  /** Drop every registration this runtime owns. */
  dispose() {
    for (const id of [...this.registrations.keys()]) this.#unregister(id);
  }

  /**
   * Add or update one machine by patch, then apply.
   *
   * A patch may name the machine by `id` or by `label`. The label is what a person types, and the id is
   * derived from it, so requiring an id here would defeat that derivation. Matching on the label first also
   * means editing a machine does not silently create a second one under a derived id.
   *
   * @param patch - the machine fields to apply.
   * @returns `{ machine, created }`.
   */
  async upsertMachine(patch) {
    if (typeof patch !== 'object' || patch === null) throw new Error('fleet: a machine object is required ／ 需要提供一个机器对象');
    const givenId = typeof patch.id === 'string' ? patch.id.trim() : '';
    const givenLabel = typeof patch.label === 'string' ? patch.label.trim() : '';
    if (givenId === '' && givenLabel === '') throw new Error('fleet: a machine needs an `id` or a `label` ／ 一台机器至少要有 `id` 或 `label`');

    const index = this.current.machines.findIndex((entry) => (givenId !== '' && entry.id === givenId)
      || (givenId === '' && givenLabel !== '' && entry.label === givenLabel));
    const previous = index === -1 ? undefined : this.current.machines[index];
    // A NEW machine is completed from the document's shared defaults, not from the hardcoded ones: that is what
    // makes a shared setting actually shared. Relying on the panel to prefill them meant `fleet_add` and every
    // other path produced a machine that silently ignored them. An UPDATE keeps its own values instead, so
    // editing one machine can never quietly adopt a different default.
    const base = previous ?? { ...MACHINE_DEFAULTS, ...this.current.defaults };
    const machine = normalizeMachine(givenId === '' ? patch : { ...patch, id: givenId }, base);
    const machines = [...this.current.machines];
    if (index === -1) machines.push(machine);
    else machines[index] = machine;
    await this.apply({ ...this.current, machines });
    return { machine, created: index === -1 };
  }

  /** Remove one machine, then apply. */
  async removeMachine(id) {
    const machine = this.machine(id);
    await this.apply({ ...this.current, machines: this.current.machines.filter((entry) => entry.id !== machine.id) });
    return machine;
  }

  /** Merge changes into the shared defaults. */
  async setDefaults(patch) {
    const defaults = { ...MACHINE_DEFAULTS, ...this.current.defaults, ...patch };
    await this.apply({ ...this.current, defaults });
    return this.current.defaults;
  }

  /** Prove one machine, or every machine when no id is given. */
  async test(id) {
    const machines = id === undefined || id === null || String(id).trim() === ''
      ? this.current.machines
      : [this.machine(id)];
    if (machines.length === 0) {
      return [{ ok: false, stage: 'config', target: '(none)', message: 'no machines are configured ／ 还没有配置任何机器' }];
    }
    return Promise.all(machines.map((machine) => testMachine(this.deps, machine)));
  }
}
