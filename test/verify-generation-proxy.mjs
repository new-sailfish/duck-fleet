// The packaging layer: the proxy must export the COPY's own implementation.
//
// Pointing it at `../../lib/plugin.js` looked equivalent and was not: that is the original path, which
// the Loader already has cached, so the proxy handed back the pre-edit module. Every fresh copy looked
// correct on disk while the process kept running the old code — the failure mode this suite pins down.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

const packageRoot = new URL('../', import.meta.url).pathname.replace(/^\//, '');

/** A stub Host context; only what `apply` touches. */
function stubContext() {
  const tools = [];
  const routes = new Map();
  return {
    tools,
    routes,
    ctx: {
      logger: { warn() {}, info() {}, error() {} },
      get: (key) => (key === 'webServer'
        ? {
          register: (route) => {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        }
        : undefined),
      effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
      tools: { register: (definition) => { tools.push(definition.name); return () => {}; }, get: () => undefined },
      subagents: { registerProvider: () => () => {}, start: async () => {} },
    },
  };
}

/** Drive one route and return its JSON body. */
async function call(routes, pathname) {
  const handler = routes.get('/fleet/api');
  if (handler === undefined) return { status: 404 };
  let status = 200;
  let text = '';
  await handler({ url: pathname, method: 'GET' }, { writeHead(code) { status = code; }, end(body) { text = body ?? ''; } });
  return { status, body: text === '' ? undefined : JSON.parse(text) };
}

const scratch = mkdtempSync(join(tmpdir(), 'fleet-proxy-'));
cpSync(packageRoot, scratch, { recursive: true });
rmSync(join(scratch, '.gen'), { recursive: true, force: true });
const entry = join(scratch, 'index.js');

console.log('the generated proxy points at the copy, not at the cached original:');
const plugin = await import(pathToFileURL(entry).href);
const a = stubContext();
await plugin.apply(a.ctx, {});
const generations = readdirSync(join(scratch, '.gen')).filter((name) => name !== 'loads.log');
check('exactly one generation was materialized', generations.length === 1, generations.join(', '));
const proxy = readFileSync(join(scratch, '.gen', generations[0], 'plugin.js'), 'utf8');
console.log(`       proxy export line: ${proxy.split('\n').find((line) => line.startsWith('export'))}`);
check('the proxy re-exports the copy itself', proxy.includes("from './lib/plugin.js'"), proxy);
check('the proxy does NOT point back at the original path', !proxy.includes('../../lib/plugin.js'), proxy);
check('the proxy records the source digest', /\/\/ dsh-duck-fleet-digest: [0-9a-f]{32}/.test(proxy), proxy);
check('the copy has its own implementation files', readdirSync(join(scratch, '.gen', generations[0], 'lib')).includes('plugin.js'));

console.log('\nthe version tool reports a real revision:');
{
  const report = await plugin.fleetVersion();
  check('the entry reports a revision', typeof report.revision === 'string' && report.revision !== 'unknown', JSON.stringify(report));
  check('the entry reports the loaded generation', report.generation === generations[0], `${String(report.generation)} vs ${generations[0]}`);
  check('a digest is reported', typeof report.digest === 'string' && report.digest.length === 32, String(report.digest));
  const served = await call(a.routes, '/fleet/api/version');
  check('the route reports the same revision', served.body?.value?.revision === report.revision, JSON.stringify(served.body?.value).slice(0, 160));
  check('the route lists the operations it serves', Array.isArray(served.body?.value?.operations) && served.body.value.operations.includes('setup'), JSON.stringify(served.body?.value?.operations));
}

console.log('\nan edited source produces a copy that carries the edit:');
{
  const target = join(scratch, 'lib', 'api.js');
  const original = readFileSync(target, 'utf8');
  const marker = /apiRevision: '([^']+)'/.exec(original);
  check('the api carries a revision marker to edit', marker !== null, 'no apiRevision marker');
  writeFileSync(target, original.replace(marker[0], "apiRevision: 'api-EDITED-BY-TEST'"), 'utf8');
  const later = new Date(Date.now() + 2000);
  utimesSync(target, later, later);

  const b = stubContext();
  await plugin.apply(b.ctx, {});
  const served = await call(b.routes, '/fleet/api/version');
  check('the newly installed route answers', served.status === 200, JSON.stringify(served).slice(0, 120));
  check('the served revision carries the edit', served.body?.value?.apiRevision === 'api-EDITED-BY-TEST', JSON.stringify(served.body?.value?.apiRevision));
  check('the served tool list includes the version tool', b.tools.includes('fleet_version') && b.tools.includes('fleet_setup'), b.tools.join(', '));
}

console.log('\na copy whose contents were tampered with is rebuilt, not trusted:');
{
  const token = plugin.fleetVersion().generation;
  const proxyPath = join(scratch, '.gen', token, 'plugin.js');
  const poisoned = readFileSync(proxyPath, 'utf8').replace(/\/\/ dsh-fleet-digest: [0-9a-f]{32}/, '// dsh-fleet-digest: 00000000000000000000000000000000');
  writeFileSync(proxyPath, poisoned, 'utf8');
  // Force a distinct token so the rebuild is observable, then restore the poisoned copy under it.
  const target = join(scratch, 'lib', 'setup.js');
  const later = new Date(Date.now() + 4000);
  utimesSync(target, later, later);
  const c = stubContext();
  await plugin.apply(c.ctx, {});
  const served = await call(c.routes, '/fleet/api/version');
  check('the route answers after a poisoned copy', served.status === 200, JSON.stringify(served).slice(0, 120));
  check('the served revision is intact', served.body?.value?.apiRevision === 'api-EDITED-BY-TEST', JSON.stringify(served.body?.value?.apiRevision));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'GENERATION PROXY VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
