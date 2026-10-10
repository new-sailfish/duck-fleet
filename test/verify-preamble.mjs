// The preamble is what every delegation carries in front of the task: the environment facts of that
// machine, the constraints derived from them, and the task-agnostic working rules. This suite pins the
// three properties that matter — the Windows block declares its own scope and branches on the
// PowerShell generation rather than assuming one, the task-agnostic layer survives on a machine that is
// not Windows, and `none` really does send nothing.
import { machineToolDefinition } from '../lib/fleet.js';
import { composeRemotePrompt, preambleFor } from '../lib/preamble.js';
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

const TASK = '把 D:\\work\\demo 下的文件按扩展名分类。';
const windows = preambleFor({ platform: 'windows' });

check('windows: declares its own scope', windows.includes('本节仅适用于 Windows'));
check('windows: sends the reader to check its own PowerShell generation', windows.includes('$PSVersionTable.PSVersion.Major'));
check('windows: branches the encoding rule for 5.1', windows.includes('【5.1】'));
check('windows: branches the encoding rule for 7+', windows.includes('【7+】'));
check('windows: forbids the assignment Defender deletes', windows.includes('永不写 .LastWriteTime'));
check('windows: keeps the loader-shape ban', windows.includes('加载器特征'));
check('windows: says which host decides, not which session', windows.includes('实际执行脚本的那个宿主'));
check('windows: carries the task-agnostic rules too', windows.includes('工作通则'));

const posix = preambleFor({ platform: 'posix' });
check('posix: drops the Windows block', !posix.includes('本节仅适用于 Windows'));
check('posix: drops the PowerShell branch', !posix.includes('【5.1】'));
check('posix: keeps the working rules', posix.includes('工作通则'));

check('none: sends no preamble at all', preambleFor({ platform: 'none' }) === '');
check('none: hands the task through byte-identical', composeRemotePrompt({ platform: 'none' }, TASK) === TASK);

const composed = composeRemotePrompt({ platform: 'windows' }, TASK);
check('composed: preamble comes before the task', composed.indexOf('本节仅适用于 Windows') < composed.indexOf(TASK));
check('composed: separates preamble from task with a marker', composed.includes('【任务】'));
check('composed: ends with the task verbatim', composed.endsWith(TASK));
check('composed: a missing platform is treated as windows', composeRemotePrompt({}, TASK).includes('本节仅适用于 Windows'));

check('record: a new machine defaults to the windows preamble', normalizeMachine({ id: 'b', host: 'h', user: 'u' }).platform === 'windows');
check('record: the platform value is case-normalized', normalizeMachine({ label: 'B', host: 'h', user: 'u', platform: 'POSIX' }).platform === 'posix');
let rejected = false;
try {
  normalizeMachine({ label: 'B', host: 'h', user: 'u', platform: 'linux' });
} catch {
  rejected = true;
}
check('record: an unknown platform is refused, not silently downgraded', rejected);

// The wiring, not just the text: a preamble module that nothing sends would pass every check above.
console.log('\nthe delegation tool actually sends it:');
{
  const exec = { agent: { id: 's1' }, signal: new AbortController().signal };
  const sent = [];
  const deps = {
    subagents: {
      start: async (provider, spec) => {
        sent.push({ provider, spec });
        return { id: 'run-1', localAgent: undefined, result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }), dispose: async () => {} };
      },
    },
  };

  const machine = normalizeMachine({ id: 'b', label: 'Laptop', host: '192.168.1.10', user: 'dev' });
  await machineToolDefinition(deps, machine).execute({ description: 'verify', prompt: TASK }, exec);
  const text = sent[0]?.spec?.prompt?.[0]?.text;
  check('the tool sends exactly what composeRemotePrompt builds', text === composeRemotePrompt(machine, TASK), String(text).slice(0, 90));
  check('the task stays verbatim at the end', String(text).endsWith(TASK), String(text).slice(-60));

  const bare = normalizeMachine({ id: 'c', label: 'Box', host: '192.168.1.10', user: 'dev', platform: 'none' });
  sent.length = 0;
  await machineToolDefinition(deps, bare).execute({ description: 'verify', prompt: TASK }, exec);
  check('a none machine sends the task unchanged', sent[0]?.spec?.prompt?.[0]?.text === TASK, String(sent[0]?.spec?.prompt?.[0]?.text).slice(0, 90));
}

console.log(`\n${failures === 0 ? 'PREAMBLE OK' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
