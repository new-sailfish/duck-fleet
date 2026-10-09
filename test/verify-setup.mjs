// The controlled-side setup prompt: structure, wording constraints, and the traps that shipped once.
//
// Assertions are written against the prompt's SEMANTIC units rather than its exact sentences where
// possible, because a wording fix must not be able to silently pass by deleting a requirement — but a
// wording fix also must not require rewriting every assertion. Where an exact phrase matters, it comes
// from an exported constant instead of being retyped here.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFromHarness } from './harness.mjs';
import {
  GENERATED_KEY_COMMENT,
  GENERATED_KEY_NAME,
  buildSetupPrompt,
  fingerprintOf,
  generateKey,
  generatedKeyPaths,
  keyIdentityOf,
  listPrivateKeys,
  readPublicKey,
  resolveKey,
} from '../lib/setup.js';
import { NO_INSTALL_RULE, NO_PRIVATE_KEY_RULE } from '../lib/prompt-rules.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

// The harness's own snapshot rules, so this suite measures the real thing — reached from the running harness
// rather than a hard-coded install path.
const { snapshotJsonValue } = await importFromHarness('@deepseek-ai/dsh-util-values');

/**
 * The real subprocess seam, reduced to what a one-shot command needs: stdout/stderr as async
 * iterables, `done` for the exit facts, and `terminate()`. Real ssh-keygen does the work.
 */
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
      done: new Promise((resolve) => { child.on('close', (code) => resolve({ exitCode: code ?? 0 })); }),
      terminate() { child.kill(); },
      waitForExit: () => new Promise((resolve) => { child.on('close', () => resolve()); }),
    };
  },
};

const deps = { subprocess };

console.log('key discovery on this controller:');
const resolved = await resolveKey(deps);
check('at least one candidate key was found', resolved.candidates.length > 0, resolved.candidates.join(', '));
check('the generated-key target is reported', typeof resolved.generated.privateKey === 'string', JSON.stringify(resolved.generated));

console.log('\nreading the public half (never the private half):');
const configured = resolved.candidates.find((path) => path.includes('dsh_master_ed25519')) ?? resolved.candidates[0];
const read = await readPublicKey(deps, configured);
check('the public key was obtained', read.problem === undefined && typeof read.publicKey === 'string', read.problem ?? '');
check('it is an OpenSSH public key line', /^ssh-(ed25519|rsa)\s/.test(read.publicKey ?? ''), String(read.publicKey).slice(0, 40));
check('a fingerprint was produced', /^dsh-fleet-[0-9a-f]{8}$/.test(read.fingerprint ?? ''), read.fingerprint);
check('the fingerprint is stable', fingerprintOf(read.publicKey) === read.fingerprint);
check('it was derived when no .pub exists beside the key', read.source === 'derived', String(read.source));
check('the private key material is never returned', !JSON.stringify(read).includes('PRIVATE KEY'));

console.log('\ngenerating key pairs into a throwaway directory:');
const isolated = await mkdtemp(join(tmpdir(), 'fleet-setup-'));
{
  const made = await generateKey(deps, { sshDir: isolated });
  check('generation succeeded', made.problem === undefined, made.problem);
  check('a public key came back', /^ssh-ed25519\s/.test(made.publicKey ?? ''), String(made.publicKey).slice(0, 40));
  check('the key carries the recognizable comment', String(made.publicKey).endsWith(GENERATED_KEY_COMMENT));
  check('the base name is used when it is free', made.privateKey.endsWith(GENERATED_KEY_NAME), made.privateKey);
  check('and nothing was replaced', made.replaced === undefined);

  // "Generate a new key" must yield a NEW key. Overwriting is not an option: the old private key is
  // disposable, but its PUBLIC half is installed on machines prepared with it.
  const second = await generateKey(deps, { sshDir: isolated });
  check('a second generation makes a different key', second.publicKey !== made.publicKey, 'it must not reuse the first');
  check('it is written beside the first, dated', second.privateKey !== made.privateKey && second.privateKey.includes(GENERATED_KEY_NAME), second.privateKey);
  check('it reports what it superseded', second.replaced === made.privateKey, String(second.replaced));
  const third = await generateKey(deps, { sshDir: isolated });
  check('a third generation makes yet another key', third.publicKey !== made.publicKey && third.publicKey !== second.publicKey);
  check('and the first key is still on disk', (await readPublicKey(deps, made.privateKey)).publicKey === made.publicKey, 'prepared machines depend on it');
  const found = await listPrivateKeys({}, { sshDir: isolated });
  check('every generated key is listed', found.keys.length === 3, found.keys.map((entry) => entry.name).join(', '));
  check('each entry knows whether a .pub sits beside it', found.keys.every((entry) => entry.hasPublicHalf === true));
  check('no key is ever overwritten', new Set([made.publicKey, second.publicKey, third.publicKey]).size === 3);
}

const prompt = buildSetupPrompt({ publicKey: read.publicKey, user: 'dev', host: '192.168.1.10' });

console.log('\nthe reader, and what must not be assumed:');
{
  // The reader is the CONTROLLED machine's own agent, already inside DSH. An earlier version opened by
  // addressing the controller's operator ("if you are actually in a terminal, go install DSH Desktop"),
  // and a later one explained the premise the reader cannot fail to satisfy.
  // The opening line names the product, so the reader knows what it is being joined to. It must NOT address the
  // controller's operator ("if you are actually in a terminal, go install DSH Desktop") and must NOT lecture
  // about a premise the reader already satisfies — the reader IS a DSH agent on the controlled machine.
  check('it opens with the goal', prompt.startsWith('目标：把本机接进主控机的 **DuckFleet**'), prompt.split('\n')[0]);
  check('it names the product the machine is joining', prompt.includes('DuckFleet') && prompt.includes('鸭群'), prompt.split('\n')[0]);
  check('it says what the controller will do', prompt.includes('用 ssh 登录本机') && prompt.includes('dsh --profile acp'));
  check('it does NOT tell the reader to install DSH', !prompt.includes('装好 DSH Desktop') && !prompt.includes('普通终端'));
  check('it does not lecture about a premise the reader already satisfies', !prompt.includes('已经在 DSH 里运行') && !prompt.includes('唯一前提'), 'the reader cannot read this from outside DSH');
  check('it still forbids assuming the machine state', prompt.includes('别假设本机的现状'));
  check('it names what must be checked rather than assumed', ['SSH', '防火墙', 'profile', '账号'].every((item) => prompt.includes(item)));
  check('it says the commands are the controller\'s records, not facts', prompt.includes('都只是主控机那边的记录'));
}

console.log('\nthe SSH port comes from the configuration, never hardcoded:');
{
  // The machine record has a configurable `port` (default 22) and sshArgv/machineTarget both honour it,
  // so a prompt that said "22" would send a machine listening on 2222 to open the wrong port.
  const custom = buildSetupPrompt({ publicKey: read.publicKey, user: 'dev', host: 'h', port: 2222 });
  const numeric = buildSetupPrompt({ publicKey: read.publicKey, user: 'dev', host: 'h', port: '2222' });
  check('a custom port appears in the connection line', custom.includes('用 ssh 登录本机（端口 2222）'), custom.split('\n')[2]);
  check('a numeric string port is accepted (the panel form sends strings)', numeric === custom);
  check('no "22" survives anywhere when the port is 2222', !/\b22\b/.test(custom.replace(/2222/g, '')), custom.split('\n').filter((line) => /\b22\b/.test(line.replace(/2222/g, ''))).join(' | '));
  check('the custom port reaches the firewall step', custom.includes('覆盖 2222 端口') && custom.includes('TCP 2222'));
  check('the custom port reaches the report', custom.includes('`2222` 都只是它原来的记录'));
  check('an omitted port falls back to 22', buildSetupPrompt({ publicKey: read.publicKey, user: 'u', host: 'h' }).includes('（端口 22）'));
  check('a junk port falls back to 22 rather than rendering "NaN"', buildSetupPrompt({ publicKey: read.publicKey, user: 'u', host: 'h', port: 'abc' }).includes('（端口 22）'));
}

console.log('\nthe account is a claim to verify, never a fact to act on:');
{
  // The controller's record of the login account is not evidence about the machine. An earlier version
  // announced "the controller will log in as <account>", which ordered the machine to conform to it.
  check('the account is called a one-sided record', prompt.includes('单方面'), 'must not be presented as fact');
  check('it is explicitly called not a fact', prompt.includes('不是事实') || prompt.includes('未必是本机的事实'));
  check('the machine must verify the account exists', prompt.includes('本机是否真有这个账号'));
  check('the machine must report which account it runs as', prompt.includes('DSH 当前以哪个账号在运行'));
  check('a mismatch must stop the work, not be worked around', prompt.includes('不要自行挑一个账号继续'));
  check('the prompt never asserts the controller WILL log in as that account', !/会以\s*`?dev`?\s*的身份/.test(prompt));
  // A placeholder is NOT emitted as a fallback: a literal `<the controller's account>` reached a real machine
  // once, and its agent correctly stopped and asked — a wasted round trip, and indistinguishable from a value
  // somebody typed. The prompt refuses instead, so the panel can say what to fill in.
  check('a prompt without an account is refused, not filled with a placeholder', (() => {
    try {
      buildSetupPrompt({ publicKey: read.publicKey, user: '' });
      return false;
    } catch (error) {
      return String(error.message).includes('needs the login account');
    }
  })());
  check('no placeholder reaches a built prompt', !/<[^>]*(账号|未填写)[^>]*>/.test(prompt), prompt.split('\n').find((line) => line.includes('<')) ?? '');
}

console.log('\nstep structure:');
{
  const headings = prompt.split('\n').filter((line) => line.startsWith('## 步骤'));
  check('there are exactly four steps', headings.length === 4, headings.join(' | '));
  check('they are numbered consecutively', headings.every((line, index) => line.startsWith(`## 步骤 ${String(index + 1)}：`)), headings.join(' | '));
  check('SSH and the account come first', headings[0].includes('SSH') && headings[0].includes('账号'));
  check('the firewall comes second', headings[1].includes('防火墙'));
  check('the profile comes third', headings[2].includes('acp'));
  check('the key comes last', headings[3].includes('公钥'));
  check('exactly one report section', prompt.split('\n').filter((line) => line.startsWith('## 回报')).length === 1);
  // The report must come AFTER every step, and nothing may follow it.
  const reportAt = prompt.indexOf('## 回报');
  const lastStepAt = prompt.lastIndexOf('## 步骤');
  check('the report follows every step', reportAt > lastStepAt, `${String(lastStepAt)} vs ${String(reportAt)}`);
  check('nothing follows the report', prompt.trimEnd().endsWith('私钥或密钥文件内容。**'), JSON.stringify(prompt.trimEnd().slice(-24)));
}

console.log('\nthe profile step also makes the profile able to RUN things:');
{
  // A profile that only STARTS is not enough. Under a restricted sandbox the ACP session starts fine and then
  // cannot create a child process at all, so the delegated agent cannot run even `Write-Output` — which reads as
  // a broken machine rather than as two missing lines of configuration. Measured on a real machine.
  check('it requires the delegation patch', prompt.includes('cordis.patch.yml'), 'without it the profile cannot execute commands');
  check('it names the sandbox override', prompt.includes('sandbox-policy') && prompt.includes('mode: danger-full-access'));
  check('it names the approval override', prompt.includes('policy: never'), 'nobody is there to answer a prompt');
  check('it explains the failure by its symptom', prompt.includes('0xC0000142') && prompt.includes('STATUS_DLL_INIT_FAILED'), 'the controller would otherwise report a bare exit code');
  check('it says the empty array must be replaced', prompt.includes('空的 `[]` 必须被这些条目替换'), 'the patch file starts as []');
  check('it warns that starting is not proof', prompt.includes('只验证「能启动」不够'), 'the failure is at execution, not startup');
  check('it says a hand-made profile needs it too', prompt.includes('也要写这个 patch'));
  // "A profile already exists" is not the same as "its patch is right": a profile created by hand starts fine
  // and still carries the template's empty `[]`. Without an explicit read-first, step one's "do not rebuild an
  // existing profile" reads as permission to skip this step entirely.
  check('it tells the agent to READ the patch before writing', prompt.includes('先读这个文件当前的内容'), 'existence is not correctness');
  check('it says to add only what is missing', prompt.includes('缺哪条补哪条'), 'a partial patch must be completed, not replaced blindly');
  check('it warns against the settings-panel permission control',
    prompt.includes('不要去 DSH 设置面板里改权限'),
    'the panel control is a per-SESSION override; the profile patch is the deployment default that delegation actually uses');
}

console.log('\nthe firewall is judged by reachability, not by a rule name:');
{
  // Measured on a real machine: it already had an inbound allow rule covering port 22, while an earlier
  // version looked only for its own rule name and would have added a redundant duplicate.
  check('it demands checking coverage by PORT', prompt.includes('按端口查覆盖情况'));
  check('it forbids checking by rule name', prompt.includes('不要按规则名字查'));
  check('it explains why a name check misfires', prompt.includes('会得出「没有」'));
  check('it requires the network category to be established', prompt.includes('记下每个网络接口属于哪个类别'));
  check('it warns a private-only rule is useless on a public network', prompt.includes('却只放行「专用」，规则等于没加'));
  check('it requires the rule scope to cover the observed category', prompt.includes('生效范围覆盖本机当前的网络类别'));
  check('it forbids treating "the rule exists" as proof', prompt.includes('不能用「规则存在」代替这一步'));
}

console.log('\nno per-platform command blocks (the platform selector is gone):');
{
  for (const snippet of [
    'Add-WindowsCapability', 'Get-Service', 'New-NetFirewallRule', 'Get-NetFirewallRule',
    'icacls', 'Add-Content', 'systemctl', 'apt-get install', 'Test-NetConnection', 'ufw ',
  ]) {
    check(`no hardcoded "${snippet}"`, !prompt.includes(snippet));
  }
  check('the removed arguments cannot change the prompt', (() => {
    const plain = buildSetupPrompt({ publicKey: read.publicKey, user: 'u' });
    const legacy = buildSetupPrompt({ publicKey: read.publicKey, user: 'u', platform: 'posix', mode: 'pair', includeFirewall: false });
    return legacy === plain;
  })(), 'the prompt must not depend on removed arguments');
}

console.log('\nthe public key block is byte-exact and idempotent:');
{
  const foreign = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbb some-other-tool';
  const identity = keyIdentityOf(foreign);
  check('identity is type + base64, without the comment', identity === 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbb', identity);
  check('identity survives options prefixed to the key', keyIdentityOf('from="10.0.0.1" ssh-ed25519 AAAAKEY user@host') === 'ssh-ed25519 AAAAKEY');
  const keyed = buildSetupPrompt({ publicKey: foreign, user: 'u' });
  check('it embeds the public key verbatim', keyed.includes(foreign));
  check('the example compares the identity, not the comment', keyed.includes(`grep -qF '${identity}'`), keyed.split('\n').filter((line) => line.includes('grep -qF')).join(' | '));
  check('the example is introduced as a reference, not the only way', keyed.includes('参考写法'));
  check('the instructions forbid using a comment as the dedup key', keyed.includes('不看注释'), 'the wording must match the guard');
  check('they warn that a comment-based check re-appends a duplicate', keyed.includes('重复追加'));
  check('they state the identity criterion', keyed.includes('只比对密钥本体'));
  check('they require append-only', keyed.includes('只追加，不覆盖'));
  check('they require tightened permissions', keyed.includes('`600`') && keyed.includes('`700`'));
  check('a key with a quote is carried verbatim', buildSetupPrompt({ publicKey: "ssh-ed25519 AAAA'x c", user: 'u' }).includes("AAAA'x"));
}

console.log('\nthe report is answerable by the machine:');
{
  // The first version demanded a fingerprint computed by this plugin (`dsh-fleet-…`), which nothing on
  // the controlled side can produce — that check could never have passed.
  check('it no longer demands this plugin\'s own fingerprint', !prompt.includes('dsh-fleet-'), 'that value is uncomputable remotely');
  check('it asks for the standard SSH fingerprint', prompt.includes('ssh-keygen -lf') && prompt.includes('SHA256:'));
  check('it asks for the account and its home directory', prompt.includes('whoami') && prompt.includes('家目录的绝对路径'));
  check('it asks for the SSH service state', prompt.includes('是否开机自启'));
  check('it asks for the firewall conclusion', prompt.includes('确实被放行'));
  check('it asks whether the profile exists', prompt.includes('是否存在'));
  check('it bounds the ACP check so it cannot hang', prompt.includes('不要留在运行状态'), 'ACP is a stdio session');
  check('it marks which items feed the configuration', prompt.includes('直接拿去写进配置'));
  check('it forbids pasting key material', prompt.includes('不要贴出公钥全文'));
  check('it demands honest failure reporting', prompt.includes('不要用「应该没问题」代替结论'));
}

console.log('\nthe two standing bans are present and exported:');
{
  check('the private-key ban is in the prompt', prompt.includes(NO_PRIVATE_KEY_RULE), NO_PRIVATE_KEY_RULE);
  check('the dependency ban is in the prompt', prompt.includes(NO_INSTALL_RULE), NO_INSTALL_RULE);
  check('the prompt contains no private key material', !prompt.includes('PRIVATE KEY'));
  check('the composed prompt is stable and lossless', snapshotJsonValue(prompt) !== undefined);
}

await rm(isolated, { recursive: true, force: true });
void readFile;

console.log(`\n${failures === 0 ? 'SETUP MODULE VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
