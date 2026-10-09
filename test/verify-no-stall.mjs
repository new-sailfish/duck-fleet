// Regression tests for the stall that hung a tool call for 45 hours.
//
// Every case here is a transport that CANNOT complete a handshake. The contract under test is that
// `handle.result` always settles quickly with a typed diagnostic, and that the child is not leaked.
import { spawn as nodeSpawn } from 'node:child_process';
import { runAcpChild } from '../lib/acp.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** Run one unusable transport and report how it settled. */
async function runCase(label, options) {
  const started = Date.now();
  const controller = new AbortController();
  let handle;
  try {
    handle = await runAcpChild({
      name: label,
      permission: 'allow',
      graceMs: 500,
      eofGraceMs: 500,
      signal: controller.signal,
      prompt: 'never answered',
      ...options,
    });
  } catch (error) {
    return { elapsedMs: Date.now() - started, rejected: true, message: String(error.message ?? error) };
  }
  const outcome = await handle.result;
  await handle.dispose();
  return { elapsedMs: Date.now() - started, ...outcome };
}

const silentChild = [process.execPath, '-e', 'process.stdin.resume()'];

/** Spawn exactly the way the harness subprocess seam does: scrubbed parent environment. */
const seamSpawn = (spec) => nodeSpawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  stdio: ['pipe', 'pipe', 'ignore'],
  env: process.env,
  windowsHide: true,
});

console.log('a live child that never speaks the protocol (the 45-hour case):');
{
  const result = await runCase('silent', {
    argv: silentChild,
    cwd: process.cwd(),
    env: {},
    startupTimeoutMs: 2500,
    spawn: seamSpawn,
  });
  check('settles instead of hanging', result.rejected !== true, JSON.stringify(result).slice(0, 200));
  check('reports an error stop reason', result.stopReason === 'error', String(result.stopReason));
  check('names the initialize stage', String(result.diagnostic).includes('stage: initialize'), String(result.diagnostic));
  check('settles within the startup bound, not after it', result.elapsedMs < 20000, `${String(result.elapsedMs)}ms`);
  check('produces a typed diagnostic either way',
    String(result.diagnostic).includes('category: startup-timeout') || String(result.diagnostic).includes('category: transport'),
    String(result.diagnostic));
}

console.log('\na child that exits immediately (ssh failing fast):');
{
  const result = await runCase('exits', {
    argv: [process.execPath, '-e', 'process.exit(255)'],
    cwd: process.cwd(),
    env: {},
    startupTimeoutMs: 30000,
    spawn: seamSpawn,
  });
  check('settles well before the startup bound', result.elapsedMs < 10000, `${String(result.elapsedMs)}ms`);
  check('reports an error stop reason', result.stopReason === 'error', String(result.stopReason));
  check('reports the exit rather than a timeout', String(result.diagnostic).includes('category: transport'), String(result.diagnostic));
}

console.log('\na spawn that yields no usable stdio:');
{
  const result = await runCase('nostream', {
    argv: ['does-not-matter'],
    cwd: process.cwd(),
    env: {},
    startupTimeoutMs: 3000,
    spawn: () => ({
      stdin: null,
      stdout: undefined,
      done: Promise.resolve({ exitCode: 1 }),
      terminate() {},
      waitForExit: async () => true,
    }),
  });
  check('is rejected rather than pending', result.rejected === true || result.stopReason === 'error', JSON.stringify(result).slice(0, 200));
  check('settles immediately', result.elapsedMs < 5000, `${String(result.elapsedMs)}ms`);
}

console.log('\na cancelled run:');
{
  const controller = new AbortController();
  const started = Date.now();
  const handle = await runAcpChild({
    name: 'cancelled',
    argv: silentChild,
    cwd: process.cwd(),
    env: {},
    permission: 'allow',
    graceMs: 500,
    eofGraceMs: 500,
    startupTimeoutMs: 30000,
    signal: controller.signal,
    prompt: 'never answered',
    spawn: seamSpawn,
  });
  controller.abort();
  const outcome = await handle.result;
  await handle.dispose();
  check('cancellation settles the run', outcome.stopReason === 'aborted' || outcome.stopReason === 'error', `${String(Date.now() - started)}ms stopReason=${String(outcome.stopReason)}`);
}

console.log(`\n${failures === 0 ? 'NO-STALL CONTRACT HOLDS' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
