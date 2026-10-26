// The seam between this plugin and the Host's subagent service.
//
// The Host's `@deepseek-ai/dsh-subagent` moved from `start(provider, options)` to
// `startActivation(spec)`. Provider registration did not change, so the plugin kept registering every
// machine and every delegation then failed with `deps.subagents.start is not a function`. Every other
// suite here stubs an old-shaped `start`, which is exactly why the breakage could ship: the seam this
// plugin is wired to was the one thing no test executed. This suite drives the plugin's own `apply`
// against an activation-only service and checks what reaches the service and what comes back out.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

const TASK = 'report the working directory';

/** A Cordis-shaped context carrying exactly the subagent methods the case under test provides. */
function fakeContext(services) {
  const tools = new Map();
  const providers = new Map();
  return {
    tools,
    providers,
    ctx: {
      logger: { warn() {}, error() {}, info() {} },
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
        ...services,
      },
      effect(callback) {
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      get: () => undefined,
    },
  };
}

/** One machine, added through the tool a person (or the model) actually calls. */
async function addMachine(tools) {
  await tools.get('fleet_add').execute(
    { id: 'b', label: 'Laptop', host: '192.168.1.10', user: 'dev' },
    { signal: new AbortController().signal },
  );
}

/** A scratch store per case, so cases cannot see each other's machines. */
function store() {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-facade-'));
  return { path: join(directory, 'fleet.json'), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

console.log('an activation-only Host (the current seam):');
{
  const scratch = store();
  const calls = [];
  const order = [];
  const { ctx, tools, providers } = fakeContext({
    async startActivation(spec) {
      calls.push(spec);
      const result = Promise.resolve({ output: [{ type: 'text', text: 'REMOTE_ANSWER' }], stopReason: 'completed' })
        .then((value) => { order.push('result'); return value; });
      return {
        childId: 'child-7',
        messageId: 'message-1',
        result,
        dispose: async () => { order.push('dispose'); },
      };
    },
  });

  // The plugin must load even though the older `start` method is absent; the failure it used to
  // produce happened at activation, before any tool was usable.
  await apply(ctx, { storePath: scratch.path });
  check('the plugin applies against an activation-only service', tools.has('fleet_list'), [...tools.keys()].join(','));
  await addMachine(tools);
  check('the machine provider is registered', providers.has('fleet-b'), [...providers.keys()].join(','));
  check('the delegation tool is registered', tools.has('pc_laptop'), [...tools.keys()].join(','));

  const exec = { agent: { id: 'session-1' }, signal: new AbortController().signal };
  let answer;
  let error;
  try {
    answer = await tools.get('pc_laptop').execute({ description: 'verify', prompt: TASK }, exec);
  } catch (failure) {
    error = failure;
  }

  check('the delegation completes instead of failing on deps.subagents.start', error === undefined, String(error?.message));
  check('the answer comes back through the tool result', answer?.output?.[0]?.text === 'REMOTE_ANSWER', JSON.stringify(answer).slice(0, 160));
  check('the run id is the activation child id', answer?.runId === 'child-7', String(answer?.runId));
  check('the payload keeps the machine identity', answer?.machine === 'b' && answer?.target === 'dev@192.168.1.10', JSON.stringify(answer));

  const spec = calls[0];
  check('exactly one activation was started', calls.length === 1, String(calls.length));
  check('the registered provider name is used', spec?.provider === 'fleet-b', String(spec?.provider));
  check('the tool description becomes the label', spec?.label === 'verify', String(spec?.label));
  check('the parent is the calling agent', spec?.request?.parent === exec.agent, String(spec?.request?.parent?.id));
  check('the signal is the caller\'s', spec?.signal === exec.signal, String(spec?.signal));
  // Caller delivery: the tool call returns the answer. `parent` delivery would inject a second copy of it
  // as a completion notice the session never asked for.
  check('the activation uses caller delivery', spec?.delivery === 'caller', String(spec?.delivery));
  const sent = spec?.request?.prompt?.[0];
  check('the prompt is one text block', spec?.request?.prompt?.length === 1 && sent?.type === 'text', JSON.stringify(spec?.request?.prompt));
  check('the prompt carries the preamble in front of the task', String(sent?.text).includes('工作通则') && String(sent?.text).endsWith(TASK), String(sent?.text).slice(0, 90));
  check('the result settles before disposal', order.join(',') === 'result,dispose', order.join(','));
  scratch.dispose();
}

console.log('\na Host with neither seam method:');
{
  const scratch = store();
  const { ctx, tools } = fakeContext({});
  await apply(ctx, { storePath: scratch.path });
  await addMachine(tools);
  check('the plugin still loads', tools.has('fleet_list') && tools.has('pc_laptop'), [...tools.keys()].join(','));
  let error;
  try {
    await tools.get('pc_laptop').execute(
      { description: 'verify', prompt: TASK },
      { agent: { id: 'session-1' }, signal: new AbortController().signal },
    );
  } catch (failure) {
    error = failure;
  }
  check('a delegation says what this Host is missing', String(error?.message).includes('startActivation'), String(error?.message).slice(0, 160));
  check('and names the method it did find', String(error?.message).includes('registerProvider'), String(error?.message).slice(0, 200));
  // The management surface is the way out when delegation is impossible, so it must keep working.
  const listed = await tools.get('fleet_list').execute({}, { signal: new AbortController().signal });
  check('the management tools remain usable', String(listed).includes('pc_laptop'), String(listed).split('\n')[0]);
  scratch.dispose();
}

console.log('\na Host that still exposes the older start:');
{
  const scratch = store();
  let startCalls = 0;
  let activationCalls = 0;
  const { ctx, tools } = fakeContext({
    async start() {
      startCalls += 1;
      return {
        id: 'run-9',
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'LEGACY' }], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
    async startActivation() {
      activationCalls += 1;
      throw new Error('an existing start must be used instead');
    },
  });
  await apply(ctx, { storePath: scratch.path });
  await addMachine(tools);
  const answer = await tools.get('pc_laptop').execute(
    { description: 'verify', prompt: TASK },
    { agent: { id: 'session-1' }, signal: new AbortController().signal },
  );
  check('the existing start path is used unchanged', answer?.output?.[0]?.text === 'LEGACY', JSON.stringify(answer).slice(0, 160));
  check('startActivation is not called on that Host', startCalls === 1 && activationCalls === 0, `start=${String(startCalls)} startActivation=${String(activationCalls)}`);
  scratch.dispose();
}

console.log(`\n${failures === 0 ? 'SUBAGENT FACADE VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
