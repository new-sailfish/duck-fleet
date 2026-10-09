// Prove the panel data path end to end with the REAL api.js handler and the REAL runtime:
// apply -> the route serves every stored field -> edit -> reload -> the route serves the NEW code
// (this is where a stale route closure previously survived a reload).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

const directory = mkdtempSync(join(tmpdir(), 'fleet-panel-'));
const storePath = join(directory, 'fleet.json');

/** A fake Host context with the services the plugin needs, including a real route table. */
function fakeContext() {
  const tools = new Map();
  const providers = new Map();
  const cleanups = [];
  const routes = new Map();
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(key) {
      if (key === 'subprocess') return undefined;
      if (key === 'webServer') {
        return {
          register(route) {
            if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        };
      }
      return undefined;
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      get: (name) => tools.get(name),
    },
    subagents: {
      registerProvider(provider) {
        if (providers.has(provider.name)) throw new Error(`duplicate provider ${provider.name}`);
        providers.set(provider.name, provider);
        return () => providers.delete(provider.name);
      },
      async start() { throw new Error('not used'); },
    },
  };
  return { ctx, tools, providers, routes, cleanups };
}

/** Drive the registered route the way the browser does. */
async function call(routes, operation, body) {
  const route = routes.get('/fleet/api');
  if (route === undefined) return { status: 404, body: { ok: false, error: 'no route registered' } };
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  let status;
  let text = '';
  await route.handler(
    { url: `/fleet/api/${operation}`, method: 'POST', async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; } },
    { writeHead: (code) => { status = code; }, end: (value) => { text = value ?? ''; } },
  );
  return { status, body: text === '' ? undefined : JSON.parse(text) };
}

const entry = await import('../index.js');
const world = fakeContext();
await entry.apply(world.ctx, { storePath });

console.log('first generation — panel read:');
{
  // `keyFile` is passed here on purpose even though it is no longer a machine field: an existing document
  // may still carry one, and the route must not serve it as if it were editable per machine.
  await call(world.routes, 'upsert', { machine: { id: 'b', label: 'Laptop', host: '192.168.1.10', user: 'dev', keyFile: 'C:/k' } });
  const read = await call(world.routes, 'read');
  check('the route answers', read.status === 200 && read.body.ok === true, JSON.stringify(read).slice(0, 160));
  const machine = read.body.value.machines[0];
  const required = ['id', 'label', 'description', 'host', 'user', 'port', 'cwd', 'permission', 'toolName', 'remoteCommand', 'extraArgs'];
  const missing = required.filter((key) => machine[key] === undefined);
  check('the route serves every per-machine field (the edit form needs them)', missing.length === 0, `missing: ${missing.join(',')}`);
  // These belong to the controller, so they are served once under `defaults` and read from there — a per-machine
  // copy would silently win over the shared value. `remoteCommand` is NOT among them: it names the agent on the
  // controlled machine, and its useful value is a path under that machine's user profile.
  check('controller settings are not served as machine fields',
    ['sshCommand', 'keyFile', 'profile'].every((key) => machine[key] === undefined),
    JSON.stringify(Object.keys(machine)));
  check('they are served as shared settings instead',
    ['sshCommand', 'keyFile', 'profile'].every((key) => typeof read.body.value.defaults[key] === 'string'),
    JSON.stringify(read.body.value.defaults));
  check('the served host is the configured one', machine.host === '192.168.1.10' && machine.user === 'dev', `${String(machine.host)} / ${String(machine.user)}`);
  check('live state rides along', machine.target === 'dev@192.168.1.10' && machine.registered === true, JSON.stringify({ target: machine.target, registered: machine.registered }));
}

console.log('\nthe shared settings are settable once and inherited:');
{
  // These are the controller's own settings — which ssh, which key, what the controlled side runs — so setting
  // one must not require retyping it for every machine. Before this, only the key had a field in the panel.
  const shared = {
    sshCommand: 'ssh', keyFile: 'C:/keys/shared', remoteCommand: 'dsh',
    profile: 'acp', cwd: 'C:/Users/Public', permission: 'reject',
  };
  for (const [key, value] of Object.entries(shared)) {
    const answer = await call(world.routes, 'setDefaults', { patch: { [key]: value } });
    check(`setDefaults accepts ${key}`, answer.status === 200 && answer.body.ok === true, JSON.stringify(answer).slice(0, 160));
  }
  const read = await call(world.routes, 'read');
  const stored = read.body.value.defaults;
  check('every shared setting is served back for the panel', Object.keys(shared).every((key) => stored[key] === shared[key]), JSON.stringify(stored));
  check('and none of them leaked into a machine record', shared.keyFile !== undefined && read.body.value.machines[0].keyFile === undefined, JSON.stringify(read.body.value.machines[0]));

  // A machine created without naming any of these inherits the per-machine defaults.
  await call(world.routes, 'upsert', { machine: { label: 'Inherit Test', host: '192.168.1.30', user: 'u' } });
  const after = await call(world.routes, 'read');
  const fresh = after.body.value.machines.find((entry) => entry.label === 'Inherit Test');
  check('a new machine inherits the shared per-machine defaults', fresh !== undefined
    && fresh.cwd === shared.cwd
    && fresh.permission === shared.permission, JSON.stringify(fresh));
  check('and carries none of the controller settings', fresh.sshCommand === undefined && fresh.profile === undefined, JSON.stringify(fresh));
  await call(world.routes, 'remove', { id: fresh.id });
}

console.log('\nafter a re-activation — the route must serve the NEW registration:');
{
  // A disable/enable pair performs exactly this: `apply` runs again on the same module instance.
  await entry.apply(world.ctx, { storePath });
  const read = await call(world.routes, 'read');
  check('the route still answers after re-activation', read.status === 200 && read.body.ok === true, JSON.stringify(read).slice(0, 200));
  const machine = read.body.value?.machines?.[0] ?? {};
  check('the served record survived the re-activation', machine.id === 'b' && machine.host === '192.168.1.10', JSON.stringify(machine).slice(0, 200));
  check('the route was re-registered, not duplicated', world.routes.size === 1, `routes=${String(world.routes.size)}`);
  for (const operation of ['read', 'version']) {
    const answer = await call(world.routes, operation, {});
    check(`${operation} answers after re-activation`, answer.status === 200, JSON.stringify(answer).slice(0, 160));
  }
  const version = await call(world.routes, 'version', {});
  check('the route reports a revision', typeof version.body?.value?.revision === 'string', JSON.stringify(version.body?.value).slice(0, 160));
  check('the route lists its own operations', Array.isArray(version.body?.value?.operations) && version.body.value.operations.includes('setup'), JSON.stringify(version.body?.value?.operations));
}

console.log('\nrepeated re-activations (nothing may accumulate):');
{
  await entry.apply(world.ctx, { storePath });
  await entry.apply(world.ctx, { storePath });
  const read = await call(world.routes, 'read');
  check('the route answers after repeated re-activations', read.status === 200 && read.body.ok === true, JSON.stringify(read).slice(0, 160));
  check('exactly one route exists', world.routes.size === 1, String(world.routes.size));
  check('exactly one provider is registered', world.providers.size === 1, [...world.providers.keys()].join(','));
  check('the delegation tool is present once', world.tools.has('pc_laptop') && [...world.tools.keys()].filter((name) => name === 'pc_laptop').length === 1, [...world.tools.keys()].join(','));
}

console.log('\nthe stored document is intact:');
{
  const stored = JSON.parse(readFileSync(storePath, 'utf8'));
  check('the document kept host and user', stored.machines[0].host === '192.168.1.10' && stored.machines[0].user === 'dev', JSON.stringify(stored.machines[0]).slice(0, 200));
}

for (const dispose of world.cleanups.reverse()) dispose();
rmSync(directory, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'PANEL DATA PATH VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
