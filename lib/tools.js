/**
 * Model-facing fleet management: the same operations the settings panel performs, so an agent can
 * add a machine, inspect the fleet, or prove connectivity without a human editing JSON.
 *
 * @module dsh-fleet/tools
 */
import { machineTarget } from './fleet.js';
import { buildSetup, generatedKeyPaths, generateKey } from './setup.js';

/** Render a JsonValue tool result as plain text blocks. */
function textBlocks(text) {
  return [{ type: 'text', text }];
}

/** Wording shared by every management tool, so the model learns the addressing rules once. */
const ADDRESSING =
  'A machine is addressed by its delegation tool name — shown as `toolName` by fleet_list, and derived from the '
  + 'machine name unless `toolName` overrides it. Call that tool to delegate work to it; the two names may differ. '
  + 'Absolute paths and the whole task are required, because the remote agent cannot see this conversation.'
  + ' ／ 一台机器由它的派活工具名寻址 —— `fleet_list` 把它显示为 `toolName`：默认由机器名派生，除非 `toolName` 覆盖了它。'
  + '要派活就调那个工具；这两个名字可以不一样。'
  + '必须给绝对路径和完整任务，因为远程 agent 看不到本会话。';

/**
 * The model-facing usage policy, registered as a system-prompt section.
 *
 * This is what makes a natural-language request reach a tool: a tool schema says what a call looks like, never
 * when to make it. Without this, "run this on all machines" has no addressee at all, and a machine referred to by
 * the name a person sees has to be guessed at.
 *
 * The live machine list is deliberately NOT embedded here: the section is registered once per activation while
 * machines come and go, so a list baked in would be stale. It points at `fleet_list` instead, which is always
 * current.
 *
 * @returns the section text.
 */
export function usageSectionText() {
  return [
    '【English】',
    'DuckFleet: this deployment is a flock — the same agent runs on other machines, reachable over SSH/ACP.',
    '',
    'When the user asks for work to happen on another machine — by name ("on laptop-01"), as a set ("on the',
    'laptop and the desktop"), or as all of them ("run this everywhere", "all machines") — delegate it:',
    '',
    '1. Call `fleet_list` first. It shows every machine as `toolName  user@host  label`, and the delegation tool of',
    '   each machine IS that `toolName`. A machine the user names by the label they see in Settings may map to a',
    '   different tool name; `fleet_list` is the mapping, so read it rather than guessing.',
    '2. One machine: call its own tool once.',
    '3. Several, or all: call one tool per machine IN THE SAME MESSAGE, so they run concurrently. There is no',
    '   separate broadcast tool — "all machines" means every machine `fleet_list` reported.',
    '   To exclude one, simply do not call its tool.',
    '4. Each remote agent is a separate agent on a separate machine, in its own session. It sees nothing from this',
    '   conversation, so give absolute paths and the complete task in `prompt`.',
    '5. A long task on several machines: pass `run_in_background: true` per call and collect the answers with',
    '   `job_output`.',
    '',
    'Report results per machine, including which ones failed and why. Do not silently drop a machine the user asked',
    'for.',
    '',
    '【中文】',
    'DuckFleet（鸭群）：这个部署是一群机器 —— 同一个 agent 也跑在别的机器上，可以通过 SSH/ACP 访问。',
    '',
    '当用户要求把活干在另一台机器上时 —— 无论是点名（"在 laptop-01 上跑"）、给一个集合（"在笔记本和台式机上"），',
    '还是指全部（"在所有机器上跑一遍"、"全部机器"）—— 就派活：',
    '',
    '1. 先调 `fleet_list`。它把每台机器显示为 `toolName  user@host  label`，而每台机器的派活工具就是那个 `toolName`。',
    '   用户在设置里看到的 label 所对应的机器，可能映射到另一个工具名；`fleet_list` 就是这张映射表，所以去读它，不要猜。',
    '2. 只有一台：调它自己的工具一次。',
    '3. 好几台或全部：在**同一条消息里**每台机器各调一次工具，这样它们会并发执行。没有单独的广播工具 ——',
    '   "全部机器"指的是 `fleet_list` 报告出来的每一台。要排除某台，不调它的工具即可。',
    '4. 每个远程 agent 都是另一台机器上、另一个会话里的独立 agent。它看不到本会话的任何内容，',
    '   所以 `prompt` 里必须给绝对路径和完整任务。',
    '5. 多台机器上的长任务：每次调用传 `run_in_background: true`，之后用 `job_output` 收结果。',
    '',
    '逐台报告结果，包括哪几台失败了、为什么失败。不许静默漏掉用户点名要用的机器。',
  ].join('\n');
}

/** A single string-typed output schema for the management tools. */
const TEXT_RESULT = {
  schema: { type: 'string' },
  render: (_args, value) => textBlocks(String(value)),
};

/**
 * Machine fields a management tool may set, as a JSON Schema fragment.
 *
 * Only what can differ between machines. Which ssh to run, which key to use, what to execute on the far side,
 * and which profile serves ACP are the CONTROLLER's settings: they live once in `defaults` and are read from
 * there, so they are not offered here. Change them with `fleet_defaults`.
 */
const MACHINE_FIELD_SCHEMA = {
  id: { type: 'string', description: 'Stable machine id, e.g. "b". Optional: derived from `label` when omitted, which accepts any script. Does NOT affect the tool name. ／ 稳定的机器 id，例如 "b"。可选：省略时由 `label` 派生，任何文字都接受。不影响工具名。' },
  label: { type: 'string', description: 'Display name shown in the panel. Its ASCII letters name the tool, so "Home Server" yields `pc_home_server`. ／ 面板里显示的名字。它的 ASCII 字母决定工具名，所以 "Home Server" 会得到 `pc_home_server`。' },
  description: { type: 'string', description: 'One sentence about what this machine is for; appended to the delegation tool description. ／ 一句话说明这台机器是干什么用的；会追加到该派活工具的描述后面。' },
  host: { type: 'string', description: 'Hostname or IP of the controlled machine, e.g. "192.168.1.11". Required when adding. ／ 被控机的主机名或 IP，例如 "192.168.1.11"。新增时必填。' },
  user: { type: 'string', description: 'Login user on the controlled machine. Required when adding. ／ 被控机上的登录用户。新增时必填。' },
  port: { type: 'number', description: 'SSH port (default 22). ／ SSH 端口（默认 22）。' },
  cwd: { type: 'string', description: 'Working directory for the remote agent, as an absolute path on the CONTROLLED machine. Also becomes the local ssh process cwd, so it must exist on both. Leave empty to use the delegating session\'s workspace. ／ 远程 agent 的工作目录，写**被控机**上的绝对路径。它同时会成为本地 ssh 进程的 cwd，所以两边都必须存在。留空则使用发起派活那个会话的工作区。' },
  permission: { type: 'string', enum: ['allow', 'reject'], description: 'How this machine\'s permission prompts are auto-answered (default "allow"). ／ 这台机器的权限询问如何自动应答（默认 "allow"）。' },
  toolName: { type: 'string', description: 'Override the generated delegation tool name. ／ 覆盖自动生成的派活工具名。' },
  extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra ssh arguments appended before the target. ／ 追加在目标之前的额外 ssh 参数。' },
  platform: {
    type: 'string',
    enum: ['windows', 'posix', 'none'],
    description: 'What the CONTROLLED machine runs; selects the environment preamble prepended to every delegation. '
      + '"windows" (default) sends the Windows facts and the rules derived from them, plus the task-agnostic working rules. '
      + '"posix" sends only the working rules. "none" sends no preamble. Set it when the machine is not Windows — the default is an assumption, not a measurement. '
      + '／ 被控机跑什么系统，决定每次派活前置的环境提示词。"windows"（默认）附带 Windows 环境事实及其派生约束，再加与任务无关的工作通则；'
      + '"posix" 只附带工作通则；"none" 不附带。被控机不是 Windows 时要显式设置 —— 默认值是假设，不是实测。',
  },
};

/**
 * Build every management tool definition over one runtime.
 *
 * @param runtime - the fleet runtime with config, reconcile, and test operations.
 * @param options - `version` reports the loaded revision, `deps` supplies the subprocess seam the
 *   setup tool needs.
 * @returns definitions ready for `ctx.tools.register`.
 */
export function managementToolDefinitions(runtime, options = {}) {
  const setupDeps = { subprocess: options.setup?.subprocess ?? options.deps?.subprocess };
  // Named once here: `fleet_prune` reaches the platform probe and the prune itself through the plugin's deps,
  // and spelling that path out at each call site is how a bare `deps` reference slipped in and threw at run
  // time instead of at review time.
  const pluginDeps = options.deps ?? {};
  return [
    {
      name: 'fleet_version',
      description: 'Report which revision of the DuckFleet plugin this process is running, and which generated copy of it was loaded. '
        + 'The revision and the loaded digest come from that copy; the sources digest is computed from the files on disk now. '
        + 'They match while the loaded copy is the current code — when they differ, re-enable the plugin row to pick up the new sources.'
        + ' ／ 报告当前进程运行的是 DuckFleet 插件的哪个修订版，以及加载的是哪一份生成的副本。'
        + '修订版与「加载副本摘要」读自那份副本本身；「当前源码摘要」由磁盘上的文件现算。'
        + '两者相同表示加载的副本就是当前代码；不同则重新启用插件行以载入新源码。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: TEXT_RESULT,
      isConcurrencySafe: () => true,
      async execute() {
        const info = typeof options.version === 'function' ? options.version() : { revision: 'unknown' };
        return [
          `Revision:          ${String(info.revision)}`,
          `Loaded generation: ${String(info.generation)}`,
          `Loaded digest:     ${String(info.digest ?? 'unknown')}`,
          `Sources digest:    ${String(info.sourcesDigest ?? 'unknown')}`,
          `In sync:           ${info.inSync === true ? 'yes' : info.inSync === false ? 'no' : 'unknown'}`,
          `Copy built:        ${info.generated === true ? 'yes' : `no${info.problem === undefined ? '' : ` (${String(info.problem)})`}`}`,
          `Tools:             ${Array.isArray(info.tools) ? info.tools.join(', ') : 'unknown'}`,
          '',
          'To apply an edited plugin: disable and re-enable its row in Settings → Plugins, then read this again.',
        ].join('\n');
      },
    },
    {
      name: 'fleet_setup',
      description: 'Produce the setup instructions for a controlled machine that is not ready yet — and, when this controller has no SSH key to offer, offer to create one. '
        + 'The controlled machine must be prepared before it can be added: an SSH server listening, its firewall letting this controller in, an ACP profile present, and THIS controller\'s public key in its `authorized_keys`. '
        + 'That cannot be done from here (it needs a login the controller does not have yet), so this returns one self-contained prompt to paste on the controlled machine. '
        + 'Every step in it checks the current state first and installs only what is missing, so one prompt covers both a bare machine and one that is already partly configured. '
        + 'Only the PUBLIC key travels in it; the private key never leaves this controller. '
        + 'Show the returned prompt to the user verbatim so they can copy it.'
        + ' ／ 为一台还没准备好的被控机生成安装说明 —— 如果本主控机没有可提供的 SSH 密钥，还会提议新建一个。'
        + '被控机必须先准备好才能加入：SSH 服务在监听、防火墙放本主控机进来、ACP profile 已存在，'
        + '并且本主控机的公钥已经在它的 `authorized_keys` 里。'
        + '这些都没法从这里完成（需要主控机还没有的登录权限），所以本工具返回一段自包含的提示词，供你粘贴到被控机上执行。'
        + '它里面每一步都先检查当前状态，只装缺的东西，所以同一段提示词既适用于全新机器，也适用于已经配置了一半的机器。'
        + '只有**公钥**会在其中传递；私钥永远不离开本主控机。'
        + '把返回的这段提示词原样展示给用户，方便他们复制。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user: { type: 'string', description: 'Login user on the controlled machine (the account that will run the ACP agent). ／ 被控机上的登录用户（也就是将来运行 ACP agent 的那个账号）。' },
          host: { type: 'string', description: 'Hostname or IP of the controlled machine, for the instructions\' wording only. ／ 被控机的主机名或 IP，仅用于安装说明的措辞。' },
          port: { type: 'number', description: 'SSH port the controller will connect to on that machine (default 22). State it here when the machine listens on a non-default port, so the instructions do not ask it to open the wrong one. ／ 主控机连接该机器用的 SSH 端口（默认 22）。如果那台机器监听的不是默认端口，要在这里说明，免得安装说明让它开错端口。' },
          keyFile: { type: 'string', description: 'Private key on THIS controller to offer. Omit to use the shared default, or the first candidate in ~/.ssh. ／ 本主控机上要提供的私钥。省略则使用共享默认值，或 ~/.ssh 里的第一个候选。' },
          generateKey: {
            type: 'boolean',
            description: `Create a dedicated key pair (${generatedKeyPaths().privateKey}) when no usable key exists. `
              + 'This writes outside the workspace, so ask the user first and pass true only after they agree.'
              + ` ／ 在没有任何可用密钥时新建一对其专用的密钥（${generatedKeyPaths().privateKey}）。`
              + '这会写到工作区之外，所以先问用户，得到同意之后才传 true。',
          },
        },
      },
      output: TEXT_RESULT,
      isConcurrencySafe: () => false,
      async execute(args) {
        // An explicit argument wins; otherwise the shared default applies, so one key set once really is
        // offered for every machine. A composition without a readable config simply has no default.
        const shared = (await runtime.config())?.defaults?.keyFile;
        const attempt = await buildSetup(setupDeps, { ...args, keyFile: args?.keyFile ?? shared });
        if (attempt.problem === undefined) {
          return [
            'Setup instructions for the controlled machine.',
            `Key offered: ${attempt.keyFile} (public half ${attempt.keySource === 'derived' ? 'derived from the private key' : 'read from the .pub beside it'})`,
            `Fingerprint to expect back: ${attempt.fingerprint}`,
            '',
            'Give the user the prompt below verbatim, so they can copy it to the controlled machine:',
            '',
            attempt.prompt,
          ].join('\n');
        }
        const lines = [
          `Cannot build the setup instructions: ${attempt.problem}`,
          attempt.hint ?? '',
        ];
        if (args?.generateKey === true) {
          const made = await generateKey(setupDeps, {});
          lines.push(made.problem === undefined
            ? `Created ${made.privateKey} and offered its public half (fingerprint ${made.fingerprint}). Call fleet_setup again to get the prompt.`
            : `Key generation failed: ${made.problem}`);
        } else {
          lines.push('Pass `generateKey: true` to create one — but ask the user first, because it writes outside the workspace.');
        }
        return lines.filter((line) => line !== '').join('\n');
      },
    },
    {
      name: 'fleet_list',
      description: `List the configured controlled machines, the delegation tool name bound to each, and whether its provider is currently registered. ／ 列出已配置的被控机、每台绑定的派活工具名，以及它的 provider 当前是否已注册。 ${ADDRESSING}`,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: TEXT_RESULT,
      isConcurrencySafe: () => true,
      async execute() {
        const config = await runtime.config();
        const status = runtime.status();
        const lines = status.warnings.length === 0
          ? (config.machines.length === 0
            ? ['No machines are configured yet. Run fleet_setup first to prepare the controlled machine, then fleet_add.']
            : config.machines.map((machine) => `- ${machine.toolName}  ${machineTarget(machine)}  label=${machine.label}  cwd=${machine.cwd === '' ? "(session workspace)" : machine.cwd}  permission=${machine.permission}  ${runtime.stateOf(machine.id)}`))
          : [];
        return [
          `Fleet configuration: ${runtime.storePath()}`,
          ...lines,
          ...status.warnings.length === 0 ? [] : ['Warnings:', ...status.warnings.map((warning) => `- ${warning}`)],
          '',
          ADDRESSING,
        ].join('\n');
      },
    },
    {
      name: 'fleet_add',
      description: `Add a controlled machine, or update one that already exists (matched by \`id\`, or by \`label\` when no id is given). The delegation tool and its ACP provider are registered immediately, so the new tool is callable in this same session. The controlled machine must already have this controller's public key authorized — run fleet_setup first when it does not. ／ 新增一台被控机，或更新一台已存在的（按 \`id\` 匹配；没给 id 时按 \`label\` 匹配）。派活工具及其 ACP provider 会立即注册，所以新工具在本会话里就能调。被控机必须已经授权了本主控机的公钥 —— 如果还没有，先跑 fleet_setup。 ${ADDRESSING}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { ...MACHINE_FIELD_SCHEMA },
        // `label` rather than `id`: the label is what a person chooses, and the id and tool name come from it.
        required: ['label', 'host', 'user'],
      },
      output: TEXT_RESULT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = await runtime.upsertMachine(args);
        return [
          `${result.created ? 'Added' : 'Updated'} machine "${result.machine.id}" -> tool "${result.machine.toolName}" (${machineTarget(result.machine)}).`,
          result.created
            ? `The provider and tool are live now; delegate with ${result.machine.toolName}.`
            : 'The provider and tool were re-registered with the new settings.',
          `Verify connectivity with fleet_test ({"id":"${result.machine.id}"}) before relying on it.`,
        ].join('\n');
      },
    },
    {
      name: 'fleet_remove',
      description: 'Remove a controlled machine and unregister its delegation tool and provider. The machine record is deleted from the fleet document. ／ 移除一台被控机，并注销它的派活工具和 provider。该机器的记录会从 fleet 文档中删除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'Machine id to remove. ／ 要移除的机器 id。' } },
        required: ['id'],
      },
      output: TEXT_RESULT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const removed = await runtime.removeMachine(args?.id);
        return `Removed machine "${removed.id}" and unregistered tool "${removed.toolName}".`;
      },
    },
    {
      name: 'fleet_test',
      description: 'Prove one configured machine is reachable and can serve ACP: spawns ssh, completes the ACP handshake, then tears the child down. Costs no model tokens. Report the stage that failed when it does not succeed. ／ 验证某台已配置的机器可达、并且能提供 ACP：拉起 ssh、完成 ACP 握手，然后把子进程收掉。不消耗任何模型 token。如果没有成功，报告失败在哪一个阶段。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Machine id to test. Omit to test every configured machine. ／ 要测试的机器 id。省略则测试每一台已配置的机器。' },
        },
      },
      output: TEXT_RESULT,
      isConcurrencySafe: () => true,
      async execute(args) {
        const results = await runtime.test(args?.id);
        return results.map((result) => result.ok
          ? `OK   ${result.target}: ${result.message} (${String(result.elapsedMs)}ms)`
          : `FAIL ${result.target}: stage=${result.stage} ${result.message}`).join('\n');
      },
    },
    {
      name: 'fleet_defaults',
      description: 'Read or change the defaults applied to newly added machines. Omit every field to read the current defaults. ／ 读取或修改应用到新加入机器的默认值。所有字段都省略则读取当前默认值。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sshCommand: { type: 'string' },
          keyFile: { type: 'string', description: 'The private key on THIS controller, shared by every machine — a machine record cannot override it. Empty means "pick from this controller\'s SSH directory". ／ 主控机上的私钥，所有机器共用，机器记录无法覆盖。留空表示「从本机 SSH 目录里挑一把」。' },
          cwd: { type: 'string' },
          permission: { type: 'string', enum: ['allow', 'reject'] },
          remoteCommand: { type: 'string' },
          profile: { type: 'string' },
          autoArchive: {
            type: 'object',
            additionalProperties: false,
            description: 'LAB. Rules `fleet_prune` follows on a controlled machine. ／ 实验性。`fleet_prune` 在被控机上遵循的规则。',
            properties: {
              enabled: { type: 'boolean', description: 'Whether the rules are in force. Off unless asked for, because pruning stops that machine\'s app. ／ 规则是否生效。默认关闭 —— 整理会停掉那台机器的应用，所以必须显式开启。' },
              keepLast: { type: 'number', description: 'How many of the newest delegation sessions stay visible (0-500). ／ 保留最近多少个派活会话可见（0-500）。' },
              maxAgeHours: { type: 'number', description: 'Also archive delegation sessions older than this many hours; 0 disables the age rule. ／ 同时归档超过这么多小时的派活会话；0 表示不用年龄规则。' },
            },
          },
        },
      },
      output: TEXT_RESULT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const patch = Object.fromEntries(Object.entries(args ?? {}).filter(([, value]) => value !== undefined));
        const defaults = Object.keys(patch).length === 0
          ? (await runtime.config()).defaults
          : await runtime.setDefaults(patch);
        return `Fleet defaults: ${JSON.stringify(defaults, null, 2)}`;
      },
    },
    {
      name: 'fleet_prune',
      description: 'LAB, WINDOWS ONLY. Clear the pile-up of ungrouped sessions a controlled machine accumulates: every delegation opens a new ACP session, and the ACP path files it under no workspace, so they collect in the sidebar\'s "ungrouped" bucket. This stops that machine\'s DSH, archives every delegation session except the newest `keep`, then starts it again on the interactive desktop. The dry run (`inspect`) changes nothing and reports what it measured. WARNING: the machine\'s app goes down for the duration, so a delegation running there is interrupted. Untested on macOS and Linux — those machines are refused rather than attempted.'
        + ' ／ 实验性，仅限 Windows。清理被控机上堆积的未分组会话：每次派活都会开一个新的 ACP 会话，而 ACP 那条路径不把它归入任何 workspace，于是全落在侧边栏的「未分组」里。'
        + '本工具会停掉那台机器的 DSH，把除最近 `keep` 个以外的派活会话全部归档，然后在交互式桌面上重新启动它。'
        + '`inspect` 为预演，不改动任何东西，只报告它测到了什么。'
        + '**注意**：期间那台机器的应用会下线，正在跑的派活会中断。macOS 和 Linux 未经验证 —— 遇到会直接拒绝，不会尝试。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Machine id to prune. Omit to prune every configured machine. ／ 要整理的机器 id。省略则整理每一台已配置的机器。' },
          keep: { type: 'number', description: 'How many of the newest delegation sessions to leave visible. Defaults to the shared `autoArchive.keepLast`. ／ 保留最近多少个派活会话可见。默认取共享设置 `autoArchive.keepLast`。' },
          inspect: { type: 'boolean', description: 'Report what would happen without changing anything, including the platform probe. ／ 只报告会发生什么，不改动任何东西，包含平台探测结果。' },
        },
      },
      output: TEXT_RESULT,
      // It stops a running app, so two of these must never overlap.
      isConcurrencySafe: () => false,
      async execute(args) {
        const config = await runtime.config();
        const requested = typeof args?.id === 'string' && args.id !== '' ? args.id : undefined;
        const machines = requested === undefined
          ? config.machines
          : config.machines.filter((machine) => machine.id === requested || machine.toolName === requested);
        if (machines.length === 0) {
          return requested === undefined
            ? 'No machines are configured, so there is nothing to prune.'
            : `No machine matches "${requested}". Call fleet_list to see the configured ids.`;
        }

        const rules = config.defaults.autoArchive ?? {};
        const keep = Number.isInteger(args?.keep) ? args.keep : rules.keepLast;
        const lines = [`fleet_prune (LAB, Windows only) — keep=${String(keep)}`];
        for (const machine of machines) {
          if (args?.inspect === true) {
            const platform = await pluginDeps.detectPlatform(machine);
            lines.push(`- ${machine.toolName}: platform=${platform}`);
            continue;
          }
          const report = await pluginDeps.pruneMachine(machine, { keep });
          lines.push(`- ${machine.toolName}: ${report.ok ? 'OK' : 'FAILED'} platform=${String(report.platform)}`
            + (report.fleetSessions === undefined ? '' : ` sessions=${String(report.fleetSessions)} archivedThisRun=${String(report.archivedThisRun)}`)
            + (report.archivedAfter === undefined ? '' : ` archivedTotal=${String(report.archivedAfter)}`)
            + (report.onDesktop ? ' app-on-desktop=true' : '')
            + (report.problem === undefined ? '' : `\n    ${report.problem}`));
          if (report.stdout !== undefined && report.stdout !== '') {
            lines.push(...report.stdout.split('\n').map((line) => `    | ${line}`));
          }
        }
        return lines.join('\n');
      },
    },
  ];
}
