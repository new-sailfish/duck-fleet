/**
 * The text that travels in front of every delegated task.
 *
 * A remote agent starts a fresh session on another machine and inherits none of the conversation that
 * produced the task. Every pitfall this fleet has actually hit — a Defender heuristic that deletes a
 * script over a single timestamp assignment, PowerShell 5.1 reading a BOM-less file as ANSI, a
 * `python` that is a Store stub returning exit 9009 — would otherwise be rediscovered by every
 * delegation, one failed run at a time.
 *
 * Three layers, and the boundary between them is the point:
 *
 * - L1 environment FACTS ({@link WINDOWS_FACTS}): what that machine is like. Concrete by necessity.
 * - L2 constraints DERIVED from L1 ({@link WINDOWS_RULES}): what to do about it. Concrete, or it
 *   cannot be followed.
 * - L3 WORKING RULES ({@link WORKING_RULES}): true on any machine, for any task. Deliberately
 *   generic — a rule that holds for only one task belongs in that task, not here. Putting a task's
 *   own criteria in this layer is the mistake this split exists to prevent.
 *
 * Two rules keep the text honest, and both were learned by violating them:
 *
 *   1. A machine-specific measurement is never written as a fleet-wide fact. `platform` is a
 *      per-machine declaration while this text is one shared document, so anything that depends on
 *      the PowerShell generation is written as a BRANCH the reader resolves on its own machine.
 *   2. The block declares its own scope ("本节仅适用于 Windows") instead of asking the reader to
 *      verify it. Stating the boundary is information; delegating the check is not.
 *
 * Every entry must be able to answer three questions: what pitfall it came from, why it happens, and
 * what to do instead. An entry that cannot is noise that dilutes the ones that can.
 *
 * The payload is Chinese because this fleet's operators and delegations are Chinese, matching how
 * `prompt-sections.js` writes the controlled-side setup prose.
 *
 * @module dsh-fleet/preamble
 */

/** L1 + L2 for a controlled machine running Windows. */
const WINDOWS_FACTS = [
  '【环境与工作规范 · 由主控机自动附加，不属于任务本身】',
  '',
  '本机是 Windows 被控机，本节仅适用于 Windows。标了【5.1】或【7+】的条目只在你所处的 PowerShell 版本',
  '成立；没标的与版本无关。动手前先用 $PSVersionTable.PSVersion.Major 确认自己在哪个版本。',
  '',
  '环境事实',
  '- 中文 Windows；路径常含中文与空格，一律用绝对路径并正确加引号。',
  '- 同一台机器上可能同时存在两代 PowerShell：powershell.exe 是 5.1，pwsh.exe 是 7+。',
  '  规则跟的是【实际执行脚本的那个宿主】，不是你会话所在的宿主：从 pwsh 里调用 powershell.exe，',
  '  跑起来的仍然是 5.1。',
  '- Defender 实时防护扫描的对象包括【命令行的文本内容和脚本内容】，不只是文件；命中后动作是删除。',
  '- 经 SSH → DSH → 子进程这条链跑命令时，子进程的 stdio 管道受沙箱限制。',
  '- python 可能是 Microsoft Store 占位程序（静默返回 exit 9009，无任何输出）；不要假定存在',
  '  python / pypdf / pdftotext / node，用之前先探测。',
].join('\n');

/** L2: the derived constraints. Each one follows from a fact above. */
const WINDOWS_RULES = [
  '硬性约束',
  '1. 脚本先落盘成 .ps1，再用 -File 调用；不要把多行脚本塞进 -Command "<一大坨>" ——',
  '   被判定为风险的正是那段命令行文本。执行策略若是 Restricted/Undefined，加 -ExecutionPolicy Bypass；',
  '   并按你实际用的宿主（powershell.exe 还是 pwsh.exe）套用第 4 条的编码要求。',
  '2. 永不写 .LastWriteTime / .CreationTime / .LastAccessTime 的赋值：会被判为',
  '   Trojan:PowerShell/Timestomp.A 并删除。需要保留原始时间，就把它记进产物文件。',
  '3. 不要在脚本或命令行里写加载器特征：整文件读入内存后解压、长 base64、运行时拼接命令再执行。',
  '4. 落盘文件的编码按版本分支：',
  '   【5.1】.ps1 必须带 UTF-8 BOM —— 无 BOM 时按系统 ANSI 码页解码，中文注释变乱码并直接语法错误。',
  '   【7+】脚本默认按 UTF-8 读取，BOM 可以不写（写了也无害）。',
  '   两种版本下，要交给 Excel 打开的 CSV 都必须带 BOM；写文件时显式指定编码，不要依赖默认值',
  '   （5.1 的 > 与 Out-File 默认写 UTF-16LE）。',
  '5. 按字节操作的开关在两代之间改过名：【5.1】用 Get-Content -Encoding Byte，Format-Hex 没有 -Count；',
  '   【7+】用 Get-Content -AsByteStream，Format-Hex 有 -Count。要跨版本跑的脚本两者都得兼容。',
  '6. 不动杀软：不加排除项、不关防护、不提交样本。路径排除对内容扫描无效。',
  '7. 判断"有没有被拦"要看计数：动作前后各记一次检测条数与拦截事件条数，比对增量；',
  '   不要用"这次没报错"当结论。',
  '8. 子进程报 EPERM 时不要换写法重试 —— 那是沙箱对 stdio 管道的限制，不是杀软行为；',
  '   改成 -File 加"输出到文件再读"。',
].join('\n');

/** L3: task-agnostic, machine-agnostic. Nothing task-specific may enter this list. */
const WORKING_RULES = [
  '工作通则',
  'A. 不确定就上报，不要补全：缺少确凿依据的取值，不要用"看起来合理"的值填上；把它隔离出来、',
  '   标注你掌握的线索，交给主控判断。',
  'B. 破坏性操作先自证正确：先打印解析后的真实目标路径 → 确认处理范围内没有预期外的内容 →',
  '   确认结果或备份已通过校验，然后才执行。',
  'C. 结论必须可复核：给判断时附上可验证的证据（真实输出、文件清单、校验值），不要只给结论。',
  'D. 只改任务指定的范围；不动机器上其他既有数据，边界不清就停下来问。',
  'E. 会被重复执行的脚本必须幂等：重跑不产生重复、不覆盖已有结果、不因已有产物而改变行为。',
].join('\n');

/** The line that separates the preamble from the task. */
const TASK_MARKER = '【任务】';

/**
 * The preamble for one machine, or `''` when that machine should receive none.
 *
 * @param machine - a normalized machine record; reads `platform` only.
 * @returns the preamble text, without the task.
 */
export function preambleFor(machine) {
  const platform = typeof machine?.platform === 'string' && machine.platform !== ''
    ? machine.platform
    : 'windows';
  if (platform === 'none') return '';
  const blocks = platform === 'windows' ? [WINDOWS_FACTS, WINDOWS_RULES, WORKING_RULES] : [WORKING_RULES];
  return blocks.join('\n\n');
}

/**
 * Attach the preamble to a delegated task.
 *
 * One text block, not two: a consumer that joins multiple blocks has to invent a separator, and the
 * boundary between "environment notes" and "the task" is exactly what must stay visible.
 *
 * @param machine - the machine being delegated to.
 * @param task - the caller's prompt, verbatim.
 * @returns what is actually sent.
 */
export function composeRemotePrompt(machine, task) {
  const preamble = preambleFor(machine);
  if (preamble === '') return task;
  return `${preamble}\n\n${TASK_MARKER}\n\n${task}`;
}
