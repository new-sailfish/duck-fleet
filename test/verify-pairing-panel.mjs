// What the pairing card shows in each of its three states.
//
// Reported from use: the card STACKED instead of switching. Once the LAN link was open it still offered "copy the
// prompt" and still explained what that prompt would produce, so it instructed the operator to do the thing the
// address had just replaced — and after the machine reported, the checklist was appended underneath all of it.
//
// Rendered from the real bundle with the state injected. Injecting is necessary because the panel's own effects
// do not run here: the harness has no mount, so nothing but the FIRST render can be observed, and the states
// under test are reached only after events. The hook cells are addressed by index, which is why the order of the
// panel's `useState` calls matters — the index is asserted below rather than assumed.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** Load the bundle's factory by stubbing the one global it talks to. */
function loadFactory() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let captured;
  const window = {
    __ModuleLoader__: { load(entry) { captured = entry; } },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  };
  new Function('window', 'setTimeout', 'clearTimeout', 'fetch', source)(window, setTimeout, clearTimeout, fetch);
  if (captured === undefined) throw new Error('the bundle did not call __ModuleLoader__.load');
  return captured;
}

/**
 * React with hook cells that can be PRESET.
 *
 * `preset` is a map from hook index to the value that cell should start with, which is how a state only
 * reachable through interaction is put on screen.
 */
function makeReact(preset) {
  let cells = [];
  let cursor = 0;
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    React: {
      createElement,
      Component: class Component { constructor(props) { this.props = props; } setState() {} },
      useState(initial) {
        const index = cursor;
        cursor += 1;
        if (cells.length <= index) {
          cells[index] = Object.hasOwn(preset, index) ? preset[index] : (typeof initial === 'function' ? initial() : initial);
        }
        return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
      },
      useCallback: (fn) => fn,
      useEffect: () => {},
      useLayoutEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useContext: () => ({}),
      createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
      Fragment: 'Fragment',
      memo: (component) => component,
      forwardRef: (fn) => fn,
      Children: { toArray: (value) => (Array.isArray(value) ? value : [value]) },
      StrictMode: 'StrictMode',
    },
    begin() { cursor = 0; },
    reset() { cells = []; cursor = 0; },
  };
}

/** A minimal slot service whose `register` keeps the component so it can be rendered. */
function makeSlots() {
  const entries = new Map();
  return {
    entries,
    register(options, component) {
      entries.set(options.id ?? options.key, { options, component });
      return () => { entries.delete(options.id ?? options.key); };
    },
    inject(key, callback) { callback(); return () => {}; },
  };
}

function makeLocale() {
  const held = new Map();
  return {
    held,
    register(namespace, dicts) {
      for (const [locale, dict] of Object.entries(dicts)) held.set(`${namespace}:${locale}`, dict);
      return () => {};
    },
    bind: (namespace) => (key) => held.get(`${namespace}:zh`)?.[key] ?? held.get(`${namespace}:en`)?.[key] ?? key,
  };
}

/** Resolve function components so the tree contains real host elements. */
function expand(node, depth) {
  if (depth > 14) throw new Error('the component tree did not settle within 14 levels');
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1));
  if (typeof node !== 'object' || !('type' in node)) return node;
  if (typeof node.type === 'function') {
    const produced = node.type.prototype?.render !== undefined
      ? new node.type(node.props ?? {}).render()
      : node.type(node.props ?? {});
    return expand(produced, depth + 1);
  }
  return { ...node, children: (node.children ?? []).map((child) => expand(child, depth + 1)) };
}

/** Collect every string in a resolved tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
  if (typeof node === 'object' && 'type' in node) for (const child of node.children ?? []) texts(child, out);
  return out;
}

globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false }) });

/**
 * Hook index of `addTab`, `setup`, `served` and `pairing`, DERIVED from the bundle rather than hard-coded.
 *
 * The index is the position of the call in the panel's declaration order, so inserting a `useState` above one of
 * these silently shifts every preset onto the wrong cell — which is exactly what the first version of this suite
 * did, and it reported eighteen failures against code that renders correctly. Deriving it means the suite breaks
 * loudly when the order changes instead of quietly testing something else.
 */
function hookIndex(name) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/const \[(\w+), set\w+\] = React\.useState/g)].map((match) => match[1]);
  const index = calls.indexOf(name);
  if (index === -1) throw new Error(`the panel no longer declares a "${name}" state`);
  return index;
}

const HOOK = {
  addTab: hookIndex('addTab'),
  setup: hookIndex('setup'),
  served: hookIndex('served'),
  pairing: hookIndex('pairing'),
};

const status = {
  storePath: 'C:\\Users\\x\\.dsh\\fleet.json',
  defaults: { keyFile: 'C:\\Users\\x\\.ssh\\k', sshCommand: 'ssh', profile: 'acp', autoArchive: { enabled: false, keepLast: 5, maxAgeHours: 0 } },
  warnings: [],
  machines: [{ id: 'b', toolName: 'huawei-vm', label: 'huawei-vm', target: 'huawei@DESKTOP-SERVERS', port: 22, cwd: 'C:\\x', permission: 'allow', description: '', extraArgs: [], provider: 'fleet-b', registered: true, toolVisible: true }],
};

/** The guide a real pairing opened, with whatever progress the case needs. */
const setup = {
  keyFile: 'C:\\Users\\x\\.ssh\\k',
  fingerprint: 'SHA256:abc',
  prompt: 'x'.repeat(7512),
};

const opened = { url: 'http://192.168.3.158:50662/scfo', reader: '192.168.3.171' };

/** Render the panel once, with the given hook cells preset. */
function render(preset) {
  const react = makeReact({ 0: status, ...preset });
  const entry = loadFactory();
  const plugin = entry.factory(() => react.React);
  const slots = makeSlots();
  plugin.apply({
    locale: makeLocale(),
    slots,
    logger: { warn: () => {} },
    effect(run) { run(); },
  });
  react.begin();
  const component = slots.entries.get('fleet').component;
  return texts(expand(react.React.createElement(component, {}), 0)).join('\n');
}

console.log('\nbefore anything is sent: both routes are offered, nothing else:');
{
  const text = render({ [HOOK.addTab]: 'prompt', [HOOK.setup]: setup });
  check('the prompt route is explained', text.includes('它最后会输出三样'));
  check('the three outputs are listed', text.includes('每一个表单要填的值') && text.includes('fleet_add 指令'));
  check('the copy-the-prompt button is offered', text.includes('复制提示词'));
  check('the LAN route is offered as the alternative', text.includes('改用局域网链接'));
  check('no address is shown yet', !text.includes('192.168.3.158:50662'));
  check('no checklist yet', !text.includes('尚未回报'));
}

console.log('\nwhile the address is open: the URL replaces the prompt, and nothing is still asking to be copied:');
{
  const text = render({ [HOOK.addTab]: 'prompt', [HOOK.setup]: setup, [HOOK.served]: opened });
  check('the address is shown', text.includes('http://192.168.3.158:50662/scfo'));
  check('with a button to copy it', text.includes('复制链接'));
  check('it says the machine fetches it', text.includes('在被控机上访问这个地址获取'));
  check('it says it is waiting', text.includes('等它来取'));
  // The reported problem: these stayed on screen after the address replaced them.
  check('the prompt is no longer offered for copying', !text.includes('复制提示词'));
  check('the LAN button is gone, having been used', !text.includes('改用局域网链接'));
  check('the three-outputs explanation is gone', !text.includes('它最后会输出三样'));
  check('no checklist yet — the machine has not spoken', !text.includes('尚未回报'));
}

console.log('\nafter the machine reports: the checklist is the card:');
{
  const pairing = {
    token: 't',
    state: 'running',
    reports: 1,
    remainingMs: 1_744_000,
    stages: [
      { stage: 'sshd', state: 'started', detail: '本机没有 SSH 服务端（无 sshd 服务、22 端口无监听），开始查安装条件' },
      { stage: 'firewall', state: 'waiting' },
      { stage: 'profile', state: 'waiting' },
      { stage: 'key', state: 'waiting' },
      { stage: 'verify', state: 'waiting' },
      { stage: 'done', state: 'waiting' },
    ],
  };
  const text = render({ [HOOK.addTab]: 'prompt', [HOOK.setup]: setup, [HOOK.served]: opened, [HOOK.pairing]: pairing });
  check('all six stages are listed', ['SSH 服务与登录账号', '防火墙', 'acp profile', '公钥', '验证能否启动', '回报配置'].every((name) => text.includes(name)));
  check('the running stage says so', text.includes('进行中'));
  check('its detail is shown verbatim', text.includes('开始查安装条件'));
  check('the untouched stages are marked as unheard-from', text.includes('尚未回报'));
  check('the address is gone — it has done its job', !text.includes('http://192.168.3.158:50662/scfo'));
  check('the copy-link button is gone', !text.includes('复制链接'));
  check('the stop-the-listener button is gone', !text.includes('立即关闭'));
  check('the key fingerprint is gone, having been checked', !text.includes('SHA256:abc'));
}

console.log('\na finished pairing keeps the checklist and reports what happened:');
{
  const pairing = {
    token: 't',
    state: 'done',
    reports: 7,
    remainingMs: 0,
    added: { machine: { label: 'LAPTOP-1', host: '192.168.3.171', user: '1', port: 22 }, test: { ok: true } },
    stages: [
      { stage: 'sshd', state: 'ok', detail: '已安装' },
      { stage: 'firewall', state: 'skipped', detail: '已有规则覆盖 22' },
      { stage: 'profile', state: 'ok' },
      { stage: 'key', state: 'ok' },
      { stage: 'verify', state: 'ok' },
      { stage: 'done', state: 'ok' },
    ],
  };
  const text = render({ [HOOK.addTab]: 'prompt', [HOOK.setup]: setup, [HOOK.pairing]: pairing });
  check('the finished state is named', text.includes('已完成'));
  check('a skipped stage is distinguished from a done one', text.includes('本来就满足') && text.includes('完成'));
  check('the machine that was added is named', text.includes('LAPTOP-1') && text.includes('1@192.168.3.171:22'));
  check('and it says the check passed', text.includes('已添加进列表并验证通过'));
}

console.log('\n"added" and "answers right now" are two different things:');
{
  /**
   * Reported from use: after a successful addition the card showed a red "added, but the check did not pass",
   * because the machine had not been rebooted yet. Merging the two facts reads as "this did not work", when in
   * fact the record was saved and only the machine's current availability is unknown.
   */
  const base = {
    token: 't',
    state: 'incomplete',
    reports: 6,
    remainingMs: 0,
    next: '重启后执行：Start-Service sshd',
    added: {
      machine: { label: 'cursor', toolName: 'pc_cursor', host: '192.168.3.172', user: 'cursorbot', port: 22, cwd: 'C:/Users/cursorbot/.dsh-fleet-workspace' },
      test: { ok: false, stage: 'handshake', message: 'stage=handshake Subagent failure' },
    },
    stages: [{ stage: 'sshd', state: 'pending', detail: '能力停在 InstallPending' }, { stage: 'verify', state: 'ok' }],
  };
  const text = render({ [HOOK.addTab]: 'prompt', [HOOK.setup]: setup, [HOOK.pairing]: base });

  check('the addition is stated as done', text.includes('已添加进列表'));
  check('the machine is named', text.includes('cursorbot@192.168.3.172:22'));
  // Without the tool name the operator cannot address the machine at all.
  check('the tool name is given', text.includes('pc_cursor'));
  check('the outstanding step is still shown', text.includes('等重启') && text.includes('重启后执行'));
  // The unreachable case is a WARNING with an explanation, not an error that contradicts the line above it.
  check('the failed check is framed as "not yet", not as a failure', text.includes('它现在还不应答'));
  check('and it says the record is saved anyway', text.includes('记录已经存下了'));
  check('the old contradictory wording is gone', !text.includes('已添加，但验证没过'));

  const healthy = render({
    [HOOK.addTab]: 'prompt',
    [HOOK.setup]: setup,
    [HOOK.pairing]: { ...base, state: 'done', added: { ...base.added, test: { ok: true } } },
  });
  check('a reachable machine says so', healthy.includes('它应答了握手'));
  check('and does not warn about being unreachable', !healthy.includes('它现在还不应答'));
}

console.log('\nmore than one address asks instead of guessing:');
{
  const pairing = {
    token: 't',
    state: 'done',
    reports: 7,
    remainingMs: 0,
    needsChoice: true,
    candidates: ['192.168.3.171', '192.168.0.2'],
    stages: [{ stage: 'done', state: 'ok' }],
  };
  const text = render({ [HOOK.addTab]: 'prompt', [HOOK.setup]: setup, [HOOK.pairing]: pairing });
  check('it explains the machine could not tell', text.includes('那台机器报了不止一个地址'));
  check('both addresses are offered', text.includes('192.168.3.171') && text.includes('192.168.0.2'));
  check('nothing was added without a choice', !text.includes('已添加进列表'));
}

console.log('\na failure is explained, not just announced:');
{
  // Reported from a real run: six stages all `ok`, and the card said "failed" with no reason. The cause is that
  // the final report arrived without a `payload`, so there was nothing to add — which reads as a contradiction
  // from outside, because every visible step succeeded. The operator has to be told the work is not lost.
  const pairing = {
    token: 't',
    state: 'failed',
    reports: 11,
    remainingMs: 0,
    error: 'the final report carried no payload ／ 最终汇报里没有携带配置内容',
    stages: [
      { stage: 'sshd', state: 'ok', detail: '已在账号 cursorbot 下部便携版 OpenSSH 9.8p1，监听 0.0.0.0:22' },
      { stage: 'firewall', state: 'ok' },
      { stage: 'profile', state: 'ok' },
      { stage: 'key', state: 'ok' },
      { stage: 'verify', state: 'ok' },
      { stage: 'done', state: 'ok' },
    ],
  };
  const text = render({ [HOOK.addTab]: 'prompt', [HOOK.setup]: setup, [HOOK.pairing]: pairing });
  check('the failure is named', text.includes('失败'));
  check('the reason is given', text.includes('没有携带配置内容'), 'a bare "failed" beside six ticks is unreadable');
  check('the reason is labelled', text.includes('失败原因'));
  check('it says the steps really happened', text.includes('实际做过的事'));
  check('it says the machine is already configured', text.includes('已经配好了'));
  check('and it offers the way forward', text.includes('重新发起一次配对') && text.includes('手动添加'));
  // The checklist is the evidence that the work happened, so the error must not replace it.
  check('the successful stages are still listed', text.includes('SSH 服务与登录账号') && text.includes('公钥'));
  check('and their detail survives', text.includes('便携版 OpenSSH'));
}

console.log(`\n${failures === 0 ? 'PAIRING PANEL VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
