/**
 * The fleet settings panel: one page that manages every controlled machine.
 *
 * Plain browser bundle (`window.__ModuleLoader__.load`), so React comes from the platform module
 * table and no Harness Client package is imported. Data comes from the Host half's own JSON
 * endpoint (`/fleet/api`) because the Typert Remote protocol package ships only inside the desktop
 * application and cannot be imported by a profile plugin; that endpoint drives exactly the runtime
 * the `fleet_*` tools drive, so the panel and the agent share one implementation.
 *
 * @module dsh-duck-fleet/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-duck-fleet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'fleet';
    const API = '/fleet/api';

    /**
     * Releases the dictionaries this factory last registered, if that registration is still live.
     *
     * The locale service allows ONE occupant per (namespace, locale) and throws on a second registration.
     * `ctx.effect` releases its own registration when the same context is re-applied, but this half is loaded
     * from the plugin bundle and can be applied again while the previous registration is still there — a page
     * reload, or the HMR receiver reacting to a rebuilt bundle. Disposing first also matters for correctness
     * rather than only for avoiding an error: the newer bundle carries the newer strings, and skipping the
     * registration would leave the old ones showing.
     */
    let releaseDictionaries;

    /**
     * Releases the settings-page contribution and the wait for the slot that hosts it.
     *
     * Same reason as {@link releaseDictionaries}: both are disposed through the caller's `ctx.effect`, which
     * does nothing for a factory instance that is being applied again.
     */
    let releasePanel;
    let releaseInjection;

    /**
     * Last-known-state mirror.
     *
     * The panel is the only place a person can see the fleet when the Host half cannot answer, so
     * every successful read is mirrored into `localStorage`: a composition without a `webServer`
     * route then shows the last known fleet plus an explanation instead of an empty page.
     */
    const CACHE_KEY = 'dsh-fleet:last-state';

    /** Read the mirrored snapshot, or `undefined` when there is none. */
    function readCache() {
      try {
        const raw = globalThis.localStorage?.getItem(CACHE_KEY);
        return raw === null || raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    }

    /** Mirror a snapshot; storage being unavailable or full is never fatal. */
    function writeCache(state) {
      try {
        globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(state));
      } catch {
        // A read-only or full store only costs the fallback.
      }
    }

    /**
     * Localized text lives here rather than in a fetched dictionary: the panel must render with
     * the host's locale immediately. `locale/<lang>.json` beside the package stays the display
     * metadata the plugin list reads without activating anything.
     */
    const DICTIONARIES = {
      en: {
        title: 'DuckFleet',
        machines: 'Machines',
        add: 'Add machine',
        edit: 'Edit',
        remove: 'Remove',
        save: 'Save',
        cancel: 'Cancel',
        test: 'Test',
        reload: 'Reload',
        ready: 'ready',
        toolTaken: 'tool name taken',
        notRegistered: 'not registered',
        empty: 'No machine is configured yet. Add one to get a delegation tool for it.',
        id: 'ID',
        label: 'Name',
        host: 'Host',
        user: 'User',
        port: 'Port',
        sshCommand: 'ssh executable',
        remoteCommand: 'Remote command',
        profile: 'Remote profile',
        cwd: 'Working directory',
        defaultKeyFile: 'SSH connection key',
        defaultKeyFileHint: 'e.g. C:/Users/you/.ssh/id_ed25519',
        sharedTitle: 'Shared settings',
        sharedNote: 'set once, inherited by every machine; each machine can still override them',
        changeKey: 'Generate a new key',
        changeKeyDone: 'Now using',
        changeKeyStale: 'Machines prepared with the previous key keep working; prepare them again to move them over.',
        envMissing: 'SSH tools are missing on THIS machine',
        envIntro: 'This plugin needs ssh and ssh-keygen here, on the machine running DSH. Paste the prompt below into a session ON THIS MACHINE to have it install them.',
        envCopy: 'Copy',
        envCopied: 'Copied',
        envCopyFailed: 'Select and copy manually',
        envRecheck: 'Check again',
        permission: 'Permission',
        toolName: 'Tool name',
        description: 'Description',
        storePath: 'Configuration file',
        failed: 'Failed',
        invalid: 'Every machine needs a name, a host, and a user.',
        note: 'Each machine becomes a delegation tool named after it; the remote agent works in its own context and returns only its final answer.',
        setupIntro: 'It needs an SSH server, a firewall that lets this computer in, an ACP profile, and this computer\'s public key. '
          + 'The prompt below does all of that on that machine — it only assumes DSH is installed there. '
          + 'Paste it into that machine\'s DSH or terminal, then come back and add the machine.',
        setupGenerate: 'No key yet — create one',
        setupGenerateHint: 'Writes outside the workspace (in your .ssh folder). You will be asked to confirm.',
        setupCopy: 'Copy prompt',
        setupPromptReady: 'The prompt is ready — hand it to the controlled machine:',
        setupChars: 'characters',
        forkTitle: 'Add a machine',
        forkIntro: 'Two ways. Pick one — they are alternatives, not steps.',
        forkManual: 'Fill it in myself',
        forkManualHint: 'You already know the hostname, the login account and the port.',
        forkPrompt: 'Get it automatically',
        forkPromptHint: 'Copy the prompt to the controlled machine and run it there. It prepares itself and reports back what to fill in.',
        forkPromptLabel: 'Copy the prompt to the controlled machine, and run it there.',
        forkPromptReturns: 'It ends by reporting three things:',
        forkPromptReturn1: 'every value this form needs',
        forkPromptReturn2: 'the complete JSON for the form',
        forkPromptReturn3: 'a ready fleet_add call',
        pairWaiting: 'Waiting for that machine to report…',
        pairProgress: 'Progress',
        pairStageWaiting: 'not reported yet',
        pairStateRunning: 'Running',
        pairStateDone: 'Finished',
        pairStateFailed: 'Failed',
        pairStateExpired: 'No report before the deadline',
        pairOk: 'done',
        pairStarted: 'running',
        pairSkipped: 'already satisfied',
        pairFail: 'failed',
        pairReports: 'reports received',
        pairDeadline: 'stop waiting in',
        pairAdded: 'Added to the list and verified:',
        pairAddedUnverified: 'Added, but the check did not pass:',
        pairChoose: 'That machine reported more than one address. Pick the one this controller should use:',
        pairNone: 'That machine did not report an address to use.',
        pairStageSshd: 'SSH service and login account',
        pairStageFirewall: 'Firewall',
        pairStageProfile: 'acp profile',
        pairStageKey: 'Public key',
        pairStageVerify: 'Verify it starts',
        pairStageDone: 'Report the configuration',
        editorView: 'View:',
        viewForm: 'Form',
        viewJson: 'JSON',
        jsonHint: 'The machine record itself. Saving sends exactly this; unknown fields are rejected rather than dropped silently.',
        jsonParseFailed: 'not valid JSON',
        jsonRequired: 'required',
        jsonBadType: 'must be text',
        jsonBadPort: 'must be a port number between 1 and 65535',
        jsonBadChoice: 'must be one of:',
        jsonUnknownField: 'not a field of a machine record',
        jsonDuplicateLabel: 'another machine already uses this name — the Host will disambiguate it',
        jsonFixFirst: 'Fix the JSON before saving.',
        setupServe: 'Serve on the LAN instead',
        setupServed: 'Fetch it on the controlled machine:',
        setupServeCloses: 'closes in',
        setupServeOnce: 'one fetch only',
        setupServeFor: 'only for',
        setupServeStop: 'Close now',
        setupServeFailed: 'Could not start the local listener',
        setupCopyFailed: 'Copy failed — select the text and copy it manually.',
        setupKey: 'Key offered',
        setupFingerprint: 'Fingerprint to expect back',
        setupNoKey: 'No SSH key on this computer to offer yet.',
        setupClose: 'Close',
        setupStep1: 'Copy the prompt and run it on the controlled machine.',
        setupStep2: 'Come back, fill in host and user, and save.',
        setupStep3: 'Press Test to prove the connection.',
        pruneTitle: 'Session cleanup',
        pruneLab: 'LAB',
        pruneNote: 'Windows only, and untested elsewhere. Every delegation opens a session that belongs to no workspace, so they pile up under "ungrouped". This archives all but the newest few — which stops that machine\'s DSH for about half a minute and interrupts anything running there.',
        pruneEnabled: 'Follow these rules',
        pruneKeepLast: 'Keep newest',
        pruneRun: 'Clean up',
        pruneDone: 'done',
        pruneArchived: 'archived',
        pruneFailed: 'failed',
      },
      zh: {
        title: '鸭群',
        machines: '机器',
        add: '添加机器',
        edit: '编辑',
        remove: '删除',
        save: '保存',
        cancel: '取消',
        test: '测试',
        reload: '重新载入',
        ready: '就绪',
        toolTaken: '工具名被占用',
        notRegistered: '未注册',
        empty: '还没有配置任何机器。添加一台，就会得到它专属的派活工具。',
        id: '标识',
        label: '名称',
        host: '主机',
        user: '用户',
        port: '端口',
        sshCommand: 'ssh 可执行文件',
        remoteCommand: '远端命令',
        profile: '远端 profile',
        cwd: '工作目录',
        defaultKeyFile: 'SSH 连接密钥',
        defaultKeyFileHint: '例如 C:/Users/you/.ssh/id_ed25519',
        sharedTitle: '共享设置',
        sharedNote: '设一次，所有机器继承；单台仍可覆盖',
        changeKey: '生成新密钥',
        changeKeyDone: '已改用',
        changeKeyStale: '用旧密钥配好的机器仍可连接；要让它们改用新密钥，重新走一遍引导即可。',
        envMissing: '本机缺少 SSH 工具',
        envIntro: '这个插件需要本机的 ssh 和 ssh-keygen。把下面的提示词粘到【本机】的会话里执行，让它装好。',
        envCopy: '复制',
        envCopied: '已复制',
        envCopyFailed: '请手动选中复制',
        envRecheck: '重新检测',
        permission: '权限策略',
        toolName: '工具名',
        description: '说明',
        storePath: '配置文件',
        failed: '失败',
        invalid: '每台机器都需要名称、主机和用户。',
        note: '每台机器会变成一个以它命名的派活工具：远端 agent 在自己的上下文里干活，只把最终答案带回来。',
        setupIntro: '它需要：SSH 服务、放行本机的防火墙、ACP profile、以及本机的公钥。'
          + '下面的提示词会到那台机器上把这些都做好 —— 它只假设那里装好了 DSH。'
          + '贴进那台机器的 DSH 或终端，然后回来添加机器。',
        setupGenerate: '还没有密钥 —— 现在创建一把',
        setupGenerateHint: '会写到工作区之外（你的 .ssh 目录），执行前会请你确认。',
        setupCopy: '复制提示词',
        setupPromptReady: '提示词已生成 —— 交给被控机：',
        setupChars: '字符',
        forkTitle: '添加机器',
        forkIntro: '两条路，选一条 —— 它们是并列的两种做法，不是前后步骤。',
        forkManual: '手动填写配置',
        forkManualHint: '你已经知道主机名、登录账号和端口。',
        forkPrompt: '自动获取配置',
        forkPromptHint: '把提示词复制到被控机上执行。它自己完成准备，然后把该填的值回报给你。',
        forkPromptLabel: '复制提示词到被控机上执行。',
        forkPromptReturns: '它最后会输出三样：',
        forkPromptReturn1: '每一个表单要填的值',
        forkPromptReturn2: '完整表单 JSON',
        forkPromptReturn3: 'fleet_add 指令',
        pairWaiting: '等那台机器回报……',
        pairProgress: '进度',
        pairStageWaiting: '尚未回报',
        pairStateRunning: '进行中',
        pairStateDone: '已完成',
        pairStateFailed: '失败',
        pairStateExpired: '期限内没有回报',
        pairOk: '完成',
        pairStarted: '进行中',
        pairSkipped: '本来就满足',
        pairFail: '失败',
        pairReports: '已收到汇报',
        pairDeadline: '停止等待还有',
        pairAdded: '已添加进列表并验证通过：',
        pairAddedUnverified: '已添加，但验证没过：',
        pairChoose: '那台机器报了不止一个地址。请挑一个本主控机要用的：',
        pairNone: '那台机器没有报出可用的地址。',
        pairStageSshd: 'SSH 服务与登录账号',
        pairStageFirewall: '防火墙',
        pairStageProfile: 'acp profile',
        pairStageKey: '公钥',
        pairStageVerify: '验证能否启动',
        pairStageDone: '回报配置',
        editorView: '视图：',
        viewForm: '表单',
        viewJson: 'JSON',
        jsonHint: '这里就是机器记录本身。保存时原样发送；不认识的字段会被拒绝，而不是悄悄丢掉。',
        jsonParseFailed: '不是合法的 JSON',
        jsonRequired: '必填',
        jsonBadType: '必须是文本',
        jsonBadPort: '必须是 1 到 65535 之间的端口号',
        jsonBadChoice: '只能是：',
        jsonUnknownField: '不是机器记录里的字段',
        jsonDuplicateLabel: '已有另一台机器用了这个名字 —— 主控机会自动区分开',
        jsonFixFirst: '请先修好 JSON 再保存。',
        setupServe: '改用局域网链接',
        setupServed: '在被控机上访问这个地址获取：',
        setupServeCloses: '自动关闭倒计时',
        setupServeOnce: '仅一次',
        setupServeFor: '仅限',
        setupServeStop: '立即关闭',
        setupServeFailed: '无法启动本机监听',
        setupCopyFailed: '复制失败 —— 请手动选中文本复制。',
        setupKey: '提供的密钥',
        setupFingerprint: '期望回报的指纹',
        setupNoKey: '本机还没有可提供的 SSH 密钥。',
        setupClose: '关闭',
        setupStep1: '复制提示词，拿到被控机上执行。',
        setupStep2: '回来填 host 和 user，保存。',
        setupStep3: '点「测试」验证连通。',
        pruneTitle: '会话清理',
        pruneLab: '实验性',
        pruneNote: '仅限 Windows，其他平台未经验证。每次派活都会开一个不属于任何 workspace 的会话，于是全堆在「未分组」里。这里把除最近几个以外的全部归档 —— 代价是那台机器的 DSH 会停约半分钟，正在跑的任务会中断。',
        pruneEnabled: '启用这套规则',
        pruneKeepLast: '保留最近',
        pruneRun: '清理',
        pruneDone: '已完成',
        pruneArchived: '已归档',
        pruneFailed: '失败',
      },
    };

    /**
     * The editable fields.
     *
     * `hint` is used only when the machine has no value for the field, and it says what will apply
     * instead — a made-up example address in a host field reads as if it were the current value.
     */
    /**
     * The per-machine fields.
     *
     * ONLY what is specific to one machine. Everything the controller does the same way for every machine —
     * which ssh to run, which key to authenticate with, what to execute on the controlled side, the workspace,
     * the permission policy — lives once in the shared settings above. Asking for those here as well meant the
     * same value had to be retyped per machine, which is exactly what a shared default exists to prevent.
     *
     * `hint` is used only when the machine has no value for the field, and it says what will apply instead — a
     * made-up example address in a host field reads as if it were the current value.
     */
    const FIELDS = [
      // No `id` row: the id is an internal key, derived from the name when it is not given.
      { key: 'label', label: 'label', hint: 'required — what you call this machine; an English name also names its tool ／ 必填 —— 你对这台机器的叫法；英文名还会顺便给它的工具命名' },
      { key: 'host', label: 'host', hint: 'required — hostname or IP of the controlled machine ／ 必填 —— 被控机的主机名或 IP' },
      { key: 'user', label: 'user', hint: 'required — login user on that machine ／ 必填 —— 那台机器上的登录用户' },
      { key: 'port', label: 'port', kind: 'number', hint: '22' },
      // How to start the agent ON THAT machine. `dsh` only works when it is on that machine's non-interactive
      // PATH, which is much smaller than an interactive one — hence the usual value is the product's absolute
      // CLI path, and hence this cannot be a shared setting.
      { key: 'remoteCommand', label: 'remoteCommand', hint: 'dsh — or the full path to that machine\'s dsh ／ dsh —— 或那台机器上 dsh 的完整路径' },
      // A working directory is a path on THAT machine, and auto-answering its permission prompts is a judgement
      // about that machine, so both stay per machine — and a new machine starts from the shared value.
      { key: 'cwd', label: 'cwd', hint: 'empty — reuse this session\'s directory ／ 留空 = 复用本会话的目录' },
      { key: 'permission', label: 'permission', kind: 'select', options: ['allow', 'reject'] },
      { key: 'toolName', label: 'toolName', hint: 'letters/digits — derived from the name; editable, and this is how the model calls it ／ 字母/数字 —— 由名称派生；可以改，模型就是用这个名字来调的' },
      { key: 'description', label: 'description' },
    ];

    /** One machine's editable draft, seeded from a stored record. */
    function draftOf(machine) {
      const draft = {};
      for (const field of FIELDS) {
        draft[field.key] = machine?.[field.key] === undefined || machine[field.key] === null ? '' : String(machine[field.key]);
      }
      return draft;
    }

    /** Turn one draft back into the machine patch the Host validates. */
    function patchOf(draft) {
      const patch = {};
      for (const field of FIELDS) {
        const value = draft[field.key];
        if (value === '') continue;
        patch[field.key] = field.kind === 'number' ? Number(value) : value;
      }
      return patch;
    }

    /** Call the Host endpoint, turning a failure payload into a throw. */
    async function call(operation, body) {
      let response;
      try {
        response = await fetch(`${API}/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      } catch (failure) {
        throw new Error(`fleet: the Host endpoint ${API} is unreachable (${String(failure?.message ?? failure)}). `
          + 'This composition has no web server, so manage the fleet with the agent tools (fleet_list / fleet_add / fleet_test) '
          + 'or edit the configuration file directly.'
          + ` ／ 连不上 Host 端点 ${API}：这个组合没有 web server，请改用 agent 工具（fleet_list / fleet_add / fleet_test）管理鸭群，`
          + `或直接编辑配置文件。（原因：${String(failure?.message ?? failure)}）`);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        // A 404 here means the Host half registered no route: the composition served this page from
        // a carrier other than `webServer`, so there is nothing for the panel to talk to.
        throw new Error(response.status === 404
          ? `fleet: the Host half registered no ${API} route. This composition has no \`webServer\` service, so the panel cannot reach it — `
            + 'use the agent tools (fleet_list / fleet_add / fleet_test) or edit the configuration file directly.'
            + ` ／ Host 半边没有注册 ${API} 路由。这个组合没有 \`webServer\` 服务，面板连不上它 —— 请改用 agent 工具（fleet_list / fleet_add / fleet_test），或直接编辑配置文件。`
          : `fleet: ${operation} returned HTTP ${String(response.status)} with no JSON body ／ ${operation} 返回了 HTTP ${String(response.status)}，但没有 JSON 内容`);
      }
      if (payload?.ok !== true) throw new Error(String(payload?.error ?? `fleet: ${operation} failed ／ ${operation} 失败`));
      return payload.value;
    }

    /** Small text button matching the host's quiet controls. */
    function button(key, label, onClick, options = {}) {
      return h('button', {
        key,
        type: 'button',
        onClick,
        disabled: options.disabled === true,
        style: {
          font: 'inherit',
          fontSize: '12px',
          color: options.danger === true ? 'var(--dsw-alias-text-danger, #c33)' : 'inherit',
          // `active` marks the selected member of a tab row. It is presentation only — the caller still decides
          // what is selected — so a two-tab row needs no second widget to show where it is.
          background: options.active === true ? 'var(--dsw-alias-bg-secondary, #8882)' : 'transparent',
          border: `1px solid ${options.active === true ? 'var(--dsw-alias-border, #8888)' : 'var(--dsw-alias-border, #8884)'}`,
          borderRadius: '6px',
          padding: '3px 8px',
          cursor: options.disabled === true ? 'default' : 'pointer',
          opacity: options.disabled === true ? 0.5 : 1,
        },
      }, label);
    }

    function fieldRow(field, draft, onChange, t) {
      const value = draft[field.key];
      const label = h('span', {
        key: 'label',
        style: { flex: '0 0 130px', color: 'var(--dsw-alias-text-secondary, inherit)', fontSize: '12px' },
      }, t(field.label));
      const control = field.kind === 'select'
        ? h('select', {
          key: 'input',
          value,
          onChange: (event) => onChange(field.key, event.target.value),
          style: { flex: '1 1 auto', font: 'inherit', padding: '4px 6px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, #8884)', background: 'transparent', color: 'inherit' },
        }, ['', ...field.options].map((option) => h('option', { key: option, value: option }, option === '' ? '—' : option)))
        : h('input', {
          key: 'input',
          type: field.kind === 'number' ? 'number' : 'text',
          value,
          placeholder: field.hint ?? '',
          onChange: (event) => onChange(field.key, event.target.value),
          style: { flex: '1 1 auto', minWidth: '0', font: 'inherit', padding: '4px 6px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, #8884)', background: 'transparent', color: 'inherit' },
        });
      return h('div', { key: field.key, style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '2px 0' } }, label, control);
    }

    /**
     * The panel. Everything it renders comes from the Host snapshot; every mutation goes back
     * through the same endpoint, so the UI and the agent tools share one implementation.
     */
    /**
     * Validate one machine object, the way the Host half will.
     *
     * The JSON view is a direct edit of the record, so a mistake in it would otherwise travel to the Host and
     * come back as a server-side sentence about an identifier the operator never chose. Checking here turns
     * that into a field-level complaint beside the box they are typing in.
     *
     * The rules are derived from {@link FIELDS}, so a field added there is validated without a second edit, and
     * a field nobody declared — a typo, or a property from a newer version — is rejected instead of silently
     * carried into the document.
     *
     * @param parsed - the parsed JSON value.
     * @param existing - the machines already configured, for the duplicate check.
     * @param t - the bound translate function; passed in rather than closed over, so this stays a plain
     *   function with no dependency on the component's scope.
     * @returns `{ errors, patch }`; `patch` is undefined when anything failed.
     */
    function validateMachine(parsed, existing, t) {
      const errors = {};
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { errors: { '': 'the JSON must be one object ／ 这里应该是一个对象' } };
      }
      const known = new Set(FIELDS.map((field) => field.key));
      for (const key of Object.keys(parsed)) {
        if (!known.has(key)) errors[key] = `${t('jsonUnknownField')} ／ unknown field`;
      }
      for (const field of FIELDS) {
        const value = parsed[field.key];
        const required = field.key === 'label' || field.key === 'host' || field.key === 'user';
        if (value === undefined || value === null || value === '') {
          if (required) errors[field.key] = t('jsonRequired');
          continue;
        }
        if (field.kind === 'number') {
          const number = typeof value === 'number' ? value : Number(value);
          if (!Number.isInteger(number) || number <= 0 || number > 65535) errors[field.key] = t('jsonBadPort');
          continue;
        }
        if (typeof value !== 'string') { errors[field.key] = t('jsonBadType'); continue; }
        if (field.kind === 'select' && !field.options.includes(value)) {
          errors[field.key] = `${t('jsonBadChoice')} ${field.options.join(' / ')}`;
        }
      }
      // The label is what a person chooses; the id and tool name are derived from it. A second machine with the
      // same name is not a syntax error — the Host disambiguates it — so this is a warning, not a refusal.
      const warning = typeof parsed.label === 'string' && existing.some((machine) => machine.label === parsed.label)
        ? t('jsonDuplicateLabel')
        : undefined;
      if (Object.keys(errors).length > 0) return { errors, warning };
      const patch = {};
      for (const field of FIELDS) {
        const value = parsed[field.key];
        if (value === undefined || value === null || value === '') continue;
        patch[field.key] = field.kind === 'number' ? Number(value) : value;
      }
      return { errors, warning, patch };
    }

    /**
     * The settings page.
     *
     * Reachable from add/edit, not only from a first-run wizard: a machine is re-prepared whenever it is
     * replaced or reinstalled, so the prompt must be obtainable at any time.
     */
    function FleetPanel(props) {
      const t = props.t;
      const [state, setState] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [status, setStatus] = React.useState(undefined);
      const [editing, setEditing] = React.useState(undefined);
      const [draft, setDraft] = React.useState(undefined);
      // Which of the editor's two views is open. Declared here, above the helpers that switch between them,
      // and `machines` is derived here too because the JSON view validates against the machines already
      // configured — a duplicate label is worth warning about before the Host silently disambiguates it.
      /**
       * The two ways to add a machine, as a top-level choice.
       *
       * `manual` types what the operator knows; `prompt` has the controlled machine discover and report it.
       * They are alternatives, so this is a tab rather than a step, and the JSON view is a detail INSIDE the
       * manual tab — it edits the same record the form does, so making it a peer of the form put the split in
       * the wrong place: the choice that matters is where the values come from, not how they are typed.
       */
      const [addTab, setAddTab] = React.useState(undefined);
      const [editorView, setEditorView] = React.useState('form');
      const [jsonText, setJsonText] = React.useState(undefined);
      const [jsonErrors, setJsonErrors] = React.useState(undefined);
      const machines = Array.isArray(state?.machines) ? state.machines : [];
      const [busy, setBusy] = React.useState(false);
      const [setup, setSetup] = React.useState(undefined);
      const [copyNote, setCopyNote] = React.useState(undefined);
      // The shared values last written to the server, so blurring an unchanged field is a no-op rather than a
      // redundant document write.
      const [savedDefaultsKey, setSavedDefaultsKey] = React.useState(undefined);
      const [savedDefaults, setSavedDefaults] = React.useState(undefined);
      // The most recently generated pair, shown until the panel is reopened.
      const [freshKey, setFreshKey] = React.useState(undefined);
      // This controller's SSH tooling, checked once on load.
      const [environment, setEnvironment] = React.useState(undefined);
      // The LAN address the prompt is currently served on, if any.
      const [served, setServed] = React.useState(undefined);
      // Seconds left on that offer, refreshed by polling the listener.
      const [remaining, setRemaining] = React.useState(0);
      /**
       * The live pairing: what the machine reports, stage by stage.
       *
       * Separate from `served` because the two channels have different lifetimes. `served` is the prompt
       * address, which is worthless once fetched and closes on the first read; this is the reporting channel,
       * which stays up for as long as the machine takes. Keeping them in one state object would have made the
       * countdown disappear at the moment the interesting part begins.
       */
      const [pairing, setPairing] = React.useState(undefined);
      // The last session-prune outcome, per machine id. LAB feature: shown so the operator can see what was
      // measured — the archive counts and whether the app came back on the desktop — rather than a bare "done".
      const [pruned, setPruned] = React.useState(undefined);

      /**
       * Run the session prune for one machine.
       *
       * Not routed through `run`: that helper treats a response as the new state, and this operation answers
       * `{ report, state }` because the report is the point. The app on that machine goes down for the
       * duration, which is why this is a deliberate click and not something the panel does on load.
       */
      const pruneNow = React.useCallback(async (machine) => {
        setBusy(true);
        setError(undefined);
        try {
          const answered = await call('prune', { id: machine.id });
          setPruned((current) => ({ ...current, [machine.id]: answered?.report }));
          if (answered?.state !== undefined) {
            setState(answered.state);
            writeCache(answered.state);
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }, []);

      const run = React.useCallback(async (what, operation) => {
        setBusy(true);
        setError(undefined);
        try {
          const value = await operation();
          if (what === 'test') {
            setStatus(value.results);
            if (value.state !== undefined) {
              setState(value.state);
              writeCache(value.state);
            }
          } else {
            setState(value);
            writeCache(value);
            setStatus(undefined);
          }
          return value;
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
          return undefined;
        } finally {
          setBusy(false);
        }
      }, []);

      const reload = React.useCallback(() => run('read', () => call('read', {})), [run]);

      React.useEffect(() => {
        void reload();
      }, [reload]);

      /**
       * The environment banner.
       *
       * Checked on load because a missing `ssh` would otherwise surface much later, during a delegation,
       * as a bare spawn error that never mentions OpenSSH. The remedy is a prompt for a session on THIS
       * machine — installing an SSH client needs elevation, which that session can do and this plugin
       * cannot.
       */
      const checkEnvironment = async () => {
        try {
          setEnvironment(await call('environment', {}));
        } catch (failure) {
          setEnvironment({ ok: false, ssh: { present: false, detail: String(failure) }, keygen: { present: false, detail: '' } });
        }
      };

      React.useEffect(() => {
        void checkEnvironment();
      }, []);

      const environmentCard = environment === undefined || environment.ok === true
        ? null
        : h('div', {
          key: 'environment',
          style: {
            border: '1px solid var(--dsw-alias-border, #8884)',
            borderLeft: '3px solid var(--dsw-alias-text-danger, #c33)',
            borderRadius: '8px',
            padding: '10px',
            margin: '6px 0',
          },
        },
        h('strong', { key: 'title' }, t('envMissing')),
        h('p', { key: 'intro', style: { fontSize: '12px', opacity: 0.85, margin: '4px 0' } }, t('envIntro')),
        h('ul', { key: 'state', style: { fontSize: '12px', opacity: 0.85, margin: '0 0 6px 18px' } },
          h('li', { key: 'ssh' }, `ssh: ${String(environment.ssh?.detail ?? '')}`),
          h('li', { key: 'keygen' }, `ssh-keygen: ${String(environment.keygen?.detail ?? '')}`)),
        h('textarea', {
          key: 'prompt',
          id: 'fleet-env-prompt',
          readOnly: true,
          value: String(environment.prompt ?? ''),
          rows: 10,
          style: {
            width: '100%',
            boxSizing: 'border-box',
            font: 'inherit',
            fontSize: '12px',
            padding: '6px',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border, #8884)',
            background: 'transparent',
            color: 'inherit',
            resize: 'vertical',
          },
        }),
        h('div', { key: 'buttons', style: { display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap' } },
          button('envcopy', t('envCopy'), () => void copyPrompt(String(environment.prompt ?? ''), 'fleet-env-prompt', 'env'), { disabled: busy }),
          button('envcheck', t('envRecheck'), () => void checkEnvironment(), { disabled: busy }),
          copyNoteFor('env') === undefined ? null : h('span', { key: 'note', style: { fontSize: '12px', opacity: 0.8 } }, copyNoteFor('env'))));

      const startAdd = () => {
        setEditing('__new__');
        setAddTab('manual');
        // Seed from the shared defaults, so a value set once (the controller's key, above all) does not have
        // to be retyped per machine. `cwd` stays empty unless a default says otherwise: empty means "reuse
        // this session's directory", the only safe choice for a machine never spoken to.
        setDraft(draftOf({ ...(state?.defaults ?? {}), cwd: state?.defaults?.cwd ?? '' }));
        setEditorView('form');
        setJsonText(undefined);
        setJsonErrors(undefined);
      };

      const startEdit = (machine) => {
        setEditing(machine.id);
        setAddTab('manual');
        setDraft(draftOf(machine));
        setEditorView('form');
        setJsonText(undefined);
        setJsonErrors(undefined);
      };

      /** Open the prompt tab, generating the prompt as it opens. */
      const startPrompt = () => {
        setAddTab('prompt');
        setEditing(undefined);
        setDraft(undefined);
        void openSetup();
      };

      /** Close whichever path is open and return to the chooser. */
      const closeAdd = () => {
        setAddTab(undefined);
        setEditing(undefined);
        setDraft(undefined);
        setEditorView('form');
        setJsonText(undefined);
        setJsonErrors(undefined);
        setSetup(undefined);
        setCopyNote(undefined);
        setServed(undefined);
        setError(undefined);
      };

      /**
       * Switch the editor between the form and a direct view of the record.
       *
       * The JSON is built from the draft rather than kept alongside it, so the two views cannot disagree: the
       * form is the single source while it is open, and JSON edits are folded back into the draft on the way
       * out. Entering JSON therefore always shows what the form currently holds.
       */
      const showJson = () => {
        const record = {};
        for (const field of FIELDS) {
          const value = draft?.[field.key];
          if (value === undefined || value === '') continue;
          record[field.key] = field.kind === 'number' ? Number(value) : value;
        }
        setJsonText(JSON.stringify(record, null, 2));
        setJsonErrors(undefined);
        setEditorView('json');
      };

      /**
       * Leave the JSON view, folding what it holds back into the draft when it is usable.
       *
       * UNCONDITIONAL. An earlier version refused to switch when the JSON did not parse or validate, which
       * trapped the operator in a view with no way back — the complaint was already on screen, so refusing
       * added nothing but a dead end. When the text is unusable the draft simply keeps its last good value and
       * the errors stay where they are; the strict check happens on save, where it belongs.
       */
      const showForm = () => {
        const parsed = parseJson();
        const checked = parsed.ok === false ? undefined : validateMachine(parsed.value, machines, t);
        setJsonErrors(parsed.ok === false ? parsed.errors : checked.errors);
        if (parsed.ok === false || checked.patch === undefined) { setEditorView('form'); return; }
        const next = {};
        for (const field of FIELDS) {
          const value = checked.patch[field.key];
          next[field.key] = value === undefined ? '' : String(value);
        }
        setDraft(next);
        setEditorView('form');
      };

      /** Parse the textarea, turning a syntax error into a field-level complaint about the whole box. */
      const parseJson = () => {
        try {
          return { ok: true, value: JSON.parse(String(jsonText ?? '')) };
        } catch (failure) {
          return { ok: false, errors: { '': `${t('jsonParseFailed')}: ${failure instanceof Error ? failure.message : String(failure)}` } };
        }
      };

      /** The tool name a given machine name would produce, mirroring the store's derivation. */
      const toolNameFor = (label) => {
        const slug = String(label ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
        return slug === '' ? '' : `pc_${slug}`;
      };

      /**
       * Keep the tool name in step with the machine name, until the operator takes it over.
       *
       * The tool name is what the model calls, so it defaults to something readable derived from the name the
       * operator chose — `pc_b` came from deriving it from the internal id, which nobody can remember. Typing
       * in the tool name field stops the following, so a deliberate override is never overwritten.
       */
      const onFieldChange = (key, value) => {
        setDraft((current) => {
          const next = { ...current, [key]: value };
          if (key === 'label' && current?.toolNameEdited !== true) {
            next.toolName = toolNameFor(value);
          }
          if (key === 'toolName') next.toolNameEdited = value !== '';
          return next;
        });
      };

      /**
       * Build the controlled-side prompt.
       *
       * No depth is offered: every step in the prompt checks first and skips what is already in place,
       * so one prompt covers both a brand-new machine and one that is already prepared. Asking the user
       * to choose only invited the wrong answer — "freshly installed" reads as *install DSH first*,
       * while the prompt is meant to be pasted after DSH is there.
       */
      const openSetup = React.useCallback(async (overrides = {}) => {
        setBusy(true);
        setError(undefined);
        setCopyNote(undefined);
        try {
          const value = await call('setup', {
            user: draft?.user ?? '',
            host: draft?.host ?? '',
            keyFile: state?.defaults?.keyFile ?? '',
          });
          setSetup(value);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }, [draft]);

      /**
       * Copy a prompt to the clipboard, falling back to selecting it.
       *
       * A settings page served over a non-secure origin has no clipboard API, and the fallback for that is to
       * select the text so the operator can copy it by hand. Since the guide stopped rendering the prompt, the
       * fallback has nothing to select and reports a plain failure instead — which is the honest outcome, and
       * the reason `copyPrompt` still takes an element id rather than being reduced to a clipboard call.
       */
      const copyPrompt = async (text, elementId, note) => {
        try {
          if (globalThis.navigator?.clipboard?.writeText !== undefined) {
            await globalThis.navigator.clipboard.writeText(text);
            setCopyNote({ note, result: 'ok' });
            return;
          }
          throw new Error('clipboard API unavailable');
        } catch {
          const area = globalThis.document?.getElementById(elementId);
          if (area !== undefined && area !== null && typeof area.select === 'function') {
            area.select();
            setCopyNote({ note, result: 'manual' });
            return;
          }
          setCopyNote({ note, result: 'failed' });
        }
      };

      /** The text shown beside a copy button, derived from that button's own result. */
      const copyNoteFor = (note) => (copyNote?.note !== note
        ? undefined
        : copyNote.result === 'ok' ? t('envCopied') : copyNote.result === 'manual' ? t('envCopyFailed') : t('setupCopyFailed'));

      const submit = async () => {
        // Saving from the JSON view must go through the same check the view performs, or the box could be left
        // holding something invalid while the form's draft — which is what would actually be sent — silently
        // disagrees with it. Fixing the JSON is the only way forward from here.
        if (editorView === 'json') {
          const parsed = parseJson();
          if (parsed.ok === false) { setJsonErrors(parsed.errors); setError(t('jsonFixFirst')); return; }
          const checked = validateMachine(parsed.value, machines, t);
          if (checked.patch === undefined) { setJsonErrors(checked.errors); setError(t('jsonFixFirst')); return; }
          setJsonErrors(undefined);
        }
        const patch = patchOf(draft);
        // A name is what identifies a machine to a person; the id is derived from it on the Host when none is
        // given. Editing an existing machine keeps the id it already has, so the id never has to be shown.
        if (patch.label === undefined || patch.host === undefined || patch.user === undefined) {
          setError(t('invalid'));
          return;
        }
        const editingExisting = editing !== undefined && editing !== '__new__';
        const value = await run('upsert', () => call('upsert', {
          machine: editingExisting ? { ...patch, id: editing } : patch,
        }));
        if (value !== undefined) {
          setEditing(undefined);
          setDraft(undefined);
          setEditorView('form');
          setJsonText(undefined);
          setJsonErrors(undefined);
        }
      };

      const rows = machines.length === 0
        ? [h('p', { key: 'empty', style: { color: 'var(--dsw-alias-text-secondary, inherit)', fontSize: '13px' } }, t('empty'))]
        : machines.map((machine) => {
          const result = Array.isArray(status) ? status.find((entry) => entry?.target === machine?.target) : undefined;
          const machineState = machine?.registered !== true
            ? t('notRegistered')
            : machine?.toolVisible !== true ? t('toolTaken') : t('ready');
          // What the badge says, and why it is short: it reports a STATE, and after a test it reports how long
          // that test took. It previously read `就绪 · 3253ms`, which says "ready" twice and lengthened the row
          // enough to push the buttons onto a second line.
          const badge = result === undefined
            ? machineState
            : result.ok ? `${String(result.elapsedMs)}ms` : `${t('failed')} · ${String(result.stage)}`;
          return h('div', {
            key: machine.id,
            // A column of two rows: the facts, then the actions.
            //
            // They used to share one line, and a test result pushed the buttons onto a second one — the badge grows
            // from `就绪` to `就绪 · 3253ms` after a test, and at that width the row no longer fitted. Giving the
            // actions their own row means the result can be any length without moving a single control.
            //
            // `minWidth: 0` is what keeps the first row inside the card: a flex item refuses to shrink below its
            // content, so without it a long name or target stretched the card past the pane.
            style: {
              border: '1px solid var(--dsw-alias-border, #8884)',
              borderRadius: '8px',
              padding: '8px 10px',
              margin: '6px 0',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              minWidth: 0,
              maxWidth: '100%',
              boxSizing: 'border-box',
              overflow: 'hidden',
            },
          },
          h('div', { key: 'facts', style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', minWidth: 0 } },
            h('strong', { key: 'label', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, machine.label),
            h('code', { key: 'target', style: { fontSize: '12px', opacity: 0.8, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, machine.target),
            h('span', { key: 'tool', style: { fontSize: '12px', opacity: 0.8, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, machine.toolName)),
          h('div', { key: 'statusline', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 } },
            h('span', { key: 'badge', style: { fontSize: '12px', opacity: 0.8 } }, badge),
            h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
            h('span', { key: 'actions', style: { display: 'flex', gap: '8px', flex: '0 0 auto', flexWrap: 'nowrap' } },
              button('test', t('test'), () => run('test', () => call('test', { id: machine.id })), { disabled: busy }),
              button('edit', t('edit'), () => startEdit(machine), { disabled: busy }),
              button('remove', t('remove'), () => run('remove', () => call('remove', { id: machine.id })), { disabled: busy, danger: true }))),
          result !== undefined && !result.ok
            ? h('div', { key: 'detail', style: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #c33)', overflowWrap: 'anywhere' } }, `${String(result.stage)}: ${String(result.message)}`)
            : null);
        });

      /**
       * One complaint about the JSON view.
       *
       * Rendered as its own row rather than folded into the value, so it cannot be mistaken for part of the
       * record being edited.
       */
      const jsonErrorRow = (key, message) => h('div', {
        key: `jsonerr-${key}`,
        style: { color: 'var(--dsw-alias-text-danger, #c33)', fontSize: '12px' },
      }, key === '' ? message : `${key}: ${message}`);

      /** The JSON view: the record itself, validated as it is typed. */
      const jsonEditor = h('div', { key: 'jsonview', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { key: 'hint', style: { fontSize: '12px', opacity: 0.75 } }, t('jsonHint')),
        h('textarea', {
          key: 'json',
          id: 'fleet-json',
          value: jsonText ?? '',
          rows: 14,
          spellCheck: false,
          disabled: busy,
          onChange: (event) => {
            const next = event.target.value;
            setJsonText(next);
            // Validated on every keystroke so the complaint tracks the fix. Invalid JSON is reported against
            // the box as a whole; everything else lands on the field it belongs to.
            try {
              const parsed = JSON.parse(next);
              setJsonErrors(validateMachine(parsed, machines, t).errors);
            } catch (failure) {
              setJsonErrors({ '': `${t('jsonParseFailed')}: ${failure instanceof Error ? failure.message : String(failure)}` });
            }
          },
          style: {
            width: '100%',
            font: '12px/1.5 ui-monospace, monospace',
            padding: '6px',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border, #8884)',
            background: 'transparent',
            color: 'inherit',
            boxSizing: 'border-box',
          },
        }),
        ...Object.entries(jsonErrors ?? {}).map(([key, message]) => jsonErrorRow(key, String(message))));

      const editor = editing === undefined
        ? null
        : h('div', {
          key: 'editor',
          style: { border: '1px solid var(--dsw-alias-border, #8884)', borderRadius: '8px', padding: '10px', margin: '6px 0' },
        },
        h('div', { key: 'viewswitch', style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
          h('span', { key: 'label', style: { fontSize: '12px', opacity: 0.75 } }, t('editorView')),
          button('toform', t('viewForm'), showForm, { disabled: busy || editorView === 'form' }),
          button('tojson', t('viewJson'), showJson, { disabled: busy || editorView === 'json' })),
        editorView === 'json' ? jsonEditor : h('div', { key: 'formview' }, FIELDS.map((field) => fieldRow(field, draft, onFieldChange, t))),
        h('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          button('save', t('save'), submit, { disabled: busy }),
          button('cancel', t('cancel'), closeAdd, { disabled: busy }),
        ));

      /**
       * The shared connection key.
       *
       * One controller normally authenticates with one key, so the key belongs here rather than repeated
       * in every machine record; new machines are seeded from these values. A machine can still override
       * it when it genuinely needs a different one.
       *
       * "Generate a new key" writes a NEW pair beside the old one and switches the default to it. It does
       * not delete the old key: machines already prepared with it still authenticate with its public half,
       * so removing it would lock the operator out of them.
       */
      const sharedKeyFile = state?.defaults?.keyFile ?? '';

      /**
       * Write one shared default.
       *
       * `setDefaults` merges into the document's `defaults`, which is what a new machine is seeded from and
       * what the fields a machine leaves alone fall back to. Editing here is therefore the difference between
       * setting a value once and retyping it for every machine.
       */
      const saveSharedDefault = (key, value) => {
        setState((current) => ({ ...current, defaults: { ...current?.defaults, [key]: value } }));
        if (key === 'keyFile') setSavedDefaultsKey(value);
        void run('setDefaults', () => call('setDefaults', { patch: { [key]: value } }));
      };

      /** Generate a fresh pair and adopt it. Read through `call`: `run` would publish it as the config. */
      const generateNewKey = async () => {
        setBusy(true);
        setError(undefined);
        try {
          const made = await call('key', {});
          if (typeof made?.problem === 'string') {
            setError(made.problem);
            return;
          }
          setFreshKey(made);
          saveSharedDefault('keyFile', made.privateKey);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const keyNotice = freshKey === undefined
        ? null
        : h('div', {
          key: 'keynotice',
          style: { margin: '2px 0 4px 0', opacity: 0.85 },
        },
        h('div', { key: 'done' }, `${t('changeKeyDone')} ${String(freshKey.privateKey)}`),
        h('div', { key: 'stale', style: { opacity: 0.8 } }, t('changeKeyStale')));

      /**
       * One shared default, edited in place.
       *
       * Written on blur rather than per keystroke: every change is a document write that re-registers the
       * fleet, so typing a path would otherwise rewrite the file once per character.
       */
      const sharedField = (key, label, extra) => {
        // `path` lets a nested block reuse this row: `autoArchive.keepLast` reads and writes two levels down
        // while still saving through the same blur-then-PATCH path as the flat settings.
        const segments = (extra?.path ?? key).split('.');
        const read = (source) => segments.reduce((value, segment) => (value === undefined || value === null ? undefined : value[segment]), source);
        const fold = (target, value) => {
          const [head, ...rest] = segments;
          if (rest.length === 0) return { ...target, [head]: value };
          return { ...target, [head]: fold(target?.[head] ?? {}, value) };
        };
        return h('div', {
          key: `shared-${segments.join('-')}`,
          style: { display: 'flex', alignItems: 'baseline', gap: '8px', flex: '1 1 320px', minWidth: 0 },
        },
        h('label', {
          key: 'label',
          htmlFor: `fleet-shared-${segments.join('-')}`,
          style: { flex: '0 0 110px', opacity: 0.8 },
        }, t(label)),
        h('input', {
          key: 'input',
          id: `fleet-shared-${segments.join('-')}`,
          type: extra?.type ?? 'text',
          checked: extra?.type === 'checkbox' ? read(state?.defaults) === true : undefined,
          value: extra?.type === 'checkbox' ? undefined : (read(state?.defaults) ?? ''),
          placeholder: extra?.placeholder ?? '',
          onChange: (event) => {
            const next = extra?.type === 'checkbox' ? event.target.checked : event.target.value;
            setState((current) => ({ ...current, defaults: fold(current?.defaults ?? {}, next) }));
          },
          onBlur: (event) => {
            if (extra?.type === 'checkbox') return;
            const next = event.target.value;
            if (next === (read(savedDefaults) ?? '')) return;
            setSavedDefaults((current) => fold(current ?? {}, next));
            saveSharedDefault(segments[0], fold(state?.defaults?.[segments[0]] ?? {}, next)[segments[0]]);
          },
          style: extra?.type === 'checkbox'
            ? { flex: '0 0 auto', font: 'inherit' }
            : { flex: '1 1 auto', minWidth: 0, font: 'inherit', padding: '3px 6px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, #8884)', background: 'transparent', color: 'inherit' },
        }),
        extra?.control ?? null);
      };

      /**
       * One control inside the shared `autoArchive` block.
       *
       * Each edit saves the WHOLE block, because the API patches `defaults[<key>]` rather than merging into it:
       * sending only the changed member would drop the others.
       */
      const archiveField = (key, label, kind, note) => {
        const block = () => state?.defaults?.autoArchive ?? {};
        const save = (patch) => {
          const next = { ...block(), ...patch };
          setSavedDefaults((current) => ({ ...current, autoArchive: next }));
          saveSharedDefault('autoArchive', next);
        };
        const control = kind === 'checkbox'
          ? h('input', {
            key: 'input',
            id: `fleet-archive-${key}`,
            type: 'checkbox',
            checked: block()[key] === true,
            disabled: busy,
            onChange: (event) => {
              setState((current) => ({ ...current, defaults: { ...current?.defaults, autoArchive: { ...block(), [key]: event.target.checked } } }));
              save({ [key]: event.target.checked });
            },
            style: { flex: '0 0 auto', font: 'inherit' },
          })
          : h('input', {
            key: 'input',
            id: `fleet-archive-${key}`,
            type: 'number',
            min: 0,
            value: String(block()[key] ?? 0),
            disabled: busy,
            onChange: (event) => setState((current) => ({ ...current, defaults: { ...current?.defaults, autoArchive: { ...block(), [key]: Number(event.target.value) } } })),
            onBlur: (event) => save({ [key]: Number(event.target.value) }),
            style: { flex: '0 0 90px', font: 'inherit', padding: '3px 6px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, #8884)', background: 'transparent', color: 'inherit' },
          });
        return h('div', {
          key: `archive-${key}`,
          style: { display: 'flex', alignItems: 'baseline', gap: '8px', flex: '1 1 320px', minWidth: 0 },
        },
        h('label', { key: 'label', htmlFor: `fleet-archive-${key}`, style: { flex: '0 0 auto', opacity: 0.8 } }, t(label)),
        control,
        note === undefined ? null : h('span', { key: 'note', style: { opacity: 0.7 } }, note));
      };

      /**
       * The shared defaults.
       *
       * These are the controller's own settings, not properties of any one machine: which ssh to run, which
       * key it authenticates with, and what the controlled side is asked to execute. Each is set once here and
       * inherited by every machine, and each can still be overridden per machine in the form below — but
       * without this block the only way to set one was to retype it for every machine.
       */
      /**
       * The session-prune card. LAB, and Windows only.
       *
       * It is here because the pile-up it addresses has no other cure: every delegation opens an ACP session
       * that no workspace accounts for, and nothing reachable from the controller can attach one after the
       * fact. Archiving is the only lever, and archiving needs the app on that machine stopped while its
       * registry file is edited — hence the blunt shape, and hence the warning rather than a silent action.
       */
      const archiveRules = state?.defaults?.autoArchive ?? {};
      const pruneCard = h('div', {
        key: 'prune',
        style: {
          border: '1px dashed var(--dsw-alias-border, #8886)',
          borderRadius: '8px',
          padding: '8px 10px',
          margin: '4px 0 8px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 12px',
          fontSize: '12px',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        },
      },
      h('div', { key: 'title', style: { flex: '1 1 100%', opacity: 0.9 } },
        h('strong', { key: 'what' }, t('pruneTitle')),
        h('span', { key: 'lab', style: { marginLeft: '6px', padding: '0 5px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border, #8886)', opacity: 0.8 } }, t('pruneLab')),
        h('span', { key: 'note', style: { opacity: 0.7 } }, ` — ${t('pruneNote')}`)),
      archiveField('enabled', 'pruneEnabled', 'checkbox'),
      archiveField('keepLast', 'pruneKeepLast', 'number'),
      h('div', { key: 'machines', style: { flex: '1 1 100%', display: 'flex', flexWrap: 'wrap', gap: '6px' } },
        ...(Array.isArray(state?.machines) ? state.machines : []).map((machine) => {
          const outcome = pruned?.[machine.id];
          return h('span', { key: machine.id, style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            button(`prune-${machine.id}`, `${t('pruneRun')} ${machine.toolName}`, () => void pruneNow(machine), { disabled: busy }),
            outcome === undefined ? null : h('span', {
              key: 'outcome',
              style: { opacity: 0.8, color: outcome.ok === true ? 'inherit' : 'var(--dsw-alias-text-danger, #c33)' },
            }, outcome.ok === true
              ? `${t('pruneDone')}${outcome.archivedAfter === undefined ? '' : ` · ${t('pruneArchived')} ${String(outcome.archivedAfter)}`}`
              : `${t('pruneFailed')}${outcome.problem === undefined ? '' : ` · ${String(outcome.problem)}`}`));
        })));

      const defaultsRow = h('div', {
        key: 'defaults',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 12px',
          margin: '4px 0 8px',
          padding: '8px 10px',
          border: '1px solid var(--dsw-alias-border, #8884)',
          borderRadius: '8px',
          fontSize: '12px',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        },
      },
      h('div', { key: 'title', style: { flex: '1 1 100%', opacity: 0.9 } },
        h('strong', { key: 'what' }, t('sharedTitle')),
        h('span', { key: 'note', style: { opacity: 0.7 } }, ` — ${t('sharedNote')}`)),
      // "Generate a new key" writes a NEW pair beside the old one and switches the default to it. It does not
      // delete the old key: machines already prepared with it still authenticate with its public half.
      sharedField('keyFile', 'defaultKeyFile', {
        placeholder: t('defaultKeyFileHint'),
        control: button('changekey', t('changeKey'), () => void generateNewKey(), { disabled: busy }),
      }),
      sharedField('sshCommand', 'sshCommand', { placeholder: 'ssh' }),
      sharedField('profile', 'profile', { placeholder: 'acp' }),
      keyNotice);

      /**
       * The setup dialog.
       *
       * It is reachable from the add/edit form (not only from a first-run wizard), because a machine
       * is re-prepared whenever it is replaced or reinstalled — the prompt must be obtainable at any
       * time, not once.
       */
      /**
       * Publish the prompt on the LAN and show the address to fetch it from.
       *
       * `host` doubles as the hint for which of this controller's addresses to serve on, and as the only
       * address the listener will answer: a controller with a VPN is reachable on more than one interface,
       * and only one of them is on the controlled machine's network.
       */
      /**
       * Pair a machine: serve the prompt AND open the channel it reports progress on.
       *
       * One call, because the prompt has to name the reporting address and token — publishing the prompt first
       * would mean either building it twice or handing out a prompt that names a channel which does not exist.
       *
       * `host` doubles as the hint for which of this controller's addresses to serve on, and as the only
       * address the listeners will answer: a controller with a VPN is reachable on more than one interface, and
       * only one of them is on the controlled machine's network.
       */
      const servePrompt = async () => {
        setBusy(true);
        setError(undefined);
        try {
          const published = await call('pair', {
            user: draft?.user ?? '',
            host: draft?.host ?? '',
            port: draft?.port ?? '',
            keyFile: state?.defaults?.keyFile ?? '',
            // The prompt channel exists to be read once, so it is opened for the shortest window that lets
            // somebody type the address, and it closes on the first fetch. The reporting channel is opened for
            // however long the work takes, which on a bare machine means installing an SSH server first.
            minutes: 30,
          });
          if (published?.shared !== true) {
            setError(`${t('setupServeFailed')}: ${String(published?.problem ?? '')}`);
            return;
          }
          setServed(published);
          setPairing({ token: published.token, state: 'running', stages: [] });
        } catch (failure) {
          setError(`${t('setupServeFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`);
        } finally {
          setBusy(false);
        }
      };

      /** Close the prompt listener immediately, without waiting for the countdown. */
      const stopServing = async () => {
        setBusy(true);
        try {
          await call('unshare', {});
          setServed(undefined);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      /**
       * The pairing's progress, refreshed once a second.
       *
       * Polled rather than pushed, because reports arrive at human pace: a stage takes seconds to minutes, so a
       * long-lived connection to make the update immediate would buy nothing and cost a streaming route.
       *
       * This poll is also where a finished pairing becomes a machine. The payload exists only in the final
       * report, so noticing it here is what consumes it — asking again later would mean holding it for a
       * request that may never come.
       *
       * Polling STOPS once the pairing is finished or gone: the server has forgotten it, and a poll against a
       * forgotten token answers `active: false`, which must not be mistaken for "still running".
       */
      React.useEffect(() => {
        const token = pairing?.token;
        if (token === undefined) return undefined;
        if (pairing.state === 'done' || pairing.state === 'failed' || pairing.state === 'expired') return undefined;
        let cancelled = false;
        const tick = async () => {
          try {
            const live = await call('pairing', { token });
            if (cancelled) return;
            if (live?.active === false) {
              // The server no longer knows this pairing: it was consumed, or it expired and was swept.
              setPairing((previous) => (previous === undefined ? previous : { ...previous, state: previous.state === 'running' ? 'expired' : previous.state }));
              return;
            }
            setPairing((previous) => ({ ...previous, ...live, token }));
            if (live?.added !== undefined) {
              // The machine is in the list now. Reload so the list, the tool names and the row count agree.
              reload();
              setPairing((previous) => (previous === undefined ? previous : { ...previous, state: 'done' }));
            }
          } catch (failure) {
            // A failed poll must not clear the panel; the next tick tries again.
            void failure;
          }
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, 1000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [pairing?.token, pairing?.state]);

      /** Add the machine using the address the operator picked, when more than one was reported. */
      const chooseAddress = async (host) => {
        const token = pairing?.token;
        if (token === undefined) return;
        setBusy(true);
        try {
          const live = await call('pairing', { token, host });
          setPairing((previous) => ({ ...previous, ...live, token, state: live?.added === undefined ? previous?.state : 'done' }));
          if (live?.added !== undefined) reload();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      /**
       * The seconds left on the live offer, refreshed once a second.
       *
       * Polled rather than counted locally: the panel may be reopened, and the number shown then has to
       * agree with the listener that is actually going to close. When the server reports the offer gone,
       * the block disappears instead of counting into negative numbers.
       */
      React.useEffect(() => {
        if (served === undefined) return undefined;
        let cancelled = false;
        const tick = async () => {
          try {
            const live = await call('shared', {});
            if (cancelled) return;
            if (live?.active !== true) setServed(undefined);
            else setRemaining(Math.ceil((live.remainingMs ?? 0) / 1000));
          } catch {
            // A failed poll must not clear the block; the next tick tries again.
          }
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, 1000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [served?.url]);

      /**
       * The stage checklist for a live pairing.
       *
       * All six stages are drawn from the moment the pairing opens, in the order the machine works through
       * them — that is what makes "not started yet" and "stuck here" different things on screen. A list built
       * only from reports received so far would look identical in both cases.
       *
       * A stage's `detail` is shown verbatim: the machine writes a sentence about what it actually did or
       * found, and that sentence is worth more than the state label beside it.
       */
      const pairingCard = pairing === undefined
        ? null
        : h('div', {
          key: 'pairing',
          style: { marginTop: '8px', padding: '8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, #8884)', fontSize: '12px' },
        },
        h('div', { key: 'head', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('strong', { key: 'title' }, t('pairProgress')),
          h('span', {
            key: 'state',
            style: {
              padding: '1px 6px',
              borderRadius: '4px',
              background: 'var(--dsw-alias-bg-secondary, #8882)',
              color: pairing.state === 'failed' ? 'var(--dsw-alias-text-danger, #c33)' : undefined,
            },
          }, pairing.state === 'done' ? t('pairStateDone')
            : pairing.state === 'failed' ? t('pairStateFailed')
              : pairing.state === 'expired' ? t('pairStateExpired')
                : t('pairStateRunning')),
          h('span', { key: 'reports', style: { opacity: 0.7 } }, `${t('pairReports')} ${String(pairing.reports ?? 0)}`),
          pairing.remainingMs === undefined ? null : h('span', {
            key: 'deadline',
            style: { opacity: 0.7, color: (pairing.remainingMs ?? 0) < 60_000 ? 'var(--dsw-alias-text-danger, #c33)' : undefined },
          }, `${t('pairDeadline')} ${String(Math.ceil((pairing.remainingMs ?? 0) / 1000))}s`)),
        // The stages the server sends are already the full fixed list; when the panel has only its own opening
        // state (before the first poll answers) it draws the request without any per-stage data rather than
        // drawing nothing, so the operator sees what is being waited on.
        h('div', { key: 'stages', style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '2px' } },
          (pairing.stages ?? []).map((entry) => h('div', { key: entry.stage, style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
            // `started` gets its own mark and its own colour. A stage that is RUNNING must not look like one
            // nothing has been heard from — that is the entire reason a machine reports a beginning separately.
            // Installing an SSH server on a bare machine is the long stage, and it is exactly the interval where
            // a still dot reads as a stuck one.
            h('span', { key: 'mark', style: { width: '1.2em', opacity: 0.9, color: entry.state === 'started' ? 'var(--dsw-alias-text-info, #38f)' : undefined } },
              entry.state === 'ok' ? '✓'
                : entry.state === 'skipped' ? '–'
                  : entry.state === 'fail' ? '✗'
                    : entry.state === 'started' ? '▸' : '·'),
            h('span', { key: 'name', style: { minWidth: '10em' } }, t(`pairStage${entry.stage.charAt(0).toUpperCase()}${entry.stage.slice(1)}`)),
            h('span', {
              key: 'state',
              style: {
                opacity: entry.state === 'waiting' ? 0.55 : 0.9,
                color: entry.state === 'fail' ? 'var(--dsw-alias-text-danger, #c33)'
                  : entry.state === 'started' ? 'var(--dsw-alias-text-info, #38f)' : undefined,
              },
            }, entry.state === 'ok' ? t('pairOk')
              : entry.state === 'skipped' ? t('pairSkipped')
                : entry.state === 'fail' ? t('pairFail')
                  : entry.state === 'started' ? t('pairStarted') : t('pairStageWaiting')),
            entry.detail === undefined ? null : h('span', { key: 'detail', style: { opacity: 0.8, flex: '1 1 100%', paddingLeft: '1.2em' } }, entry.detail),
            entry.error === undefined ? null : h('span', { key: 'error', style: { color: 'var(--dsw-alias-text-danger, #c33)', flex: '1 1 100%', paddingLeft: '1.2em' } }, entry.error)))),
        // More than one address: the machine could not tell which reaches this controller, and guessing
        // produces a machine that looks ready and only ever answers "cannot connect" — so the operator picks.
        pairing.needsChoice === true && pairing.state !== 'done'
          ? h('div', { key: 'choose', style: { marginTop: '8px' } },
            h('div', { key: 'what', style: { opacity: 0.9 } }, t('pairChoose')),
            h('div', { key: 'options', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
              (pairing.candidates ?? []).map((address) => button(
                `pick-${address}`,
                address,
                () => void chooseAddress(address),
                { disabled: busy },
              ))))
          : null,
        pairing.added === undefined
          ? null
          : h('div', { key: 'added', style: { marginTop: '8px' } },
            h('div', {
              key: 'what',
              style: { color: pairing.added.test?.ok === true ? undefined : 'var(--dsw-alias-text-danger, #c33)' },
            }, pairing.added.test?.ok === true ? t('pairAdded') : t('pairAddedUnverified')),
            h('div', { key: 'machine', style: { opacity: 0.85 } },
              `${String(pairing.added.machine?.label ?? '')}  ${String(pairing.added.machine?.user ?? '')}@${String(pairing.added.machine?.host ?? '')}:${String(pairing.added.machine?.port ?? 22)}`),
            pairing.added.test?.ok === true
              ? null
              : h('div', { key: 'reason', style: { opacity: 0.85 } }, `${String(pairing.added.test?.stage ?? '')} ${String(pairing.added.test?.message ?? '')}`)),
        pairing.errors === undefined
          ? null
          : h('div', { key: 'errors', style: { marginTop: '8px', color: 'var(--dsw-alias-text-danger, #c33)' } },
            String(t('pairNone')),
            h('ul', { key: 'list', style: { margin: '2px 0 0 18px' } }, pairing.errors.map((line) => h('li', { key: line }, line)))),
        pairing.state !== 'running'
          ? null
          : h('div', { key: 'waiting', style: { marginTop: '6px', opacity: 0.75 } }, t('pairWaiting')));

      const setupDialog = setup === undefined
        ? null
        : h('div', {
          key: 'setup',
          style: { border: '1px solid var(--dsw-alias-border, #8884)', borderRadius: '8px', padding: '10px', margin: '8px 0', background: 'var(--dsw-alias-bg-secondary, transparent)' },
        },
        h('div', { key: 'what', style: { fontSize: '12px', opacity: 0.9 } }, t('forkPromptLabel')),
        h('div', { key: 'returns', style: { fontSize: '12px', opacity: 0.85, margin: '4px 0' } },
          h('div', { key: 'head' }, t('forkPromptReturns')),
          h('ol', { key: 'list', style: { margin: '2px 0 2px 18px' } },
            h('li', { key: 'r1' }, t('forkPromptReturn1')),
            h('li', { key: 'r2' }, t('forkPromptReturn2')),
            h('li', { key: 'r3' }, t('forkPromptReturn3')))),
        h('p', { key: 'intro', style: { fontSize: '12px', opacity: 0.85, whiteSpace: 'pre-wrap' } }, t('setupIntro')),
        h('ol', { key: 'steps', style: { fontSize: '12px', opacity: 0.85, margin: '4px 0 8px 18px' } },
          h('li', { key: 's1' }, t('setupStep1')),
          h('li', { key: 's2' }, t('setupStep2')),
          h('li', { key: 's3' }, t('setupStep3'))),
        /**
         * The guide could not produce a prompt. Say WHICH thing is missing.
         *
         * `setup.problem` carries the Host's own explanation. Every remaining cause is about the key — no key to
         * offer, or a named one that is not there — so the no-key preamble fits, and the generate button is
         * offered only for the cause it can actually fix.
         *
         * There is no longer a "missing account" cause: an account is optional, because the prompt sends the
         * controlled machine to find it and report back. This card used to fire for that case too, telling the
         * operator their key was the problem while their key was fine.
         */
        setup.problem === undefined ? null : h('div', { key: 'problem', style: { marginTop: '8px', fontSize: '12px' } },
          h('div', { key: 'what', style: { color: 'var(--dsw-alias-text-danger, #c33)' } },
            setup.needs === 'key' ? `${t('setupNoKey')} ${String(setup.problem)}` : String(setup.problem)),
          setup.hint === undefined ? null : h('div', { key: 'hint', style: { opacity: 0.8 } }, String(setup.hint)),
          setup.needs !== 'key' ? null : h('div', { key: 'gen', style: { marginTop: '6px' } },
            button('generate', t('setupGenerate'), async () => {
              const value = await run('key', () => call('key', {}));
              if (value !== undefined) await openSetup();
            }, { disabled: busy }),
            h('div', { key: 'genhint', style: { opacity: 0.7, marginTop: '2px' } }, t('setupGenerateHint')))),
        setup.problem !== undefined ? null : h('div', { key: 'result', style: { marginTop: '8px' } },
          h('div', { key: 'meta', style: { fontSize: '12px', opacity: 0.85, display: 'flex', gap: '12px', flexWrap: 'wrap' } },
            h('span', { key: 'key' }, `${t('setupKey')}: ${String(setup.keyFile)}`),
            h('span', { key: 'fp' }, `${t('setupFingerprint')}: ${String(setup.fingerprint)}`)),
          // The prompt is deliberately NOT shown. It is several thousand characters of instructions for another
          // machine, and reading it here is not a step anybody has to perform — the two actions below are. Any
          // failure is reported by the panel itself, above this card, rather than inside the text.
          h('div', { key: 'promptready', style: { fontSize: '12px', opacity: 0.8, marginTop: '4px' } },
            `${t('setupPromptReady')} (${String((setup.prompt ?? '').length)} ${t('setupChars')})`),
          h('div', { key: 'copyrow', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' } },
            button('copy', t('setupCopy'), () => void copyPrompt(String(setup.prompt ?? ''), 'fleet-setup-prompt', 'setup'), { disabled: busy }),
            button('serve', t('setupServe'), () => void servePrompt(), { disabled: busy }),
            copyNoteFor('setup') === undefined ? null : h('span', { key: 'note', style: { fontSize: '12px', opacity: 0.85 } }, copyNoteFor('setup'))),
          // The address is short on purpose — it gets typed on the other machine — so the countdown is what
          // tells the operator how long it is worth typing. It reads the listener's own closing time rather
          // than counting down locally, so it cannot drift from the port it describes.
          served === undefined ? null : h('div', {
            key: 'served',
            style: { marginTop: '6px', padding: '6px 8px', borderRadius: '6px', border: '1px dashed var(--dsw-alias-border, #8886)', fontSize: '12px' },
          },
          h('div', { key: 'label', style: { opacity: 0.8 } }, t('setupServed')),
          h('code', { key: 'url', style: { display: 'block', margin: '4px 0', wordBreak: 'break-all', fontSize: '13px' } }, String(served.url ?? '')),
          h('div', { key: 'meta', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', opacity: 0.85 } },
            h('span', { key: 'countdown' }, `${t('setupServeCloses')} ${String(remaining)}s`),
            h('span', { key: 'once', style: { opacity: 0.8 } }, t('setupServeOnce')),
            served.reader === null || served.reader === undefined
              ? null
              : h('span', { key: 'reader', style: { opacity: 0.8 } }, `${t('setupServeFor')} ${String(served.reader)}`),
            button('stopserve', t('setupServeStop'), () => void stopServing(), { disabled: busy })))),
        // The live checklist. Below the address block on purpose: the address is what the operator reads out
        // first, and this is what they watch afterwards.
        pairingCard,
        h('div', { key: 'close', style: { marginTop: '8px' } },
          button('closesetup', t('setupClose'), () => { setSetup(undefined); setCopyNote(undefined); setServed(undefined); setPairing(undefined); })));

      // `minWidth: 0` and hidden horizontal overflow: this pane is one column of a settings page, and its
      // contents include store paths and machine names of unknown length. Without them the widest child
      // stretches the column and the whole page grows a horizontal scrollbar.
      return h('div', { style: { padding: '4px 2px', minWidth: 0, maxWidth: '100%', overflowX: 'hidden', boxSizing: 'border-box' } },
        h('div', { key: 'header', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap', minWidth: 0 } },
          h('strong', { key: 'title' }, t('machines')),
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          button('reload', t('reload'), reload, { disabled: busy }),
          button('add', t('add'), startAdd, { disabled: busy }),
        ),
        error !== undefined ? h('p', { key: 'error', style: { color: 'var(--dsw-alias-text-danger, #c33)', fontSize: '13px' } }, error) : null,
        environmentCard,
        defaultsRow,
        pruneCard,
        /**
         * Where a machine comes from, as two tabs.
         *
         * The tab is the CHOICE: `manual` types what the operator already knows, `prompt` has the machine
         * report it. The JSON view lives inside the manual tab, because it edits the same record the form
         * does — a peer tab for it split the wrong axis, putting two views of one path on equal footing with
         * the two paths themselves.
         *
         * Open by default while nothing is configured, because then the choice IS the task.
         */
        h('div', { key: 'addpanel', style: { border: '1px dashed var(--dsw-alias-border, #8886)', borderRadius: '8px', padding: '10px', margin: '6px 0' } },
          h('div', { key: 'tabs', style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
            h('strong', { key: 'title', style: { marginRight: '4px' } }, t('forkTitle')),
            button('tabmanual', t('forkManual'), startAdd, { disabled: busy, active: addTab === 'manual' }),
            button('tabprompt', t('forkPrompt'), startPrompt, { disabled: busy, active: addTab === 'prompt' }),
            addTab === undefined ? null : button('closeadd', t('setupClose'), closeAdd, { disabled: busy })),
          addTab === undefined
            ? h('div', { key: 'intro', style: { fontSize: '12px', opacity: 0.85, marginTop: '4px' } },
              h('div', { key: 'what' }, t('forkIntro')),
              h('div', { key: 'manual', style: { opacity: 0.8 } }, `${t('forkManual')} —— ${t('forkManualHint')}`),
              h('div', { key: 'prompt', style: { opacity: 0.8 } }, `${t('forkPrompt')} —— ${t('forkPromptHint')}`))
            : null,
          addTab === 'manual' ? editor : null,
          addTab === 'prompt' ? setupDialog : null),
        // The machines stay visible below whichever path is open, so the list is never pushed off screen.
        ...rows,
        Array.isArray(state?.warnings) && state.warnings.length > 0
          ? h('pre', { key: 'warnings', style: { whiteSpace: 'pre-wrap', fontSize: '12px', color: 'var(--dsw-alias-text-danger, #c33)' } }, state.warnings.join('\n'))
          : null,
        h('p', { key: 'note', style: { fontSize: '12px', opacity: 0.7, marginTop: '8px' } }, t('note')),
        // A store path is arbitrarily long and has no spaces to break at, so it is allowed to wrap mid-path
        // rather than stretch the pane.
        h('div', { key: 'footer', style: { marginTop: '10px', fontSize: '12px', opacity: 0.7, overflowWrap: 'anywhere' } }, `${t('storePath')}: ${state?.storePath ?? '…'}`),
      );
    }

    /**
     * Register the panel behind a failure fence.
     *
     * A throwing component blanks the whole settings section, so the panel is rendered through a
     * boundary: an unexpected failure shows a readable message and the fleet stays reachable through
     * the agent tools. The panel component itself is the class's only job here.
     */
    class FleetPanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failure: undefined };
      }

      static getDerivedStateFromError(failure) {
        return { failure };
      }

      componentDidCatch(failure) {
        console.error('[fleet] the settings panel failed to render:', failure);
      }

      render() {
        if (this.state.failure !== undefined) {
          const message = this.state.failure instanceof Error ? this.state.failure.message : String(this.state.failure);
          return h('div', { style: { padding: '8px 2px', fontSize: '13px' } },
            h('strong', { key: 'title' }, 'DuckFleet panel error ／ 鸭群面板出错'),
            h('p', { key: 'detail', style: { color: 'var(--dsw-alias-text-danger, #c33)', whiteSpace: 'pre-wrap' } }, message),
            h('p', { key: 'hint', style: { opacity: 0.7, fontSize: '12px' } },
              'Manage the fleet with the agent tools instead: fleet_list, fleet_add, fleet_test. ／ 请改用 agent 工具管理鸭群：fleet_list、fleet_add、fleet_test。'),
          );
        }
        return h(FleetPanel, this.props);
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Drop the previous application's wait for the settings slot, if one is still installed. Left in place,
        // it would fire again and register a second page under the same id.
        try {
          releaseInjection?.();
        } catch {
          // Nothing pending.
        }
        releaseInjection = undefined;

        /**
         * Register the dictionaries, replacing any registration this factory left behind.
         *
         * Without the dispose, a re-application throws "locale namespace \"fleet\" already has locale \"en\""
         * and takes the whole panel down. The catch covers the case where this factory instance is new but an
         * older one's registration is still live — there is no disposer to reach in that case, and the
         * dictionaries now on screen are the older ones.
         */
        ctx.effect(() => {
          try {
            releaseDictionaries?.();
          } catch {
            // Already gone; the registration it would have removed is not there to remove.
          }
          try {
            releaseDictionaries = ctx.locale.register(NS, DICTIONARIES);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/already has locale/.test(message)) throw error;
            // A previous factory instance owns the namespace. Keeping the panel working beats a reload with
            // no panel, and the next full reload starts from a clean module.
            ctx.logger?.warn?.(`fleet: ${message} — the dictionaries already registered for "${NS}" are kept`);
            releaseDictionaries = undefined;
          }
          return () => {
            releaseDictionaries?.();
            releaseDictionaries = undefined;
          };
        }, 'fleet: dictionaries');
        const bound = ctx.locale.bind(NS);
        const t = (key) => bound(key);

        /**
         * Register the settings page, replacing any contribution this factory left behind.
         *
         * The slot layer disposes a contribution through the caller's `ctx.effect`, so a registration whose
         * disposer is dropped survives until the fiber unloads. A re-application while the old fiber was still
         * live therefore collided:
         *
         *     list slot "settings.section" already has an entry with id "fleet" at priority 0 — register at a
         *     different priority to shadow it
         *
         * One detail made that hard to read: the composition reports the id's owner as `mf`, which is the
         * CORE's registrant name rather than a plugin's. The message is about this plugin's own earlier entry,
         * still holding the id.
         *
         * Disposing first is also correctness, not merely quiet: the newer bundle carries the newer panel,
         * which is the whole point of a reload.
         *
         * ONE registration path, deliberately. An outer `ctx.effect` doing the same work alongside this
         * `inject` would collide with itself, because `inject` runs its callback immediately when the slot is
         * already declared.
         */
        releaseInjection = ctx.slots.inject('settings.section', () => {
          ctx.effect(() => {
            try {
              releasePanel?.();
            } catch {
              // Already gone; there is nothing left to remove.
            }
            try {
              releasePanel = ctx.slots.register(
                { name: 'settings.section', id: 'fleet', order: 25, label: () => t('title') },
                (props) => h(FleetPanelBoundary, { ...props, t }),
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/already has an entry with id/.test(message)) throw error;
              // A previous factory instance owns the id and cannot be reached from here. A missing settings
              // page beats a plugin that fails to load, and the next full reload starts from a clean module.
              ctx.logger?.warn?.(`fleet: ${message} — the page already registered for "${NS}" is kept`);
              releasePanel = undefined;
            }
            return () => {
              releasePanel?.();
              releasePanel = undefined;
            };
          }, 'fleet: settings page');
        });
      },
    };
  },
});
