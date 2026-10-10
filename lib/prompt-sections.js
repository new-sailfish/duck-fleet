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
 * ## `{CONTROLLER}` may be UNKNOWN, and that is a normal state
 *
 * The account lives on the controlled machine, and the prompt already makes that machine verify it and
 * report back — so the controller does not need to know it in advance. When it does not, `{CONTROLLER}`
 * is filled with {@link UNKNOWN_ACCOUNT} and the account step is reworded to start from discovery rather
 * than from a record to check.
 *
 * Both wordings come from this module so the prose and its tests share one source, and so neither can be
 * edited without the other being visible next to it.
 *
 * @module dsh-fleet/prompt-sections
 */
import { ADDRESS_RULE, NO_INSTALL_RULE, NO_PRIVATE_KEY_RULE } from './prompt-rules.js';

/**
 * The address rule, in the two forms the two prompts need.
 *
 * The rule exists because the address a machine reports about ITSELF is the one field the controller cannot
 * verify, and the one whose failure says nothing: a machine with a VPN reports the tunnel address first, and
 * the controller then records an address that only works from inside that tunnel.
 *
 * The two forms differ in whether the controller's own address is known. The SERVED prompt always knows it —
 * the machine fetched the prompt from it. A COPIED prompt does not, and there is no honest way to fill it in:
 * the machine cannot discover which subnet the controller is on, and "ping an empty string" is not a rule
 * anybody can follow. So that form drops the comparison and the ICMP step and keeps the exclusions, which are
 * the part that does not depend on knowing anything.
 */
export const ADDRESS_RULES_SERVED = `**地址挑选规则（照做）：**

1. **排除虚拟网卡**：VPN 与隧道接口一律不报 —— 接口名形如 \`tun\`、\`tap\`、\`utun\`、\`wg\`、\`ppp\`、\`ipsec\`、\`docker\`、\`veth\`、\`br-\`、\`vmnet\`、\`vboxnet\`，以及 APIPA 的 \`169.254.*\`。
   这些地址对主控机通常**根本不可达**，却在列表里往往排在前面。
2. **优先与主控机同网段**的地址：主控机的地址是 \`{CALLBACK_HOST}\`。与它前三段相同（同一个 /24）的那个地址就是首选。
3. **同网段有多个、或没有任何一个同网段时**，用 ICMP 实测（\`ping {CALLBACK_HOST}\`）—— **只有回应的那个网段才可用**；报一个 ping 不通的地址等于报了个死地址。
   地址族要一致：\`{CALLBACK_HOST}\` 是 IPv4，就用 IPv4 去试。
4. 全都不通时**如实说"没有任何地址能确认到达主控机"**，把候选列出来由主控机决定。
`;

export const ADDRESS_RULES_COPIED = `**地址挑选规则（照做）：**

1. **排除虚拟网卡**：VPN 与隧道接口一律不报 —— 接口名形如 \`tun\`、\`tap\`、\`utun\`、\`wg\`、\`ppp\`、\`ipsec\`、\`docker\`、\`veth\`、\`br-\`、\`vmnet\`、\`vboxnet\`，以及 APIPA 的 \`169.254.*\`。
   这些地址对主控机通常**根本不可达**，却在列表里往往排在前面。
2. **不要猜哪个"最可能"，也不要 ping。** 这段提示词里没有主控机的地址，你无从判断哪个与它同网段，也没有可 ping 的目标 ——
   所以：**排除虚拟网卡后，把剩下的地址连同各自的接口名一起报出来**，由主控机挑。
`;

/**
 * Step: the callback channel, present only in the prompt served over the LAN.
 *
 * A machine that fetched its prompt from an address can report back to an address, and that is the difference
 * the operator feels: the panel fills in while the work happens, instead of showing nothing until it is over.
 * The copied prompt has no callback — there is nothing listening — so this section is added only when a
 * callback exists, rather than telling a machine to report into nowhere.
 *
 * The stage names are the panel's, not the machine's: the panel draws its list before anything is reported, so
 * a machine that invented its own names would leave the panel unable to tell a finished run from a stalled one.
 */
export const REPORTING_STEP = `## 步骤 0：先看清汇报方式（本步在开工前完成）

你不是在孤立地干活：主控机在等你的进度。**开工前先把汇报通道打通**，之后每完成一步就汇报一次。

**汇报地址**：\`{CALLBACK_URL}\`
**汇报令牌**：\`{CALLBACK_TOKEN}\`
每一次汇报都要带上请求头 \`X-Fleet-Token: {CALLBACK_TOKEN}\`。

**先验证通道再开工。** 用一次实验性汇报确认能通（\`stage: "sshd"\` 留到最后真正做完那步再报，这里用一次读请求即可）：

\`\`\`sh
curl -s -H 'X-Fleet-Token: {CALLBACK_TOKEN}' {CALLBACK_URL}
\`\`\`

返回 \`{"ok":true,...}\` 说明通道通；连不上就**立刻停下并报告**（在主控机那边的界面上说明），
不要闷头把活干完 —— 干完了却汇报不回去，主控机什么也看不到。

**固定六个阶段，名字必须逐字照用**，因为主控机的界面是按这六个画的：

| 阶段名 | 对应 |
|---|---|
| \`sshd\` | 步骤 1：SSH 服务与登录账号 |
| \`firewall\` | 步骤 2：防火墙 |
| \`profile\` | 步骤 3：\`acp\` profile |
| \`key\` | 步骤 4：安装公钥 |
| \`verify\` | 最后验证（\`dsh --profile acp\` 起得来） |
| \`done\` | 全部完成，带上最终配置 |

**每一阶段完成后汇报一次**，用 POST：

\`\`\`sh
curl -s -X POST {CALLBACK_URL} \\
  -H 'X-Fleet-Token: {CALLBACK_TOKEN}' \\
  -H 'Content-Type: application/json' \\
  -d '{"stage":"sshd","state":"ok","detail":"本机原本没有 SSH 服务端，已安装并设为自启"}'
\`\`\`

\`state\` 只能是这三种，含义要如实：

- \`ok\` —— 这一步做了实际改动（或确认已满足后无需改动）；
- \`skipped\` —— 本机本来就满足，什么都没做；
- \`fail\` —— 这一步没做成。**带上 \`error\` 字段**说明卡在哪，然后**可以停下来**。

\`detail\` 用一句话写清你**实际做了什么或发现了什么**（例如"已有 OpenSSH-Server-In-TCP 规则覆盖 22，未新增"），
主控机的界面上会原样显示这句，所以它比状态值更有用。

**最后一步 \`done\` 要把配置一起带上**，格式见文末；主控机收到它就自动把这台机器加进配置，**你不需要再说"请添加"**。`;

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

/**
 * Step: SSH service usable, and the login account settled before anything depends on it.
 *
 * The account paragraph is `{ACCOUNT_STEP}` rather than fixed prose, because the controller may not know the
 * account yet — see {@link ACCOUNT_KNOWN} and {@link ACCOUNT_UNKNOWN}. Everything else in the step is the
 * same either way: the account has to be settled before the key and the profile can be installed, and the
 * failure mode when it is not is that both land under the wrong account and login still does not work.
 */
export const SSHD_STEP = `## SSH 服务与登录账号

本步有两个目标，缺一不可：让本机的 SSH 服务可供主控机登录，以及**定下主控机该用哪个账号登录**。第二条不落实，后面几步都可能白做。

**先查后动**：以下四项逐项查清，已经满足的不要重复配置，只记下结论。

**一、SSH 服务端已安装。** 确认本机装的是 SSH 服务端，而不是只有客户端。

**二、正在运行，且开机自启。** 运行状态决定现在能否登录，开机自启决定本机重启后还能否登录 —— 只配前者，一重启主控机就连不上，而这类失效当时看不出原因。

**三、监听 {PORT} 端口。** 主控机会连这个端口。服务端实际监听的是别的端口时，两边对不上，主控机连不进来 —— 这时把实际情况报上来，由主控机决定是改端口还是改本机。

{ACCOUNT_STEP}`;

/**
 * The account paragraph when the controller already knows which account it intends to use.
 *
 * The value is still a claim to verify: the controller wrote it down, and only this machine can say whether
 * it is true.
 */
export const ACCOUNT_KNOWN = `**四、账号核实（本步的重点）。** 主控机配置里记的登录账号是 \`{CONTROLLER}\`，那只是**它单方面的记录，不是事实**。请核实两件事：本机是否真有这个账号；本机的 DSH 当前以哪个账号在运行（\`whoami\` 的结果）。另外，主控机要在这个账号下执行 \`dsh --profile acp\`，所以登录账号应当是 **DSH 所在的那个账号**。

核实后的处理：

- **两者一致**：确认该账号能接受 SSH 登录，本步通过，继续往下的步骤。
- **\`{CONTROLLER}\` 在本机不存在，或与 DSH 所在账号不一致**：**这里是唯一要停的地方** ——
  停下来把实际情况报告给主控机并**等它回话**，因为接下来装公钥要用哪个账号，取决于它怎么改记录
  （是记录写错了，还是本机该建那个账号）。**不要自行挑一个账号往下装。**
  主控机这边只需改一个字段就能重新派活；它需要的只是你准确报出实际情况。

> **注意与「未知账号」那种情形的区别**：那种情形下账号由本机说了算，核实完就继续；
> 这里停，是因为存在一个**与事实冲突的已有记录**，而那个冲突只有主控机能裁定。`;

/**
 * The account paragraph when the controller does NOT know the account yet.
 *
 * This is the normal case for a machine that has not been added: the account lives here, so this machine is
 * the only party that can name it. The controller therefore asks for a report instead of asserting a value —
 * which is the whole reason the account is settled in this step rather than assumed up front.
 *
 * It is deliberately NOT a placeholder account name. An earlier version filled one in, and the machine did
 * the sensible thing with it: it stopped and asked. That is a wasted round trip, and worse, a fabricated
 * value is indistinguishable from one somebody actually typed.
 */
export const ACCOUNT_UNKNOWN = `**四、定下登录账号（本步的重点）。** 主控机**还不知道**该用哪个账号 —— 账号在本机，只有本机能说了算。请查清这三件事：

1. 本机有哪些可登录的账号；
2. 本机的 DSH 当前以哪个账号在运行（\`whoami\` 的结果）；
3. 该账号的家目录绝对路径。

**为什么是「DSH 所在的那个账号」**：主控机以后要在这个账号下执行 \`dsh --profile acp\`。
**你现在就是在那个账号下运行**（这段提示词是 DSH 跑起来的），所以答案就是你现在这个账号 ——
这正是为什么后面的公钥和 profile 用 \`~\` 装到自己名下就一定是对的：
**你装不到别的账号上去，除非你特意去换一个。所以不要换。**

**不要把「确认账号」当成一道要等的关卡。** 这一步只是把你是谁**记下来**，供最后回报；
本步核实完就继续往下走，公钥和 profile 都用你自己的账号（\`~\`）。
在这里等待主控机回话会把流程断在中间，公钥就永远装不上了 —— 而装公钥才是这个提示词的目的。
账号最终由主控机核对，它需要的只是一个准确的答案。`;

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

**第二步：写 \`~/.dsh/profiles/acp/cordis.patch.yml\`。这一步不能省，而且要先检查。**

**先读这个文件当前的内容。** 第一步说的「已存在就不要重建」只保证 profile 能起来，**不保证里面的配置是对的** —— 手工建的老 profile 往往能正常启动，但 patch 还是模板里那个空的 \`[]\`，于是它"能连上、能对话，什么命令都执行不了"。所以：**缺哪条补哪条**，不要因为「文件存在」就跳过。

这个 profile 唯一的用途是接受主控机派来的任务，跑在由 ssh 拉起的无人值守会话里。**默认的沙箱模式在这种会话下会让子进程创建失败**（Windows 上表现为 \`0xC0000142\` / \`STATUS_DLL_INIT_FAILED\`，连 \`Write-Output\` 都起不来）。

文件要**同时**含下面两条（原有的注释头可以保留，**空的 \`[]\` 必须被这些条目替换**）：

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

**不要去 DSH 设置面板里改权限。** 面板里的权限选项是**每会话**的覆盖，而这里配的是**这个 profile 的部署默认值** —— 配置写的这一层才是委派真正走的那一层，面板那一层管不到主控机派来的会话。把配置写对就够了。

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

**目标**：把主控机那把公钥装进**上一步定下的那个账号**名下的 \`authorized_keys\`，让主控机以后以**那个账号**SSH 登录，不用密码。

**授权是「账号级」的，不是「机器级」的** —— 这一点必须清楚：公钥放进谁的 \`authorized_keys\`，主控机就能以**谁的身份**登录。
放在 A 下，主控机就只能登进 A；\`B@本机\` 用同一把私钥会被拒（\`Permission denied\`）。
所以**装到别的账号不是「等于没装」，而是「授权给了另一个账号」** —— 一样是错的，而且更容易被忽略：
主控机会以那个账号登进来，看起来连上了，但 \`dsh\`、家目录、profile 全都不在你以为的地方。

同一把私钥可以用在**很多台机器**上（本机并不独占它），但在**同一台机器上只对应一个账号**。
主控机派活时会写成 \`账号@本机\`，那个「账号」就是这里要装对的这个。

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

下面前三项主控机会**直接拿去写进配置**，必须准确：

1. **机器名**：本机的主机名。
2. **账号、家目录与 SSH 端口**：你现在以哪个账号在运行（\`whoami\` 的结果）、该账号家目录的绝对路径（不要写 \`~\`）、以及 SSH 服务实际监听的端口。主控机会**按你报的内容改配置** —— 你报哪个账号、哪个端口，它以后就照这个连本机；\`{CONTROLLER}\` 和 \`{PORT}\` 都只是它原来的记录，对不上以你报的为准。
   **另外说明公钥装到了哪个账号名下**（就是你装的那个 \`~/.ssh/authorized_keys\` 属于谁）。它应当和上面报的账号**是同一个**；如果不是，直接说明哪个是哪个 —— 那是主控机最需要知道的一种不一致。
3. **dsh 可执行文件的绝对路径（必须准确）**：主控机以后要用它启动本机的 agent，而它是在**非交互式会话**里执行的 —— 那种会话的 PATH 很短，往往找不到一个裸的 \`dsh\`。请报**你此刻正在运行的 dsh 的绝对路径**（Windows 上通常形如 \`…\\resources\\runtime\\cli\\bin\\dsh.cmd\`），不要写 \`dsh\` 了事。查不到确切路径就说明查不到，不要猜一个。
4. **独立工作目录（workspace）**：主控机派活时会让本机的 agent 在**一个专用目录**里干活，而不是混进别的项目。
   请**创建**这个目录（建议本机家目录下的 \`.dsh-fleet-workspace\`，例如 Windows 上 \`C:\\Users\\<账号>\\.dsh-fleet-workspace\`），
   并把**它的绝对路径**报回来 —— 这个值会写进主控机的配置，所以必须是**已存在**的绝对路径，不要写 \`~\`。
   已存在就沿用，不要清空里面的内容。
5. **SSH 服务状态**：服务端是否已安装、是否在运行、是否开机自启。分别给结论。
6. **防火墙结论**：本机当前的网络类别（Windows 的公用/专用/域，Linux 的默认入站策略），以及 SSH 端口入站**确实被放行**的结论。要的是「连得进来」，不是「加过规则」。
7. **\`acp\` profile**：\`~/.dsh/profiles/acp\` 是否存在，以及它是否确实是提供 ACP 的那个 profile。
8. **钥匙指纹**：用标准 SSH 工具（OpenSSH 的 \`ssh-keygen -lf\`）对刚装进去的那把公钥算出的 \`SHA256:…\` 指纹 —— 主控机拿它核对装的确实是同一把钥匙。
9. **能否起来**：\`dsh --profile acp\` 起一次看结果。它会等 stdin 输入，**确认能起来就立刻结束它，不要留在运行状态**；起不来就报错在哪。
10. **没做成的部分**：哪一步没做成，直说是哪一步、卡在哪。不要用「应该没问题」代替结论。

### 最后：把配置整好，输出三样东西

除了上面的逐项结论，**在回答的最后**再依次输出下面三样。它们说的是同一份配置，只是形式不同：
第一样给人看，第二样给表单的 JSON 视图粘贴，第三样直接调用工具。
**三样的值必须完全一致** —— 不一致比只有一样更糟，因为主控机不知道信哪个。

**第一样：每一个表单要填的值。** 逐项列出，一行一项，写成 \`字段 = 值\`：

\`\`\`
label         = <本机主机名>
host          = <见下方警示>
user          = <whoami 的结果>
port          = <SSH 实际监听的端口>
remoteCommand = <第 3 项报的 dsh 绝对路径>
\`\`\`

只列**确实有值**的字段；本机没有对应值的（比如某个可选字段查不到）就写 \`(未取到)\` 并说明原因，**不要编**。

**第二样：完整表单 JSON。** 就是上面那些字段组成的对象，供主控机直接粘进表单的 JSON 视图：

\`\`\`json
{
  "label": "<本机主机名>",
  "host": "<见下方警示>",
  "user": "<whoami 的结果>",
  "port": <SSH 实际监听的端口>,
  "remoteCommand": "<第 3 项报的 dsh 绝对路径>"
}
\`\`\`

**第三样：\`fleet_add\` 指令。** 同一份值，写成一次工具调用，主控机可以原样执行：

\`\`\`
fleet_add {"label":"<本机主机名>","host":"<见下方警示>","user":"<whoami 的结果>","port":<端口>,"remoteCommand":"<dsh 绝对路径>"}
\`\`\`

**关于 \`host\`，有一条你必须照做的警示**：你**不知道**主控机能不能连上哪个地址 —— 那是它那一侧的事，只有它能验证。所以：

- **先按下面的规则挑，再报**（规则本身就筛掉了最常见的错答案）；
- **明确标注这一个字段未经证实**，请主控机自己确认后再写入配置；
- 如果有多个地址，把它们**都列出来**并说明你推荐哪个、为什么，让主控机挑。

{ADDRESS_RULES}

不要把未经证实的 \`host\` 说成「已验证」。这一条比其余部分都重要：其余字段错了能从错误里看出来，\`host\` 错了只会表现为「连不上」。

**不要贴出公钥全文，也不要以任何形式贴出私钥或密钥文件内容。**`;
