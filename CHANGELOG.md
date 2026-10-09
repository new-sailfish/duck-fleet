# Changelog

本文件记录 DuckFleet 的所有值得注意的改动。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.1.0] — 2026-10-08

首个发布版本。

### 新增

- **一处机器清单**：机器配置集中在 `$DSH_HOME/fleet.json`，不再需要为每台机器手写
  `cordis.patch.yml` 挂载行。
- **运行时注册**：加机器时插件在同一进程里立刻注册它的 ACP provider（`fleet-<id>`）和派活工具，
  不需要重启。改 `host` 一个字段即可换地址。
- **可视化设置页**：设置 → 鸭群。增删改机器、共享设置、点「测试」验证 SSH + ACP 握手。
- **自然语言派活**：插件往系统提示注册一段用法说明，模型据此把「某个 / 某几个 / 全部机器」
  映射到正确的工具。多台机器并发执行，长任务可 `run_in_background`。
- **被控机引导提示词**：`fleet_setup` 生成一段自包含的提示词，**由被控机上的 agent 自己执行**。
  它检查 SSH 服务、登录账号、防火墙的**端口覆盖情况**、`acp` profile（含沙箱配置）与公钥。
- **局域网分享配置提示词**：设置页可把提示词挂在一个短期 HTTP 地址上（4 位随机路径、
  限单台机器读取、自动关闭），方便你从别的设备取。
- **`fleet_test`**：只做 SSH + ACP 握手验证，**不消耗 token**。

### 说明

- 包名 `dsh-duck-fleet`，产品名 **DuckFleet**（中文名 **鸭群**）。
- 被控机**不需要**安装本插件 —— 它只需要 sshd、`dsh`，以及一个 `acp` profile。
- 工具名（`fleet_*`）与配置文件路径（`fleet.json`）是稳定接口，不会随品牌名改动。

---

## [0.2.0] — 2026-10-09

### 新增

- **会话清理（实验性，仅限 Windows）**：清理被控机上堆积的未分组会话。
  每次派活都会开一个新的 ACP 会话，而 ACP 那条路径**不把会话归入任何 workspace** ——
  它只带 `cwd`，从不调用 `workspace.attachSession` —— 于是全落进侧边栏的「未分组」里。
  主控机这边事后**没有办法挂载**（该操作既无 ACP 等价物也无 HTTP 路由），
  **归档是唯一可动的杠杆**。
  - 新增 `fleet_prune` 工具：`--inspect` 预演（只探测平台）、`--keep N` 指定保留数量、省略 `id` 则处理全部机器。
  - 新增 `/fleet/api/prune`，面板同源调用，两处共用同一份实现。
  - 流程：停被控机 DSH → 归档 → 在**交互式桌面**上自动重启。约 30 秒，期间该机器上的派活会中断。
- **`autoArchive` 共享设置**（`{ enabled, keepLast, maxAgeHours }`）：默认关闭。
  默认关闭是刻意的 —— 清理会停掉一台正在运行的应用，必须显式要求而不是被默认继承。
- **面板入口**：共享设置下方的虚线 **LAB 卡片**，含启用开关、保留数量与逐台「清理」按钮。
- **`sshShellArgv`**：一条在被控机上执行 **shell 命令**的 ssh 通道。
  它与 `sshArgv` 的区别是实质性的 —— 后者在远端启动的是 `dsh --profile acp`，
  所以附加的命令会被 **DSH CLI** 解析而不是 shell（实测：`cmd.exe /c echo %OS%` 得到
  `error: too many arguments`，`uname -s` 得到 `error: unknown option '-s'`）。

### 安全性

两条与**别人的数据**有关的性质，都写进了测试：

- **只归档「裸 UUID」会话**：ACP 建的会话 ID 是裸 UUID，DSH 界面建的是 `session-` 前缀。
  **只按目录名筛选是不够的** —— 被控机的 `cwd` 往往就是操作者自己也在用的目录，
  那样会连你自己的会话一起归档。
- **首次运行写备份**（`workspace.json.bak-before-archive`），且**后续运行不覆盖已有备份**；
  写入后重新解析并逐字比对每个 workspace 的标题。归档本身也可在侧边栏「已归档」里取消。

### 已知限制

- **仅限 Windows，且只在 Windows 上验证过。** macOS / Linux **直接拒绝**，不会尝试 ——
  两个环节都是平台相关的：注册表路径不同，而且停掉之后如何把 GUI 应用放回交互式桌面，
  Windows 用的是计划任务 + 交互式主体，POSIX 的等价做法**还没有写过**。
- 若 DSH 将来改了会话命名规则，或你在同一目录里手工建了裸 UUID 会话，它们会被当作派活会话归档。

### 说明

- 测试从 489 断言 / 13 套增加到 **544 断言 / 14 套**（新增 `test/verify-prune.mjs`）。
- 上述两条安全性质、平台门禁与 LAB 标注均**由断言钉住**：删掉它们，测试会红。

[0.2.0]: https://github.com/new-sailfish/duck-fleet/releases/tag/v0.2.0
[0.1.0]: https://github.com/new-sailfish/duck-fleet/releases/tag/v0.1.0
