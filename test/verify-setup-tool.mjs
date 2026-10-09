// The agent-facing onboarding tool: it must produce the same prompt the panel would, refuse to
// write anything without an explicit opt-in, and report a missing key as a next step rather than a
// stack trace.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managementToolDefinitions } from '../lib/tools.js';
import { readPublicKey, resolveKey } from '../lib/setup.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** The real subprocess seam, reduced to what a one-shot command needs. */
const subprocess = {
  spawn(spec) {
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

const runtime = { config: async () => ({ machines: [] }), status: () => ({ machines: [], warnings: [] }), stateOf: () => 'ready', storePath: () => 'x' };
const definitions = managementToolDefinitions(runtime, { setup: { subprocess } });
const byName = new Map(definitions.map((definition) => [definition.name, definition]));

console.log('tool surface:');
check('fleet_setup is registered', byName.has('fleet_setup'));
check('fleet_add points at fleet_setup for an unprepared machine', byName.get('fleet_add').description.includes('fleet_setup'));
check('fleet_setup is marked not concurrency safe', byName.get('fleet_setup').isConcurrencySafe() === false);

const setup = byName.get('fleet_setup');
const isolated = await mkdtemp(join(tmpdir(), 'fleet-tool-'));

console.log('\nan unconfigured controller still returns usable instructions:');
{
  // Point the tool at an empty SSH dir via the same resolution path the Host uses.
  const realResolve = await resolveKey({ subprocess }, { sshDir: isolated });
  check('an empty SSH dir yields no candidates', realResolve.candidates.length === 0);

  const text = await setup.execute({ user: 'dev', host: 'box' });
  check('the answer is text', typeof text === 'string' && text.length > 0, typeof text);
  check('it names the key it would offer', /Key offered: /.test(text), text.split('\n')[1]);
  check('it names the fingerprint to expect', /Fingerprint to expect back: dsh-fleet-/.test(text), text.split('\n')[2]);
  check('it instructs the agent to hand the prompt over verbatim', text.includes('verbatim'));
  check('it embeds the prompt with the public key', /ssh-(ed25519|rsa)\s/.test(text));
  check('it forbids copying a private key', text.includes('私钥只存在于主控机'));
}

console.log('\nthere is exactly one prompt, and no argument can shorten it:');
{
  const plain = await setup.execute({ user: 'u', host: 'h' });
  const posix = await setup.execute({ user: 'u', host: 'h', platform: 'posix' });
  // The prompt is a task for the machine's own agent, so it carries no per-platform command blocks and
  // the removed arguments must not change it at all.
  check('a removed platform argument changes nothing', plain === posix, 'the prompt must not depend on `platform`');
  check('it carries the firewall step', plain.includes('## 步骤 2：防火墙'));
  check('it carries the profile step', plain.includes('准备 `acp` profile'));
  check('it carries the public-key step', plain.includes('安装主控机的公钥'));
  const legacy = await setup.execute({ user: 'u', host: 'h', mode: 'pair', includeFirewall: false, platform: 'posix' });
  check('a legacy mode argument changes nothing', legacy === plain);
  check('a legacy firewall opt-out changes nothing', legacy === plain);
  const properties = Object.keys(byName.get('fleet_setup').parameters.properties);
  check('the tool offers no depth', !properties.includes('mode'), JSON.stringify(properties));
  check('the tool offers no firewall switch', !properties.includes('includeFirewall'), JSON.stringify(properties));
  check('the tool offers no platform switch', !properties.includes('platform'), JSON.stringify(properties));
}

console.log('\nthe explicit opt-in actually generates a key:');
{
  // Simulate an empty controller by pointing the whole HOME-based resolution at the empty dir is not
  // possible through the tool (it uses the real home), so the generation path is exercised directly
  // and the tool's message is checked for the consent wording.
  const resolve = await resolveKey({ subprocess }, { sshDir: isolated });
  check('generation target is outside the workspace', resolve.generated.privateKey.startsWith(isolated), resolve.generated.privateKey);
  const withoutConsent = await setup.execute({ user: 'u' });
  if (withoutConsent.includes('Cannot build the setup instructions')) {
    check('without consent it asks before writing', withoutConsent.includes('ask the user first'), withoutConsent);
    const withConsent = await setup.execute({ user: 'u', generateKey: true });
    check('with consent it reports what it created', /Created .*dsh_fleet_master_ed25519/.test(withConsent), withConsent.split('\n').slice(0, 2).join(' | '));
  } else {
    console.log('       (this controller already has a key, so the consent path is not reachable here;');
    console.log('        the refusal path is covered by verify-setup.mjs instead)');
  }
}

console.log('\nledger sanity:');
{
  const generated = join(isolated, 'dsh_fleet_master_ed25519');
  check('nothing was written while only reading', await readFile(generated, 'utf8').then(() => false, () => true));
  const publicKey = await readPublicKey({ subprocess }, generated).catch(() => ({ problem: 'n/a' }));
  check('reading a non-existent key reports a problem instead of throwing', typeof publicKey.problem === 'string');
}

await rm(isolated, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'SETUP TOOL VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
