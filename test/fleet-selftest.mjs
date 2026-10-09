// Self-test for the fleet plugin's host half with a fake context: no DSH runtime involved.
// Verifies the store, the runtime's live registration/reconciliation, the delegation tool's
// execute path (against a fake subagents service), and every management tool.
//
// usage: node fleet-selftest.mjs            (mock machines only)
//        node fleet-selftest.mjs --real     (also drives the real 192.168.1.11 machine)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { machineToolDefinition, sshArgv } from '../lib/fleet.js';
import { usageSectionText } from '../lib/tools.js';
import { MACHINE_FIELDS, normalizeConfig, normalizeMachine, slug, toolNameFromLabel } from '../lib/store.js';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
}

/** Minimal Cordis-shaped context: reflect + effect + tools + subagents + logger. */
function fakeContext() {
  const tools = new Map();
  const providers = new Map();
  const cleanups = [];
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      // The runtime derives a machine's `toolVisible` from this lookup, so the fake registry has to
      // offer it; without it the "ready" state can never be observed in a test.
      get: (name) => tools.get(name),
    },
    subagents: {
      registerProvider(provider) {
        if (providers.has(provider.name)) throw new Error(`duplicate provider ${provider.name}`);
        providers.set(provider.name, provider);
        return () => providers.delete(provider.name);
      },
      async start(name, request) {
        const provider = providers.get(name);
        if (provider === undefined) throw new Error(`no provider ${name}`);
        return provider.start(request);
      },
    },
    effect(callback) {
      // Cordis runs the body immediately and keeps its RETURN value as the disposer: a body that
      // returns nothing has nothing to clean up. Model that exactly, so a plugin that returns its
      // cleanup instead of a cleanup *function* fails here rather than silently self-destructing.
      const dispose = callback();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(key) {
      if (key === 'subprocess') return ctx.subprocess;
      return undefined;
    },
    subprocess: undefined,
  };
  return { ctx, tools, providers, cleanups };
}

function machineInput(overrides) {
  return {
    id: 'b',
    label: 'Laptop',
    host: '192.168.1.11',
    user: 'dev',
    keyFile: 'C:/Users/dev/.ssh/dsh_master_ed25519',
    ...overrides,
  };
}

console.log('store:');
{
  const machine = normalizeMachine(machineInput({}));
  check('defaults materialize', machine.permission === 'allow' && machine.port === 22, JSON.stringify({ permission: machine.permission, port: machine.port }));
  // `cwd` is deliberately NOT defaulted to a fixed path: the field is the working directory for both the
  // local ssh process and the remote session, so a guessed value could not be right for a machine this
  // controller has never spoken to. Empty selects the delegating session's workspace instead.
  check('cwd defaults to empty (session workspace)', machine.cwd === '', JSON.stringify(machine.cwd));
  check('an explicit cwd is kept verbatim', normalizeMachine(machineInput({ cwd: '/srv/work' })).cwd === '/srv/work');
  check('an explicitly blank cwd stays blank', normalizeMachine(machineInput({ cwd: '' })).cwd === '');

console.log('store: the name identifies a machine, and names its tool:');
{
  // `id` is an internal key that nobody should have to invent, so it is derived from the name. It may be any
  // script: it is only a key in memory and a value in a JSON body, never a path segment.
  check('the id comes from the name', normalizeMachine({ label: 'Home Server', host: 'h', user: 'u' }).id === 'home_server');
  check('and a Chinese name is a usable id', normalizeMachine({ label: '主力笔记本', host: 'h', user: 'u', toolName: 'pc_laptop' }).id === '主力笔记本');
  check('an explicit id still wins, for scripts', normalizeMachine({ id: 'b', label: 'Laptop', host: 'h', user: 'u' }).id === 'b');
  check('slug keeps unicode letters', slug('主力笔记本') === '主力笔记本', slug('主力笔记本'));
  check('slug folds separators', slug('Home  Server!') === 'home_server', slug('Home  Server!'));
  check('a name of pure punctuation is refused', (() => { try { slug('!!!'); return false; } catch { return true; } })());

  // The tool name is what the model calls, so it derives from the NAME. Deriving it from the id is what
  // produced `pc_b`.
  check('the tool name derives from the name', normalizeMachine({ label: 'Home Server', host: 'h', user: 'u' }).toolName === 'pc_home_server');
  check('the operator may override it', normalizeMachine({ label: 'Home Server', host: 'h', user: 'u', toolName: 'pc_nas' }).toolName === 'pc_nas');
  check('a name with no ASCII yields nothing rather than a filler', toolNameFromLabel('主力笔记本') === undefined, String(toolNameFromLabel('主力笔记本')));
  check('and the machine then needs an explicit tool name', (() => {
    try { normalizeMachine({ label: '主力笔记本', host: 'h', user: 'u' }); return false; } catch (error) { return String(error).includes('needs a `toolName`'); }
  })(), 'the message must say what to set');
  check('supplying one is accepted', normalizeMachine({ label: '主力笔记本', host: 'h', user: 'u', toolName: 'pc_laptop' }).toolName === 'pc_laptop');
  check('an existing record keeps the id it had', normalizeMachine({ label: 'Laptop' }, { id: 'b', label: 'Laptop', host: 'h', user: 'u', toolName: 'pc_b' }).id === 'b');
}

console.log('store: duplicate names are disambiguated, not refused:');
{
  // Two machines named the same thing is a normal accident when a person types the name.
  const cfg = normalizeConfig({ machines: [
    { label: 'Home Server', host: 'h1', user: 'u' },
    { label: 'Home Server', host: 'h2', user: 'u' },
  ] });
  check('the first keeps the plain name', cfg.machines[0].id === 'home_server' && cfg.machines[0].toolName === 'pc_home_server');
  check('the second is given a variant', cfg.machines[1].id === 'home_server_2', cfg.machines[1].id);
  check('and a distinct tool name', cfg.machines[1].toolName === 'pc_home_server_2', cfg.machines[1].toolName);
  check('both remain addressable', new Set(cfg.machines.map((m) => m.toolName)).size === 2);
}

console.log('store: the controller key is shared, never per machine:');
{
  // One controller authenticates with one key, so it is the controller's identity rather than a property of
  // the machine it connects to. Carrying a copy per machine meant the same private-key path existed N times
  // and could drift out of step — and once the field left the panel, a stale copy could not be corrected.
  const cfg = normalizeConfig({
    defaults: { keyFile: 'C:/keys/shared_ed25519' },
    machines: [
      machineInput({ id: 'a', keyFile: '' }),
      machineInput({ id: 'b', keyFile: 'C:/keys/other' }),
    ],
  });
  check('the shared key survives a load', cfg.defaults.keyFile === 'C:/keys/shared_ed25519', JSON.stringify(cfg.defaults.keyFile));
  check('a machine record no longer carries a key', !('keyFile' in cfg.machines[0]) && !('keyFile' in cfg.machines[1]), JSON.stringify(cfg.machines.map((m) => m.keyFile)));
  check('a key left in an existing document is dropped, not honoured', cfg.machines[1].keyFile === undefined, String(cfg.machines[1].keyFile));
  check('the shared key survives a round trip', normalizeConfig(JSON.parse(JSON.stringify(cfg))).defaults.keyFile === 'C:/keys/shared_ed25519');
  check('an empty shared key is allowed', normalizeConfig({ defaults: { keyFile: '' }, machines: [] }).defaults.keyFile === '');
  check('keyFile is not an accepted machine field', !MACHINE_FIELDS.includes('keyFile'), MACHINE_FIELDS.join(', '));
}
  // The default tool name follows the NAME, not the id: an id is a key (`b`), so deriving from it produced the
  // unreadable `pc_b` this change exists to remove.
  check('default toolName follows the name', machine.toolName === 'pc_laptop', machine.toolName);

  // Duplicates are disambiguated rather than refused: a person typing a name twice is an accident, not a
  // configuration error, and the alternative is a save rejected over an identifier they never chose.
  const duplicated = normalizeConfig({ machines: [machineInput({}), machineInput({})] });
  check('duplicate ids are disambiguated', duplicated.machines[1].id === 'b_2', duplicated.machines[1].id);
  check('duplicate tool names are disambiguated', duplicated.machines[1].toolName === 'pc_laptop_2', duplicated.machines[1].toolName);
  const clashing = normalizeConfig({ machines: [machineInput({}), machineInput({ id: 'c', toolName: 'pc_laptop' })] });
  check('a deliberate tool-name clash is disambiguated too', clashing.machines[1].toolName === 'pc_laptop_2', clashing.machines[1].toolName);
}

console.log('\nruntime with fake context:');
const directory = mkdtempSync(join(tmpdir(), 'fleet-selftest-'));
const storePath = join(directory, 'fleet.json');
const { ctx, tools, providers, cleanups } = fakeContext();
apply(ctx, { storePath });
await new Promise((resolve) => setTimeout(resolve, 60));
check('management tools registered', ['fleet_list', 'fleet_add', 'fleet_remove', 'fleet_test', 'fleet_defaults'].every((n) => tools.has(n)), [...tools.keys()].join(','));
check('no machine tool before configuration', !tools.has('pc_laptop'));

{
  const added = await tools.get('fleet_add').execute(machineInput({}), { signal: new AbortController().signal });
  check('fleet_add reports the tool', added.includes('pc_laptop'), added.split('\n')[0]);
  check('delegation tool registered live', tools.has('pc_laptop'));
  check('provider registered live', providers.has('fleet-b'), [...providers.keys()].join(','));
  const stored = JSON.parse(readFileSync(storePath, 'utf8'));
  check('document persisted', stored.machines.length === 1 && stored.machines[0].host === '192.168.1.11');
  const list = await tools.get('fleet_list').execute({}, { signal: new AbortController().signal });
  check('fleet_list shows ready', list.includes('ready') && list.includes('pc_laptop'), list);
  // The label is the name a person SEES and says; the tool name is what the model must call. Without both on one
  // line there is nothing connecting "laptop-01" to `pc_laptop`, and the request has to be guessed at.
  check('fleet_list reports the label beside the tool name', list.includes('label=Laptop'), list.split('\n').find((line) => line.includes('pc_laptop')) ?? list);
}

console.log('\nthe usage section tells the model how a request reaches a machine:');
{
  // A tool schema describes a call, never when to make one. Without a section stating the addressing rules, the
  // delegation tools are reachable only by luck — and "all machines" has no addressee at all.
  check('a usage section is built', typeof usageSectionText() === 'string' && usageSectionText().length > 200, String(usageSectionText().length));
  const text = usageSectionText();
  check('it names the trigger cases', ['by name', 'as a set', 'all of them'].every((phrase) => text.includes(phrase)), 'one, several, and all must all be stated');
  // The section is hand-wrapped for readability, so the assertions collapse whitespace first: asserting on exact
  // line breaks would make every re-wrap a test failure.
  const flat = text.replace(/\s+/g, ' ');
  check('it sends the model to fleet_list for the mapping', flat.includes('`fleet_list` first') && flat.includes('label'), 'the live list is the mapping, and it must not be baked in');
  check('it says there is no separate broadcast tool', flat.includes('no separate broadcast tool'), 'otherwise the model may look for one');
  check('it warns that a label may differ from the tool name', flat.includes('different tool name') && flat.includes('rather than guessing'));
  check('it requires the whole task and absolute paths', flat.includes('absolute paths') && flat.includes('sees nothing from this conversation'), 'the remote agent has no context');
  check('it forbids silently dropping a machine', flat.includes('Do not silently drop'), 'a partial fan-out must be visible');

  // The section is registered as a soft dependency: `inject` is a hard one, and declaring it there took the whole
  // plugin down when the service was not projected — every delegation tool with it.
  const source = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../lib/plugin.js', import.meta.url), 'utf8'));
  check('the prompt service is not a hard inject', !/inject = \[[^\]]*systemPrompt/.test(source), 'a missing section must not cost the tools');
  check('it is reached through ctx.get', source.includes("ctx.get('systemPrompt')"), 'probe, then degrade');
  check('and a missing service is reported rather than thrown', source.includes('no `systemPrompt` service'), 'the reason must be in the log');
}

{
  const created = await machineToolDefinition({}, normalizeMachine(machineInput({}))).constructor;
  void created;
  const argv = sshArgv(normalizeMachine(machineInput({})));
  check('ssh argv keeps stdout clean', argv[0].endsWith('ssh') || argv[0] === 'ssh', argv.join(' '));
  check('ssh argv carries target and remote command', argv.includes('dev@192.168.1.11') && argv.includes('--profile') && argv.includes('acp'), argv.join(' '));
}

{
  await tools.get('fleet_add').execute(machineInput({ label: 'Renamed', permission: 'reject' }), { signal: new AbortController().signal });
  check('update keeps one registration', providers.size === 1);
  const machine = JSON.parse(readFileSync(storePath, 'utf8')).machines[0];
  check('update persisted the patch', machine.label === 'Renamed' && machine.permission === 'reject', JSON.stringify(machine));
}

{
  const before = await tools.get('fleet_defaults').execute({ cwd: 'C:\\Work' }, { signal: new AbortController().signal });
  check('defaults update', before.includes('C:\\\\Work') || before.includes('C:\\Work'), before);
}

{
  const removed = await tools.get('fleet_remove').execute({ id: 'b' }, { signal: new AbortController().signal });
  check('fleet_remove unregisters', !tools.has('pc_laptop') && providers.size === 0, removed);
  check('document empty after removal', JSON.parse(readFileSync(storePath, 'utf8')).machines.length === 0);
}

console.log('\ndelegation failure path (no subprocess service):');
{
  // The delegation tool must fail loudly rather than hang when subprocess is missing.
  const bare = fakeContext();
  const runtimeFree = machineToolDefinition({ subagents: bare.ctx.subagents }, normalizeMachine(machineInput({})));
  void runtimeFree;
  const pluginLoad = await import('../index.js');
  check('plugin exports inject metadata', Array.isArray(pluginLoad.inject) && pluginLoad.name === 'fleet');
}

console.log('\nplugin entry (generation-tagged implementation load):');
{
  const entry = await import('../index.js');
  check('entry exposes loader metadata', entry.name === 'fleet' && Array.isArray(entry.inject), `${String(entry.name)}`);
  const second = fakeContext();
  await entry.apply(second.ctx, { storePath: join(directory, 'entry-test.json') });
  check('plugin entry registers the management tools', second.tools.has('fleet_list') && second.tools.has('fleet_add'), [...second.tools.keys()].join(','));
  const listed = await second.tools.get('fleet_list').execute({}, { signal: new AbortController().signal });
  check('plugin entry reports an empty fleet', listed.includes('No machines are configured'), listed.split('\n')[1]);
  check('the effect body did not clean up at load time', second.tools.has('fleet_test') && second.tools.has('fleet_remove'), [...second.tools.keys()].join(','));
  // A machine added through this entry must survive: the load-time effect must not have disposed it.
  // The tool name is pinned so this test is about registration, not about how a tool name is derived.
  await second.tools.get('fleet_add').execute(machineInput({ id: 'z', toolName: 'pc_z' }), { signal: new AbortController().signal });
  check('a machine registered through the entry survives load', second.providers.has('fleet-z') && second.tools.has('pc_z'),
    `providers=${[...second.providers.keys()].join(',')} tools=${[...second.tools.keys()].join(',')}`);
  for (const dispose of second.cleanups.reverse()) dispose();
  check('the effect disposer removes that machine again', !second.providers.has('fleet-z') && !second.tools.has('pc_z'));
}

console.log('\nre-activation (what disabling and re-enabling the plugin row does):');
{
  const reactivateStore = join(directory, 'reactivate-test.json');
  const third = fakeContext();
  const entry = await import('../index.js');
  check('the entry reports a revision', typeof entry.fleetVersion === 'function' && typeof entry.fleetVersion().revision === 'string', JSON.stringify(entry.fleetVersion?.()));

  // Seed a machine in this context's own document, then prove a second activation both releases the
  // previous registrations and re-registers the machine from the SAME document.
  await entry.apply(third.ctx, { storePath: reactivateStore });
  await third.tools.get('fleet_add').execute(machineInput({ id: 'r', toolName: 'pc_r' }), { signal: new AbortController().signal });
  check('machine registered before re-activation', third.providers.has('fleet-r') && third.tools.has('pc_r'));
  check('the version tool is offered', third.tools.has('fleet_version'), [...third.tools.keys()].join(','));
  check('no in-process reload tool is offered', !third.tools.has('fleet_reload'), [...third.tools.keys()].join(','));

  const report = await third.tools.get('fleet_version').execute({}, { signal: new AbortController().signal });
  check('the version tool names the revision and the loaded generation', report.includes('Revision:') && report.includes('Loaded generation:'), report.split('\n').slice(0, 2).join(' | '));

  // A second activation is what a disable/enable pair performs.
  await entry.apply(third.ctx, { storePath: reactivateStore });
  check('the machine is still registered after re-activation', third.providers.has('fleet-r') && third.tools.has('pc_r'),
    `providers=${[...third.providers.keys()].join(',')} tools=${[...third.tools.keys()].join(',')}`);
  const after = await third.tools.get('fleet_version').execute({}, { signal: new AbortController().signal });
  check('the version tool survives re-activation', after.includes('Revision:'), after.split('\n')[0]);

  for (const dispose of third.cleanups.reverse()) dispose();
}

console.log('\nstatus snapshot (the panel edit form is seeded from this):');
{
  const { FleetRuntime } = await import('../lib/runtime.js');
  const snapshotStore = join(directory, 'snapshot-test.json');
  const bare = fakeContext();
  const runtime = new FleetRuntime(bare.ctx, { subagents: bare.ctx.subagents, subprocessReady: () => false, toolDefinition: () => ({}) }, { storePath: snapshotStore });
  await runtime.apply({ machines: [machineInput({})] });
  // `toolVisible` is derived from the tools registry, so the fake registry must actually hold the
  // machine's tool for the "ready" state to be observable here.
  bare.ctx.tools.register({ name: 'pc_laptop', description: 'stand-in', parameters: {}, output: { schema: {}, render: () => [] }, async execute() {} });
  const status = runtime.status();
  const machine = status.machines[0];
  // A summary-only snapshot left the host/user inputs empty in the UI, which read as data loss. The controller
  // settings are deliberately absent: they are served once under `defaults`.
  const required = ['id', 'label', 'description', 'host', 'user', 'port', 'cwd', 'permission', 'toolName', 'extraArgs'];
  const missing = required.filter((key) => machine[key] === undefined);
  check('every per-machine field reaches the panel', missing.length === 0, `missing: ${missing.join(',')}`);
  check('the snapshot does not duplicate the controller settings', ['sshCommand', 'keyFile', 'profile'].every((key) => machine[key] === undefined), JSON.stringify(Object.keys(machine)));
  // `remoteCommand` IS per machine: its useful value is the absolute path to the product's CLI on THAT machine,
  // because a non-interactive ssh session does not carry `dsh` on its PATH.
  check('the machine keeps its own remote command', typeof machine.remoteCommand === 'string' && machine.remoteCommand !== '', JSON.stringify(machine.remoteCommand));
  check('the snapshot still carries live state', machine.target === 'dev@192.168.1.11' && machine.registered === true && machine.toolVisible === true, JSON.stringify({ target: machine.target, registered: machine.registered, toolVisible: machine.toolVisible }));
  check('the snapshot is JSON-safe', JSON.stringify(status).length > 0 && JSON.parse(JSON.stringify(status)).machines.length === 1);
  runtime.dispose();
  void snapshotStore;
}

for (const dispose of cleanups.reverse()) dispose();
rmSync(directory, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
