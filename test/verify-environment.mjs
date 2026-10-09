// Environment detection for the CONTROLLER: does this machine have the SSH tools the plugin needs?
//
// The probe must decide presence by whether the binary STARTS, never by what it prints: a bare
// `ssh-keygen` is not innocent (it begins generating a key pair), and `ssh -V` exits non-zero by design.
// The real subprocess service raises SubprocessExecutableNotFoundError for a command it cannot resolve,
// so the stub reproduces that contract instead of letting spawn emit an unhandled 'error'.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildLocalSetupPrompt, inspectEnvironment } from '../lib/setup.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** The error the real service raises; matched by constructor name, exactly as the plugin matches it. */
class SubprocessExecutableNotFoundError extends Error {
  constructor(message) { super(message); this.name = 'SubprocessExecutableNotFoundError'; }
}

/**
 * A subprocess seam that behaves like `dsh-subprocess-local` where it matters: an unresolvable command
 * throws before any child exists, and a resolvable one runs to completion.
 */
const subprocess = {
  spawn(spec) {
    const [command, ...args] = spec.argv;
    // PATH names are resolved by the real service; for the stub, a dotted name is treated as a path.
    if (isAbsolute(command) && !existsSync(command)) {
      throw new SubprocessExecutableNotFoundError(`subprocess-local: command ${JSON.stringify(command)} was not found`);
    }
    const child = spawn(command, args, { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return {
      stdin: { write() {}, end() {}, on() {} },
      stdout: child.stdout,
      stderr: child.stderr,
      done: new Promise((resolve) => {
        child.on('close', (code) => resolve({ exitCode: code ?? 0 }));
        child.on('error', () => resolve({ exitCode: 127 }));
      }),
      terminate() { child.kill(); },
      waitForExit: () => new Promise((resolve) => { child.on('close', () => resolve()); child.on('error', () => resolve()); }),
    };
  },
};

const deps = { subprocess };

console.log('a healthy controller:');
{
  const env = await inspectEnvironment(deps, { sshCommand: 'ssh' });
  check('ssh is found', env.ssh.present === true, env.ssh.detail);
  check('ssh-keygen is found', env.keygen.present === true, env.keygen.detail);
  check('the environment is reported usable', env.ok === true);
  check('ssh reports its version', /OpenSSH/i.test(env.ssh.detail), env.ssh.detail);
  check('the configured command is echoed back', env.sshCommand === 'ssh');
  check('an absolute sshCommand is honoured', (await inspectEnvironment(deps, { sshCommand: process.execPath })).ssh.present === true, 'a full path must work');
}

console.log('\na controller with no SSH installed:');
{
  // The state this feature exists for: a fresh machine where the plugin would otherwise fail much later,
  // during a delegation, with a spawn error that never mentions OpenSSH.
  const env = await inspectEnvironment(deps, { sshCommand: 'C:/nowhere/ssh.exe' });
  check('a missing ssh is reported absent', env.ssh.present === false, env.ssh.detail);
  check('and the reason names the command', env.ssh.detail.includes('C:/nowhere/ssh.exe'), env.ssh.detail);
  check('the environment is reported unusable', env.ok === false);
  const prompt = buildLocalSetupPrompt(env);
  check('a prompt is produced', typeof prompt === 'string' && prompt.length > 0);
  check('it names ONLY the missing tool', prompt.includes('`ssh`（客户端）') && !prompt.includes('`ssh-keygen`（生成密钥）'), prompt.split('\n')[0]);
  check('it is addressed to THIS machine', prompt.includes('本机（这台电脑）') && prompt.includes('只在这台电脑上操作'));
  check('it does not mention a controlled machine', !prompt.includes('被控机'));
  check('it leaves the commands to the agent', prompt.includes('用你熟悉的方式'));
  check('it asks for the exact evidence back', prompt.includes('ssh -V') && prompt.includes('绝对路径'));
  check('it grants elevation in this session', prompt.includes('完全权限') && prompt.includes('管理员'));
  check('it bounds what must be reported', prompt.includes('只需要回报'));
}

console.log('\nthe prompt adapts to which tool is missing:');
{
  const both = buildLocalSetupPrompt({ ssh: { present: false }, keygen: { present: false } });
  check('both missing reads naturally', both.startsWith('本机（这台电脑）缺少 `ssh`（客户端）、`ssh-keygen`（生成密钥）。'), both.split('\n')[0]);
  const keygenOnly = buildLocalSetupPrompt({ ssh: { present: true }, keygen: { present: false } });
  check('only ssh-keygen missing names just that one', keygenOnly.includes('缺少 `ssh-keygen`（生成密钥）'), keygenOnly.split('\n')[0]);
  check('singular wording when one is missing', keygenOnly.includes('要用它') && !keygenOnly.includes('要用它们'), 'grammar must follow the count');
  check('plural wording when both are missing', both.includes('要用它们'));
}

console.log('\nno probe has a side effect:');
{
  // A bare `ssh-keygen` starts generating a key pair, so the probe must never invoke it that way. This is
  // asserted on the arguments actually used, not on the comment claiming it.
  const seen = [];
  const recording = {
    spawn(spec) {
      seen.push(spec.argv);
      return subprocess.spawn(spec);
    },
  };
  await inspectEnvironment({ subprocess: recording }, {});
  const keygenCall = seen.find((argv) => argv[0] === 'ssh-keygen');
  check('ssh-keygen is probed', keygenCall !== undefined, JSON.stringify(seen));
  check('never with no operand (which would generate a key)', keygenCall.length > 1, JSON.stringify(keygenCall));
  check('and never with an operand that writes', !keygenCall.includes('-t') && !keygenCall.includes('-f'), JSON.stringify(keygenCall));
  const sshCall = seen.find((argv) => argv[0] === 'ssh');
  check('ssh is probed with a harmless flag', sshCall.includes('-V'), JSON.stringify(sshCall));
}

console.log('\na composition without a subprocess service:');
{
  const env = await inspectEnvironment({}, {});
  check('it reports the tools absent rather than throwing', env.ssh.present === false && env.keygen.present === false);
  check('and says why', String(env.ssh.detail).includes('no subprocess service'), env.ssh.detail);
}

await rm(await mkdtemp(join(tmpdir(), 'fleet-env-')), { recursive: true, force: true });
void homedir;

console.log(`\n${failures === 0 ? 'ENVIRONMENT CHECK VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
