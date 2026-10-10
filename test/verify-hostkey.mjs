// Refusing forever on a host key that changed is not a security posture, it is a dead end.
//
// Reported from a real machine: every test failed with a bare `exit code: 255`, and the reason ssh gave —
// `Host key verification failed` — was printed on stderr and thrown away. The cause was legitimate: a reboot
// replaced a portable user-level `sshd` with the system service, and the host key changed with it. ssh refuses
// that, so the machine stayed unreachable until somebody ran `ssh-keygen -R` by hand.
//
// The two pure pieces are tested here, against the exact text ssh produces, because recognising the failure is
// what makes recovery possible at all: if the detector misses, nothing else in the path is reached.
import { forgetHostKeyArgv, isHostKeyMismatch, machineTarget } from '../lib/fleet.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

// Copied from the real output of `ssh` against that machine, not paraphrased.
const REAL_CHANGED = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
  'The fingerprint for the ED25519 key sent by the remote host is',
  'SHA256:/E9hJlbJSfRjWnDWp7HsXk4KQY/q5QX4ZlmiIo8Rngg.',
  'Offending ECDSA key in C:\\Users\\larry/.ssh/known_hosts:17',
  'Host key for 192.168.3.172 has changed and you have requested strict checking.',
  'Host key verification failed.',
].join('\n');

console.log('\nrecognising the one failure that can be recovered from:');
{
  check('the real message is recognised', isHostKeyMismatch(REAL_CHANGED) === true);
  // Both halves are matched on their own: some ssh builds emit the tail without the banner.
  check('the banner alone is enough', isHostKeyMismatch('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!') === true);
  check('the verdict alone is enough', isHostKeyMismatch('Host key verification failed.') === true);
  // A changed key is a special case, NOT "any transport failure": every other failure must keep its own path.
  check('a refused key is not a changed key', isHostKeyMismatch('Permission denied (publickey).') === false);
  check('a timeout is not a changed key', isHostKeyMismatch('ssh: connect to host 192.168.3.172 port 22: Connection timed out') === false);
  check('a reset is not a changed key', isHostKeyMismatch('kex_exchange_identification: read: Connection reset') === false);
  check('a missing binary is not a changed key', isHostKeyMismatch('spawn ssh ENOENT') === false);
  check('an empty message is not a changed key', isHostKeyMismatch('') === false);
  check('undefined is not a changed key', isHostKeyMismatch(undefined) === false);
}

console.log('\nthe command that forgets it:');
{
  // `ssh-keygen -R` rather than editing the file: it knows the hashed-name format and removes every key type for
  // that host in one pass. Measured — it reported three lines for this machine (ed25519, rsa, ecdsa).
  check('a default-port host is named plainly', JSON.stringify(forgetHostKeyArgv('ssh-keygen', '192.168.3.172', 22))
    === JSON.stringify(['ssh-keygen', '-R', '192.168.3.172']));
  // A non-default port is a different entry in known_hosts, written in bracket form.
  check('a non-default port uses the bracket form', JSON.stringify(forgetHostKeyArgv('ssh-keygen', 'h.example', 2222))
    === JSON.stringify(['ssh-keygen', '-R', '[h.example]:2222']));
  check('a missing port is treated as the default', JSON.stringify(forgetHostKeyArgv('ssh-keygen', 'h.example', undefined))
    === JSON.stringify(['ssh-keygen', '-R', 'h.example']));
  // The controller can be pointed at its own file, so a global known_hosts is never the only place this can work.
  check('a specific file can be targeted', JSON.stringify(forgetHostKeyArgv('ssh-keygen', 'h.example', 22, 'C:/x/known_hosts'))
    === JSON.stringify(['ssh-keygen', '-R', 'h.example', '-f', 'C:/x/known_hosts']));
  // The executable is passed through, so a settings-configured ssh directory is honoured.
  check('the executable is passed through', forgetHostKeyArgv('C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe', 'h', 22)[0]
    === 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe');
}

console.log('\nthe target string stays what the panel and tools show:');
{
  check('a default port is omitted', machineTarget({ user: 'u', host: 'h', port: 22 }) === 'u@h');
  check('a non-default port is shown', machineTarget({ user: 'u', host: 'h', port: 2222 }) === 'u@h:2222');
  // The reported machine carried a domain-qualified account, which must survive verbatim.
  check('a qualified account survives', machineTarget({ user: 'cursor\\cursorbot', host: '192.168.3.172', port: 22 }) === 'cursor\\cursorbot@192.168.3.172');
}

console.log(`\n${failures === 0 ? 'HOST KEY RECOVERY VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
