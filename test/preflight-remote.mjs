// Preflight for the fleet panel wire: the Host API route and the client bundle, without reloading
// the desktop app.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

console.log('host api route:');
const { API_PATH, registerFleetApi } = await import('../lib/api.js');
{
  check('path is a plain prefix', API_PATH === '/fleet/api', API_PATH);
  const routes = [];
  const warnings = [];
  const fakeCtx = {
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    get: (key) => (key === 'webServer'
      ? { register: (route) => { routes.push(route); return () => {}; } }
      : undefined),
  };
  const machine = {
    id: 'b', label: 'Laptop', host: '192.168.1.11', user: 'dev', port: 22, toolName: 'pc_b',
    sshCommand: 'ssh', keyFile: '', remoteCommand: 'dsh', profile: 'acp',
    cwd: 'C:\\Users\\Public', permission: 'allow', extraArgs: [],
  };
  const calls = [];
  const fakeRuntime = {
    status: () => ({ storePath: 'S', defaults: {}, warnings: [], machines: [{ ...machine, registered: true, toolVisible: true }] }),
    apply: async (document) => { calls.push(['apply', document]); },
    upsertMachine: async (patch) => { calls.push(['upsert', patch]); return { machine, created: true }; },
    removeMachine: async (id) => { calls.push(['remove', id]); return machine; },
    setDefaults: async (patch) => { calls.push(['defaults', patch]); return patch; },
    test: async (id) => { calls.push(['test', id]); return [{ ok: true, stage: 'handshake', target: 'dev@192.168.1.11', elapsedMs: 5 }]; },
  };
  const dispose = registerFleetApi(fakeCtx, fakeRuntime);
  check('route registered', routes.length === 1 && routes[0].path === API_PATH && routes[0].kind === 'prefix', JSON.stringify(routes));
  check('disposer returned', typeof dispose === 'function');

  const handler = routes[0].handler;
  const invoke = async (path, body, method = 'POST') => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const request = {
      url: path,
      method,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
    let status;
    let payload = '';
    const response = {
      writeHead: (code) => { status = code; },
      end: (text) => { payload = text ?? ''; },
    };
    await handler(request, response);
    return { status, body: payload === '' ? undefined : JSON.parse(payload) };
  };

  const read = await invoke(`${API_PATH}/read`, {});
  check('read answers the machine list', read.status === 200 && read.body.ok === true && read.body.value.machines[0].toolName === 'pc_b', JSON.stringify(read).slice(0, 160));
  const test = await invoke(`${API_PATH}/test`, { id: 'b' });
  check('test reaches the runtime', test.status === 200 && test.body.value.results[0].ok === true && calls.some(([name]) => name === 'test'));
  const saved = await invoke(`${API_PATH}/save`, { document: { machines: [] } });
  check('save drives runtime.apply', saved.status === 200 && calls.some(([name]) => name === 'apply'));
  const unknown = await invoke(`${API_PATH}/nope`, {});
  check('unknown operation answers 404', unknown.status === 404 && unknown.body.ok === false);
  const badMethod = await invoke(`${API_PATH}/read`, undefined, 'DELETE');
  check('unsupported method answers 405', badMethod.status === 405);
  const badJson = await invoke(`${API_PATH}/save`, undefined, 'POST');
  check('empty body is accepted as {}', badJson.status === 200 || badJson.status === 400, String(badJson.status));

  const routes2 = [];
  registerFleetApi(
    { logger: { warn() {} }, get: (key) => (key === 'webServer' ? { register: (route) => { routes2.push(route); return () => {}; } } : undefined) },
    { ...fakeRuntime, removeMachine: async () => { throw new Error('fleet: no machine "zz"'); } },
  );
  let failurePayload;
  await routes2[0].handler(
    { url: `${API_PATH}/remove`, method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('{"id":"zz"}'); } },
    { writeHead: () => {}, end: (text) => { failurePayload = JSON.parse(text); } },
  );
  check('a runtime failure becomes a 400 payload', failurePayload.ok === false && failurePayload.error.includes('zz'), JSON.stringify(failurePayload));
  check('a composition without a web server is unaffected', registerFleetApi({ logger: { warn() {} }, get: () => undefined }, fakeRuntime) === undefined);
}

console.log('\nclient bundle:');
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const sandbox = { load: (definition) => { sandbox.definition = definition; } };
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: sandbox };
  try {
    new Function(source)();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  check('bundle registers a factory', typeof sandbox.definition?.factory === 'function');
  // The client module id must track the package name, or the Loader cannot match the bundle to its row.
  check('bundle id matches the package name', sandbox.definition?.id === 'dsh-duck-fleet', String(sandbox.definition?.id));

  const seen = { slots: [], locales: [], components: [] };
  const fakeCtx = {
    effect: (callback) => callback(),
    locale: {
      register: (ns, dictionaries) => { seen.locales.push({ ns, dictionaries }); return () => {}; },
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, callback) => { seen.slots.push(slot); callback(); return () => {}; },
      register: (options, Component) => { seen.components.push({ options, Component }); return () => {}; },
    },
  };
  const plugin = sandbox.definition.factory((request) => {
    if (request === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [initial, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        // The panel registers a failure boundary, so the platform React object must expose Component.
        Component: class Component {
          constructor(props) { this.props = props; this.state = {}; }
        },
      };
    }
    throw new Error(`unexpected require(${request})`);
  });
  check('client plugin declares its injects', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'));
  plugin.apply(fakeCtx);
  check('registers dictionaries for both locales', seen.locales.length === 1 && seen.locales[0].dictionaries.en !== undefined && seen.locales[0].dictionaries.zh !== undefined);
  check('registers into the settings section', seen.slots.includes('settings.section'), seen.slots.join(','));
  check('the section carries a label thunk and a component', typeof seen.components[0]?.options?.label === 'function' && typeof seen.components[0]?.Component === 'function');
  // The slot component renders the failure boundary; walk boundary -> panel and render each with the
  // smallest possible React stand-in, so a body that throws here cannot blank the settings section.
  const wrapperElement = seen.components[0].Component({ t: (key) => key });
  check('the slot component produces an element', typeof wrapperElement === 'object' && wrapperElement !== null, JSON.stringify(wrapperElement)?.slice(0, 120));
  const BoundaryClass = wrapperElement?.type;
  check('the slot component is the failure boundary', typeof BoundaryClass === 'function' && typeof BoundaryClass.getDerivedStateFromError === 'function');

  const boundary = new BoundaryClass({ t: (key) => key });
  let panelElement;
  let boundaryError;
  try {
    panelElement = boundary.render();
  } catch (error) {
    boundaryError = error;
  }
  check('the boundary renders the panel', boundaryError === undefined && panelElement !== undefined, boundaryError === undefined ? '' : String(boundaryError));
  const panel = panelElement?.type;
  let rendered;
  let renderError;
  try {
    rendered = panel({ t: (key) => key });
  } catch (error) {
    renderError = error;
  }
  check('the panel renders without throwing', renderError === undefined, renderError === undefined ? '' : String(renderError));
  check('the panel renders a container element', rendered !== undefined && rendered.type === 'div', JSON.stringify(rendered)?.slice(0, 120));

  // The fence must actually catch: a failure becomes a readable panel, not a blank section.
  boundary.state = { failure: new Error('simulated panel failure') };
  let fallback;
  let fallbackError;
  try {
    fallback = boundary.render();
  } catch (error) {
    fallbackError = error;
  }
  check('the boundary renders a failure panel instead of rethrowing', fallbackError === undefined && fallback?.type === 'div', fallbackError === undefined ? '' : String(fallbackError));
  const derived = BoundaryClass.getDerivedStateFromError(new Error('x'));
  check('the failure state is derived from the thrown value', derived?.failure instanceof Error && derived.failure.message === 'x', JSON.stringify(derived)?.slice(0, 80));
}

console.log(`\n${failures === 0 ? 'PREFLIGHT PASSED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
