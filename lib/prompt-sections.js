/**
 * The controlled-side setup prompt, as text.
 *
 * This is DATA, not logic: the assembler in `setup.js` owns variable filling, step numbering, and the
 * public-key block. Keeping the prose here means the words can be reviewed and revised without going
 * near the code that emits them.
 *
 * The document is addressed to the CONTROLLED machine's own DSH agent — the reader that is already
 * inside DSH on that machine. Three rules follow, and each has been violated at least once:
 *
 *   1. Never address the controller's operator. No "go install DSH Desktop", no "if you are actually
 *      in a terminal".
 *   2. Only one premise: DSH is installed, because that is how this text was read. Everything else —
 *      SSH, firewall, profile, and above all the account — is discovered by the machine itself.
 *   3. A value the controller wrote down is a claim to VERIFY, never a fact to act on. The earlier
 *      version announced "the controller will log in as <account>" and thereby ordered the machine to
 *      conform to an unverified record.
 *
 * The reader is referred to as 本机 and the other machine as 主控机. `{CONTROLLER}` is the account the
 * controller believes it will use, and it is flagged as unverified in every place it appears; `{PORT}`
 * is the SSH port the controller will actually connect to, so nothing here hardcodes 22.
 *
 * @module dsh-fleet/prompt-sections
 */
import { NO_INSTALL_RULE, NO_PRIVATE_KEY_RULE } from './prompt-rules.js';

/** Goal and the standing rules. No heading: this opens the prompt. */
export const GOAL = `目标：把本机接进主控机的 **DuckFleet**（鸭群）—— 一台主控机指挥的一群机器。配好之后，主控机会：

1. 用 ssh 登录本机（端口 {PORT}）；
2. 在本机执行 \`dsh --profile acp\`；
3. 通过这条连接把任务派给本机上的 agent。

这次连接要用主控机独有的私钥认证，公钥在最后一步给你。

别假设本机的现状：SSH、防火墙、profile、账号都要你自己查，下面说的都只是主控机那边的记录。

执行要求：

1. 先查再动：每项工作都先确认本机现状，再决定做不做。
2. 已满足就跳过：不重复添加，不改动无关配置。
3. 查到的和记录不一致时，先报告，不要将就着按记录做。
4. 只做本提示词交代的事，不顺手做额外的加固或优化。
5. 没做成的事如实说明卡在哪一步。

禁令：${NO_PRIVATE_KEY_RULE}；${NO_INSTALL_RULE}。`;

/** Step: SSH service usable, and the login account settled before anything depends on it. */
export const SSHD_STEP = `## SSH 服务与登录账号

本步有两个目标，缺一不可：让本机的 SSH 服务可供主控机登录，以及**定下主控机该用哪个账号登录**。第二条不落实，后面几步都可能白做。

**先查后动**：以下四项逐项查清，已经满足的不要重复配置，只记下结论。

**一、SSH 服务端已安装。** 确认本机装的是 SSH 服务端，而不是只有客户端。

**二、正在运行，且开机自启。** 运行状态决定现在能否登录，开机自启决定本机重启后还能否登录 —— 只配前者，一重启主控机就连不上，而这类失效当时看不出原因。

**三、监听 {PORT} 端口。** 主控机会连这个端口。服务端实际监听的是别的端口时，两边对不上，主控机连不进来 —— 这时把实际情况报上来，由主控机决定是改端口还是改本机。

**四、账号核实（本步的重点）。** 主控机配置里记的登录账号是 \`{CONTROLLER}\`，那只是**它单方面的记录，不是事实**。请核实两件事：本机是否真有这个账号；本机的 DSH 当前以哪个账号在运行。另外，主控机要在这个账号下执行 \`dsh --profile acp\`，所以登录账号应当是 DSH 所在的那个账号。

核实后的处理：

- 两者一致：确认该账号能接受 SSH 登录，本步通过。
- \`{CONTROLLER}\` 在本机不存在，或与 DSH 所在账号不一致：**停下来，先把实际情况报告给主控机，不要自行挑一个账号继续。** 公钥和 profile 都要落在某个账号名下，账号选错就会装到别处、登录仍然不通。是记录写错了还是本机缺账号，由主控机决定怎么改。`;

/**
 * Step: the firewall must actually let the controller in.
 *
 * The judgement is reachability, not the presence of a rule with a name this plugin chose. Measured on
 * a real machine: it already had an inbound allow rule covering port 22 (created when OpenSSH was
 * installed, scoped to any profile), while the first version of this step looked only for its own rule
 * name and would have added a redundant one — scoped to the private profile, on a machine whose
 * network is classified public, which is a no-op.
 */
export const FIREWALL_STEP = `## 防火墙

本步的目标是让主控机**真的连得进来**。「配过防火墙」和「主控机能连进来」是两件事，以第二件为准。先查后动，已满足就跳过，不重复添加、不改动无关规则。

**一、查清防火墙当前状态。** 服务在运行不等于规则已生效，两者分别确认并记下结论。Windows 上还要记下每个网络接口属于哪个类别（公用/专用/域），因为规则的生效范围按类别算；Linux 上记下当前的默认入站策略。

**二、查清是否已有入站规则覆盖 {PORT} 端口。按端口查覆盖情况，不要按规则名字查。** 名字不决定一条规则管不管 {PORT}：本机很可能已经有别的规则覆盖了它（装 SSH 服务端时自动创建的那条就是），按名字查会得出「没有」，进而加出一条多余的重复规则。

已有覆盖时，再核对这一条是否**入站、放行、TCP {PORT}，且生效范围覆盖本机当前的网络类别**。四项都成立，本步已满足，不要新增；任何一项不成立（例如规则被禁用），按下一条处理。

**三、没有覆盖时才新增。** 新规则要满足：方向入站、协议 TCP、端口 {PORT}、动作放行、**生效范围覆盖本机当前的网络类别** —— 本机当前是「公用」却只放行「专用」，规则等于没加。范围拿不准时取覆盖最广的那个。

**四、判据。** 规则加好后确认它已启用，并实际验证 {PORT} 端口连得进来；不能用「规则存在」代替这一步。连不上时，把规则名、当前网络类别、实际观察到的现象一并回报，不要就此收尾。`;

/** Step: the ACP profile the controller starts on this machine, including the delegation patch. */
export const PROFILE_STEP = `## 准备 \`acp\` profile（含委派专用配置）

**目标**：主控机会在本机执行 \`dsh --profile acp\`，所以本机要有一个以 stdio 方式提供 ACP、名字就叫 \`acp\` 的 profile，**并且这个 profile 要能在无人值守的会话里真正跑起命令**。

**第一步：profile 本身。**

先看 \`~/.dsh/profiles/acp\` 在不在（Windows 上对应当前账号家目录下的 \`.dsh\\profiles\\acp\`）。已经存在且能正常起来就不要重建；不存在才用随附模板创建：

\`\`\`sh
dsh --from-default-profile acp
\`\`\`

**退路**：这条命令不可用、或建出来的内容不对，就手工建 \`~/.dsh/profiles/acp/package.json\`，内容照抄：

\`\`\`json
{
  "name": "dsh-profile-acp",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] } }
}
\`\`\`

bundle 列表必须是这两个，不要加别的东西。

**第二步：写 \`~/.dsh/profiles/acp/cordis.patch.yml\`。这一步不能省。**

这个 profile 唯一的用途是接受主控机派来的任务，跑在由 ssh 拉起的无人值守会话里。**默认的沙箱模式在这种会话下会让子进程创建失败**（Windows 上表现为 \`0xC0000142\` / \`STATUS_DLL_INIT_FAILED\`，连 \`Write-Output\` 都起不来），于是「能连上、能对话，但什么命令都执行不了」。

要把该文件写成下面这样（文件里原有的注释头可以保留，**那个空的 \`[]\` 必须被这些条目替换**）：

\`\`\`yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
\`\`\`

为什么是这两条：

- \`sandbox-policy.mode\` 解除本机沙箱 —— 本机不需要给自己再套一层，受限模式在无人会话里是坏的；
- \`approval.policy: never\` 关掉审批往返 —— **这个会话对面没有人可以问**，问了只会白等一轮。授权与否由主控机那边决定，不在这里再问一次。

**第三步：验证（必做）。** 用模板或手工建的 profile **也要写这个 patch**，写完再验证：

\`\`\`sh
dsh --profile acp
\`\`\`

能起来（它会等 stdin 输入，能启动且不报错即可，验证完可以停掉）**并且**该会话里能正常执行命令，才算这一步通过。只验证「能启动」不够 —— 沙箱问题正是启动正常、执行必挂。`;

/**
 * Step: install the controller's public key into the verified account's authorized_keys.
 *
 * The dedup criterion is the KEY MATERIAL, not a comment: a key already on the machine carries whatever
 * comment its creator gave it, so a marker-based guard appends a second copy of the same key. Measured
 * on a real machine, where exactly that happened.
 */
export const KEY_STEP = `## 安装主控机的公钥

**目标**：把主控机那把公钥装进**上一步核实过的那个账号**名下的 \`authorized_keys\`，让主控机以后 SSH 登录不用密码。装到别的账号等于没装。

**只追加，不覆盖** —— 覆盖会把本机已有的密钥弄丢。

**判据：只比对密钥本体（类型 + base64 那段），不看注释。** 注释是任意的，本机已有的密钥完全可能带着别的注释；按注释判重会把同一把密钥重复追加。重复执行本步也不能追加第二遍。

下面是一段参考写法（POSIX），公钥本体已经填好；其他系统按同样的判据用你自己的方式：

\`\`\`sh
umask 077
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
if grep -qF '{KEY_IDENTITY}' ~/.ssh/authorized_keys; then
  echo "public key already present (nothing changed)"
else
  printf '%s\\n' '{PUBLIC_KEY}' >> ~/.ssh/authorized_keys
fi
chmod 600 ~/.ssh/authorized_keys
\`\`\`

权限必须收紧：\`.ssh\` 目录 \`700\`、\`authorized_keys\` \`600\`；Windows 上只允许当前账号读写。权限过宽时 sshd 会拒绝这个文件，登录照样不通。`;

/**
 * What the controller needs back.
 *
 * Every item must be something the machine can actually produce with standard tools. The first version
 * asked for a fingerprint computed by this plugin's own algorithm (`dsh-fleet-…`), which nothing on the
 * controlled side can calculate — that check could never have passed.
 */
export const REPORT = `## 回报

把主控机填配置、核对前几步结果所需的事实收齐并回报。**每一项都必须是你在本机能真实取到的值**；取不到就直说取不到，不要用推测值凑。

下面前两项主控机会**直接拿去写进配置**，必须准确：

1. **机器名**：本机的主机名。
2. **账号、家目录与 SSH 端口**：你现在以哪个账号在运行（\`whoami\` 的结果）、该账号家目录的绝对路径（不要写 \`~\`）、以及 SSH 服务实际监听的端口。主控机会**按你报的内容改配置** —— 你报哪个账号、哪个端口，它以后就照这个连本机；\`{CONTROLLER}\` 和 \`{PORT}\` 都只是它原来的记录，对不上以你报的为准。
3. **SSH 服务状态**：服务端是否已安装、是否在运行、是否开机自启。分别给结论。
4. **防火墙结论**：本机当前的网络类别（Windows 的公用/专用/域，Linux 的默认入站策略），以及 SSH 端口入站**确实被放行**的结论。要的是「连得进来」，不是「加过规则」。
5. **\`acp\` profile**：\`~/.dsh/profiles/acp\` 是否存在，以及它是否确实是提供 ACP 的那个 profile。
6. **钥匙指纹**：用标准 SSH 工具（OpenSSH 的 \`ssh-keygen -lf\`）对刚装进去的那把公钥算出的 \`SHA256:…\` 指纹 —— 主控机拿它核对装的确实是同一把钥匙。
7. **能否起来**：\`dsh --profile acp\` 起一次看结果。它会等 stdin 输入，**确认能起来就立刻结束它，不要留在运行状态**；起不来就报错在哪。
8. **没做成的部分**：哪一步没做成，直说是哪一步、卡在哪。不要用「应该没问题」代替结论。

**不要贴出公钥全文，也不要以任何形式贴出私钥或密钥文件内容。**`;
