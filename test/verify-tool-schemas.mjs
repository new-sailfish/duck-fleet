// Check every tool definition this plugin registers against the Host's OWN registry rules:
// the registry asserts the OUTPUT schema against its supported JSON Schema subset (`register()` in
// @deepseek-ai/dsh-tools) and requires a `render` function. Parameters are plain JSON Schema the
// registry does not assert, so they are checked for the shape the model-facing projection needs.
import { importFromHarness } from './harness.mjs';
import { machineToolDefinition } from '../lib/fleet.js';
import { normalizeMachine } from '../lib/store.js';
import { managementToolDefinitions } from '../lib/tools.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

// The registry asserts the OUTPUT schema against its supported JSON Schema subset, so the real registry is what
// this suite measures — reached from the running harness rather than a hard-coded install path.
const { assertSupportedJsonSchema } = await importFromHarness('@deepseek-ai/dsh-tools');

const machine = normalizeMachine({
  id: 'b', host: '192.168.1.11', user: 'dev',
  keyFile: 'C:/Users/dev/.ssh/dsh_master_ed25519',
  sshCommand: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
});

const runtime = {
  ctx: {},
  status: () => ({ storePath: 'S', defaults: {}, warnings: [], machines: [] }),
  config: async () => ({ defaults: {}, machines: [] }),
  storePath: () => 'S',
  stateOf: () => 'ready',
  apply: async () => {},
  upsertMachine: async () => ({ machine, created: true }),
  removeMachine: async () => machine,
  setDefaults: async () => ({}),
  test: async () => [],
};

const definitions = [
  ...managementToolDefinitions(runtime, { onReload: async () => 'reloaded' }),
  machineToolDefinition({ subagents: {} }, machine),
];

const ALLOWED = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Walk a schema node and report any `type` outside the registry's subset. */
function badTypes(node, path = 'schema') {
  const found = [];
  if (node === null || typeof node !== 'object') return found;
  if (typeof node.type === 'string' && !ALLOWED.has(node.type)) found.push(`${path}.type=${node.type}`);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue;
    if (Array.isArray(value)) value.forEach((item, index) => found.push(...badTypes(item, `${path}.${key}[${String(index)}]`)));
    else if (value !== null && typeof value === 'object') found.push(...badTypes(value, `${path}.${key}`));
  }
  return found;
}

console.log(`checking ${String(definitions.length)} tool definitions against the registry rules:`);
for (const definition of definitions) {
  let outputError;
  try {
    assertSupportedJsonSchema(definition.output.schema);
  } catch (error) {
    outputError = error;
  }
  check(`${definition.name}: output schema accepted by the registry`, outputError === undefined, outputError === undefined ? '' : String(outputError.message ?? outputError));
  check(`${definition.name}: declares a render function`, typeof definition.output.render === 'function');
  const parameterProblems = badTypes(definition.parameters, 'parameters');
  check(`${definition.name}: parameters use only supported type names`, parameterProblems.length === 0, parameterProblems.join(', '));
  check(`${definition.name}: parameters are an object schema`, definition.parameters?.type === 'object' && typeof definition.parameters.properties === 'object');
  check(`${definition.name}: has a meaningful description`, typeof definition.description === 'string' && definition.description.length > 20);
}

console.log(`\n${failures === 0 ? 'TOOL DEFINITIONS VALID' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
