/**
 * The fleet plugin's Host body, loaded under a generation token by `index.js`.
 *
 * A machine record (`id`, `host`, `user`, plus a few options) becomes, in this same Host
 * composition:
 *   - one `ctx.subagents` ACP provider named `fleet-<id>` that drives `ssh <target> dsh --profile acp`
 *     as its stdio child, and
 *   - one delegation tool (named after the machine, or `toolName` when set) that the model calls like any other tool.
 *
 * The plugin speaks ACP itself over Node built-ins (see `./acp.js`), so it does not depend on the
 * shipped ACP backend being mounted, and it registers nothing until a machine exists.
 *
 * @module dsh-fleet/plugin
 */
import { closePromptShare, registerFleetApi } from './api.js';
import { machineToolDefinition } from './fleet.js';
import { detectPlatform, pruneMachine } from './prune.js';
import { FleetRuntime } from './runtime.js';
import { useLoaderFrom } from './resolve.js';
import { runCommandCollect } from './setup.js';
import { managementToolDefinitions, usageSectionText } from './tools.js';

/** Loader metadata: the plugin's own name, distinct from the package name. */
export const name = 'fleet';

/**
 * Host services this plugin cannot work without.
 *
 * The prompt service is deliberately NOT declared here. `inject` is a Cordis hard dependency: if the service is
 * not projected for this plugin, the whole activation fails, and that took the entire plugin down — every
 * delegation tool with it — over a section of explanatory text. The delegation tools are the point; the section
 * is an improvement, so it is registered when the service is reachable and skipped when it is not.
 */
export const inject = ['subagents', 'tools', 'webServer'];

/**
 * Handed the package entry point's version reporter.
 *
 * `index.js` calls this before `apply`, which keeps the dependency one-way: the entry point owns the
 * generation token, and this module never imports it back. The `fleet_version` tool reports it, so a
 * reload is confirmed by reading a value rather than by inferring from behavior.
 */
let versionProbe;

/**
 * The disposer releasing this module's own registrations.
 *
 * Re-enabling the plugin row calls `apply` again on the same module instance, so the previous run's
 * tools and route must be released first: the web server refuses to install the same route twice, and
 * a duplicate tool name is rejected by the registry.
 */
let releasePrevious;

/**
 * Set the version reporter used by the `fleet_version` tool.
 *
 * @param probe - a function returning `{ revision, generation, generated, problem? }`.
 */
export function setVersionProbe(probe) {
  versionProbe = probe;
}

/** The generator-aware view of what this process runs. */
function version() {  const probed = typeof versionProbe === 'function' ? versionProbe() : {};
  return {
    revision: probed.revision ?? 'unknown',
    generation: probed.generation ?? 'unknown',
    generated: probed.generated ?? false,
    ...probed.problem === undefined ? {} : { problem: probed.problem },
    tools: [
      'fleet_version', 'fleet_setup', 'fleet_list', 'fleet_add',
      'fleet_remove', 'fleet_test', 'fleet_defaults',
    ],
  };
}

/**
 * No `Config` export on purpose: the fleet document is user data that the panel and the `fleet_*`
 * tools rewrite at runtime, so a loader-validated config would turn every edit into a composition
 * change. `DSH_FLEET_STORE` overrides the document location when one is needed.
 *
 * @param ctx - the Host context owning all registrations.
 * @param config - the loader row's config: `{ storePath? }`.
 * @returns a promise settling after the configured machines are registered, so a registration
 *   failure reaches the caller rather than only the log.
 */
export async function apply(ctx, config = {}) {
  // Let optional dependencies resolve the way this profile already loads its own plugins.
  useLoaderFrom(ctx);

  // Re-enabling the plugin row runs `apply` again while the previous run's registrations may still
  // be in place; releasing them first keeps apply idempotent instead of colliding on the management
  // tool names or on the settings route, which the web server refuses to install twice.
  const previous = releasePrevious;
  releasePrevious = undefined;
  if (typeof previous === 'function') {
    try {
      previous();
    } catch (error) {
      ctx.logger.warn('fleet: releasing the previous registration failed: %o ／ 释放上一次的注册失败：%o', error);
    }
  }

  const subprocess = ctx.get('subprocess');
  const jobs = ctx.get('jobs');
  const deps = {
    subprocess,
    jobs,
    subagents: ctx.subagents,
    /** What this process is running, for the version tool and the panel's route. */
    version,
    /** Whether a machine can be spawned at all in this composition. */
    subprocessReady: () => subprocess !== undefined,
    /**
     * The controller's identity key, read from the shared defaults at the moment it is needed.
     *
     * Both the ssh argv and the delegation tool's description depend on it, and the operator can change it
     * while the plugin is live (the panel's "generate a new key" does exactly that), so this is a function
     * rather than a value captured at activation.
     */
    /**
     * The controller's shared settings, read from the document at the moment they are needed.
     *
     * The ssh argv depends on them, and the operator can change any of them while the plugin is live (the
     * panel's shared-settings block does exactly that), so this is a function rather than a value captured at
     * activation.
     */
    settings: () => ({
      sshCommand: runtime?.settings().sshCommand ?? '',
      keyFile: runtime?.settings().keyFile ?? '',
      profile: runtime?.settings().profile ?? '',
    }),
    onStderr: undefined,
    toolDefinition: (machine) => machineToolDefinition(deps, machine),
    /**
     * Run a one-shot command on a controlled machine over ssh, OUTSIDE the ACP channel.
     *
     * The session-prune feature needs this because it stops the app on the far side, so the ACP channel it
     * would otherwise use is the very thing being taken down. Only `fleet_prune` calls this.
     */
    runRemote: async (argv, command) => {
      if (subprocess === undefined) {
        return { started: false, code: -1, stdout: '', stderr: 'the subprocess service is unavailable in this Host composition' };
      }
      // The command stays one argv element: ssh joins the remaining words and hands the string to the far
      // side's shell, and `sshShellArgv` is the one place that knows how to quote for that shell.
      return await runCommandCollect((spec) => subprocess.spawn(spec), [...argv, command]);
    },
    /** Platform probe for the prune tool; see `lib/prune.js`. */
    detectPlatform: (machine) => detectPlatform(deps, machine),
    /** The prune itself; see `lib/prune.js`. */
    pruneMachine: (machine, options) => pruneMachine(deps, machine, options),
  };

  const runtime = new FleetRuntime(ctx, deps, {
    storePath: typeof config?.storePath === 'string' ? config.storePath : undefined,
    logger: ctx.logger,
  });

  if (subprocess === undefined) {
    ctx.logger.warn('fleet: the `subprocess` service is unavailable, so no machine can start; configuration and tool registration still work ／ 没有 `subprocess` 服务，任何机器都启动不了；配置和工具注册仍然可用');
  }
  if (jobs === undefined) {
    ctx.logger.info('fleet: no `jobs` service, so delegation tools run in the foreground only ／ 没有 `jobs` 服务，派活工具只能在前台运行');
  }

  const releases = [];
  for (const definition of managementToolDefinitions(runtime, { version, deps })) {
    releases.push(ctx.tools.register(definition));
  }

  /**
   * Tell the model how a request reaches a machine.
   *
   * A tool schema describes a call, never when to make one, so without this the delegation tools are only
   * reachable if the model happens to notice them and works out which name belongs to which machine.
   *
   * Reached through `ctx.get` rather than `inject`, and skipped when absent: the prompt service may not be
   * projected for a profile plugin, and a missing section must not cost the delegation tools. Registered per
   * activation and released with the rest, so a disable/enable pair replaces it instead of accumulating
   * duplicates — which the prompt registry rejects outright.
   */
  const promptService = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
  if (promptService !== undefined && typeof promptService.section === 'function') {
    releases.push(promptService.section({
      name: 'fleet:usage',
      // After the harness's own sections, alongside the other plugin usage policies.
      order: 118,
      text: usageSectionText(),
    }));
  } else {
    ctx.logger.info('fleet: no `systemPrompt` service, so the fleet usage section is not registered; the tools still work and `fleet_list` shows which name maps to which machine ／ 没有 `systemPrompt` 服务，所以没有注册鸭群用法说明段；工具照常可用，`fleet_list` 会显示哪个名字对应哪台机器');
  }

  // The settings panel's endpoint is optional: a composition without a web server still gets every
  // delegation tool and every management tool.
  const disposeApi = registerFleetApi(ctx, runtime);
  if (disposeApi !== undefined) releases.push(disposeApi);
  else ctx.logger.info('fleet: no `webServer` service, so the settings panel will not answer requests ／ 没有 `webServer` 服务，设置面板将无法响应请求');

  const release = () => {
    for (const disposer of [...releases].reverse()) {
      try {
        disposer();
      } catch (error) {
        ctx.logger.warn('fleet: releasing a registration failed: %o ／ 释放一个注册失败：%o', error);
      }
    }
    // The LAN share listener belongs to this plugin's lifetime: a released generation must not leave a
    // port open on the local network.
    void closePromptShare().catch((error) => {
      ctx.logger.warn('fleet: closing the prompt share failed: %o ／ 关闭提示词共享失败：%o', error);
    });
    runtime.dispose();
    if (releasePrevious === release) releasePrevious = undefined;
  };
  releasePrevious = release;

  if (typeof ctx.effect !== 'function') throw new Error('fleet: the Host context exposes no `effect` ／ Host 上下文没有暴露 `effect`');
  ctx.effect(() => release, 'fleet: machine registrations');

  await runtime.start();
}
