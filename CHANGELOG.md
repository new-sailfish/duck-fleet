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

[0.1.0]: https://github.com/new-sailfish/duck-fleet/releases/tag/v0.1.0
