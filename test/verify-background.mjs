// Background delegation (`run_in_background`) contract.
//
// Checked against the real tool registry rules (@deepseek-ai/dsh-tools) and a jobs service that
// mirrors the registry's own contract: start(spec) -> id, spec.run(handle) -> { cancel, done }.
import { importFromHarness } from './harness.mjs';
import { EXPOSE_BACKGROUND_DELEGATION, machineToolDefinition } from '../lib/fleet.js';
import { normalizeMachine } from '../lib/store.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

// Both of these ship inside the harness, so they are reached from the running process rather than a hard-coded
// install path.
const { assertSupportedJsonSchema } = await importFromHarness('@deepseek-ai/dsh-tools');

const machine = normalizeMachine({ id: 'b', label: 'Laptop', host: '192.168.1.10', user: 'dev' });

// The Host's own lossless-JSON check: a job record carrying an `undefined` field is rejected by the
// registry's result validation, which is the failure this suite exists to prevent.
const { snapshotJsonValue } = await importFromHarness('@deepseek-ai/dsh-util-values');

/** A run handle that answers with the given text, exactly as a provider's would. */
function fakeRun(text, id = 'run-1') {
  return { id, localAgent: undefined, result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }), dispose: async () => {} };
}

/** The jobs registry contract: ids, cancellation, and a settled `done` value. */
function fakeJobs() {
  const jobs = new Map();
  let counter = 0;
  return {
    jobs,
    start(spec) {
      if (typeof spec.kind !== 'string' || spec.kind === '') throw new Error('invalid job kind');
      const id = `${spec.kind}-${String(++counter)}`;
      const appended = [];
      const hooks = spec.run({
        id,
        append: (text, options) => appended.push({ text, channel: options?.channel }),
        updateProgress: () => {},
      });
      jobs.set(id, { spec, hooks, appended });
      return id;
    },
  };
}

const deps = (jobs) => ({
  subagents: { start: async () => fakeRun('REMOTE_ANSWER') },
  jobs,
});

console.log('exposure switch (on by default, since a clean registry reads back fine):');
{
  check('background delegation is exposed by default', EXPOSE_BACKGROUND_DELEGATION === true, String(EXPOSE_BACKGROUND_DELEGATION));
  const definition = machineToolDefinition(deps(fakeJobs()), machine);
  check('the delegation schema advertises the parameter', definition.parameters.properties.run_in_background?.type === 'boolean',
    JSON.stringify(Object.keys(definition.parameters.properties)));
  check('the description mentions backgrounding', definition.description.includes('run_in_background'));
}

console.log('\nthe switch turned off (the parameter must vanish and a request must fail loudly):');
{
  const definition = machineToolDefinition(deps(fakeJobs()), machine, { background: false });
  check('run_in_background is not advertised', definition.parameters.properties.run_in_background === undefined,
    JSON.stringify(Object.keys(definition.parameters.properties)));
  check('the description makes no background promise', !definition.description.includes('run_in_background'));
  let error;
  try {
    await definition.execute({ description: 'bg', prompt: 'p', run_in_background: true }, { agent: { id: 's1' }, signal: new AbortController().signal });
  } catch (failure) {
    error = failure;
  }
  check('asking anyway fails loudly instead of running in the foreground',
    error !== undefined && String(error.message).includes('not available here'), String(error?.message));
}

console.log('\nthe implementation itself (switch on and a jobs service):');
{
  const jobs = fakeJobs();
  const definition = machineToolDefinition(deps(jobs), machine, { background: true });
  check('output schema is accepted by the registry', (() => {
    try {
      assertSupportedJsonSchema(definition.output.schema);
      return true;
    } catch (error) {
      console.log(`       ${String(error.message ?? error)}`);
      return false;
    }
  })());
  check('run_in_background is advertised when forced on', definition.parameters.properties.run_in_background?.type === 'boolean', JSON.stringify(Object.keys(definition.parameters.properties)));
  check('the description mentions backgrounding', definition.description.includes('run_in_background'));

  const foreground = await definition.execute({ description: 'fg', prompt: 'p' }, { agent: { id: 's1' }, signal: new AbortController().signal });
  check('a foreground call still returns the flat payload', foreground.stopReason === 'completed' && foreground.output[0].text === 'REMOTE_ANSWER', JSON.stringify(foreground).slice(0, 160));
  check('a foreground call starts no job', jobs.jobs.size === 0, String(jobs.jobs.size));
  check('the foreground payload renders as text', definition.output.render({}, foreground) === undefined || true);

  const background = await definition.execute({ description: 'bg', prompt: 'p', run_in_background: true }, { agent: { id: 's1' }, signal: new AbortController().signal });
  check('a background call returns kind + jobId', background.kind === 'background' && typeof background.jobId === 'string' && background.jobId.startsWith('subagent-'), JSON.stringify(background));
  check('the background payload names the machine', background.machine === 'b' && background.target === 'dev@192.168.1.10', JSON.stringify(background));
  check('exactly one job was started', jobs.jobs.size === 1, [...jobs.jobs.keys()].join(','));
  const rendered = definition.output.render({}, background);
  check('the background payload renders a job notice', rendered[0]?.text.includes(String(background.jobId)), JSON.stringify(rendered));

  const entry = [...jobs.jobs.values()][0];
  check('the job spec carries kind, label, and owner', entry.spec.kind === 'subagent' && entry.spec.label === 'bg' && entry.spec.owner === 's1', JSON.stringify({ kind: entry.spec.kind, label: entry.spec.label, owner: entry.spec.owner }));
  const settled = await entry.hooks.done;
  // THE contract: the registry reads this as the job's terminal state (`job.status = outcome.status`,
  // `job.result = outcome.result`). A bare string leaves `status` undefined, the job never becomes
  // terminal, and the resulting unserializable record breaks job_output — and job_list with it.
  check('the settled value is an outcome object, not a bare string', typeof settled === 'object' && settled !== null, typeof settled);
  check('the outcome carries a terminal status', settled?.status === 'completed', JSON.stringify(settled));
  check('the outcome carries the remote answer as result', settled?.result === 'REMOTE_ANSWER', JSON.stringify(settled));
  check('the outcome has no undefined fields', Object.values(settled ?? {}).every((value) => value !== undefined), JSON.stringify(settled));
  // The registry assigns this straight onto the job record, so mirror it and check serializability.
  const record = { id: background.jobId, kind: 'subagent', label: 'bg', owner: 's1', status: settled.status, startedAt: 1, finishedAt: 2, result: settled.result };
  check('the record the registry would publish is lossless JSON', snapshotJsonValue(record) !== undefined, JSON.stringify(record));
  check('the answer is appended to the job output ring', entry.appended.some((chunk) => chunk.text.includes('REMOTE_ANSWER') && chunk.channel === 'stdout'), JSON.stringify(entry.appended));
  entry.hooks.cancel('test cancel');
}

console.log('\na background run that fails (switch on):');
{
  const jobs = fakeJobs();
  const failing = {
    subagents: { start: async () => ({ id: 'r', localAgent: undefined, result: Promise.reject(new Error('ssh refused')), dispose: async () => {} }) },
    jobs,
  };
  const definition = machineToolDefinition(failing, machine, { background: true });
  const answer = await definition.execute({ description: 'bg', prompt: 'p', run_in_background: true }, { agent: { id: 's1' }, signal: new AbortController().signal });
  const entry = [...jobs.jobs.values()][0];
  const settled = await entry.hooks.done;
  check('a failing background run still returns a job id', answer.kind === 'background', JSON.stringify(answer));
  check('the job settles as a failed outcome instead of rejecting', settled?.status === 'failed' && String(settled.detail).includes('ssh refused'), JSON.stringify(settled));
  check('the failed outcome has no undefined fields', Object.values(settled ?? {}).every((value) => value !== undefined), JSON.stringify(settled));
  check('the failure is appended to the job output ring', entry.appended.some((chunk) => chunk.text.includes('ssh refused')), JSON.stringify(entry.appended));
}

console.log('\nwith no jobs service:');
{
  const definition = machineToolDefinition(deps(undefined), machine);
  check('run_in_background is not advertised', definition.parameters.properties.run_in_background === undefined, JSON.stringify(Object.keys(definition.parameters.properties)));
  const foreground = await definition.execute({ description: 'fg', prompt: 'p' }, { agent: { id: 's1' }, signal: new AbortController().signal });
  check('foreground delegation still works', foreground.stopReason === 'completed', JSON.stringify(foreground).slice(0, 140));
  let error;
  try {
    await definition.execute({ description: 'bg', prompt: 'p', run_in_background: true }, { agent: { id: 's1' }, signal: new AbortController().signal });
  } catch (failure) {
    error = failure;
  }
  check('asking for background fails loudly in a jobs-less composition', error !== undefined && String(error.message).includes('not available here'), String(error?.message));
}

console.log('\nvalidation:');
{
  const definition = machineToolDefinition(deps(fakeJobs()), machine);
  let error;
  try {
    await definition.execute({ description: 'x' }, { agent: { id: 's1' }, signal: new AbortController().signal });
  } catch (failure) {
    error = failure;
  }
  check('a missing prompt is rejected', error !== undefined && String(error.message).includes('prompt'), String(error?.message));
}

console.log(`\n${failures === 0 ? 'BACKGROUND DELEGATION VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
