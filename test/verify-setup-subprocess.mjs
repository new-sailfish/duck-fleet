// The subprocess seam requires a positive finite `graceMs` and rejects a spec without one. This runs
// the setup module against a seam that enforces exactly that, so a missing grace fails loudly here
// instead of only inside the running Host.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKey, readPublicKey, resolveKey } from '../lib/setup.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** Seam that mirrors the real provider's validation before spawning anything. */
const strictSubprocess = {
  spawn(spec) {
    if (typeof spec.graceMs !== 'number' || !Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > 2147483647) {
      throw new Error('subprocess graceMs must be a positive finite number no greater than 2147483647');
    }
    if (typeof spec.cwd !== 'string' || spec.cwd === '') throw new Error('subprocess cwd is required');
    const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return {
      stdin: child.stdin ?? { write() {}, end() {}, on() {} },
      stdout: child.stdout,
      stderr: child.stderr,
      done: new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code ?? 0 }))),
      terminate() { child.kill(); },
      waitForExit: () => new Promise((resolve) => child.on('close', () => resolve())),
    };
  },
};

const isolated = mkdtempSync(join(tmpdir(), 'fleet-grace-'));

console.log('the seam rejects any spec without a grace:');
{
  let threw;
  try {
    strictSubprocess.spawn({ argv: ['x'], cwd: tmpdir(), stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } });
  } catch (error) {
    threw = error;
  }
  check('the strict seam rejects a grace-less spec', threw !== undefined, 'the seam is not strict');
}

console.log('\ngenerating a key through the strict seam:');
{
  const made = await generateKey({ subprocess: strictSubprocess }, { sshDir: isolated });
  check('generation succeeded under the strict seam', made.problem === undefined, made.problem);
  check('a public key came back', /^ssh-ed25519\s/.test(made.publicKey ?? ''), String(made.publicKey).slice(0, 40));
}

console.log('\nreading a public key that only exists as a private key (the ssh-keygen -y path):');
{
  // The exact case that failed in the live Host: a configured private key with no .pub beside it.
  const before = await readPublicKey({ subprocess: strictSubprocess }, join(isolated, 'dsh_fleet_master_ed25519'));
  check('the generated pair is readable first', before.problem === undefined, before.problem);
  rmSync(join(isolated, 'dsh_fleet_master_ed25519.pub'), { force: true });
  const derived = await readPublicKey({ subprocess: strictSubprocess }, join(isolated, 'dsh_fleet_master_ed25519'));
  check('the public half was derived, not read', derived.source === 'derived', String(derived.source));
  check('the derived key matches the original', derived.publicKey === before.publicKey, `${String(derived.publicKey).slice(0, 30)} vs ${String(before.publicKey).slice(0, 30)}`);
  check('no problem was reported', derived.problem === undefined, derived.problem);
}

console.log('\nan existing key is never overwritten, and a new one is written beside it:');
{
  const again = await generateKey({ subprocess: strictSubprocess }, { sshDir: isolated });
  check('a second generation reports success without prompting', again.problem === undefined, again.problem);
  // Overwriting would destroy the public half that machines prepared with the first key authenticate
  // against, so the replacement is written beside it and the original stays on disk.
  check('it is written under a different path', again.privateKey !== join(isolated, 'dsh_fleet_master_ed25519'), again.privateKey);
  check('it says which key it superseded', again.replaced === join(isolated, 'dsh_fleet_master_ed25519'), String(again.replaced));
  check('it is a different key, not a reread of the first', again.publicKey !== before.publicKey);
  check('and it returns a usable key', typeof again.publicKey === 'string' && again.publicKey.length > 0, String(again.publicKey).slice(0, 30));
}

console.log('\nthe whole setup path through the strict seam:');
{
  const resolved = await resolveKey({ subprocess: strictSubprocess }, { sshDir: isolated });
  check('the generated key is discovered', resolved.candidates.length === 1, resolved.candidates.join(', '));
  const read = await readPublicKey({ subprocess: strictSubprocess }, resolved.candidates[0]);
  check('its public half reads cleanly', read.problem === undefined, read.problem);
}

rmSync(isolated, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'STRICT SUBPROCESS CONTRACT VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
