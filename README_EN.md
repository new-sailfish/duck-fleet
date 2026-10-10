# DuckFleet

[中文](./README.md) | **English**

[![npm version](https://img.shields.io/npm/v/dsh-duck-fleet)](https://www.npmjs.com/package/dsh-duck-fleet)
[![License](https://img.shields.io/npm/l/dsh-duck-fleet)](./LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4dabf7)](https://github.com/new-sailfish/duck-fleet)
[![Listed on awesome-dsh-hub](https://img.shields.io/badge/Listed%20on-awesome--dsh--hub-4dabf7)](https://github.com/awesome-dsh-hub)

> One flock of machines, one command.

DuckFleet is a DSH plugin: install it once on the controller, bring several machines into one flock, and
**each machine gets its own delegation tool** — then you drive one, several, or all of them in natural
language.

```
You: have every machine report its current CPU and memory use

DuckFleet: → delegates to 3 machines concurrently → reports each result back
```

---

## What it provides

- The machine list lives in one place: `$DSH_HOME/fleet.json`, or the settings page.
- Adding a machine registers its ACP provider and delegation tool **immediately**, with **no restart**.
- Changing `host` is enough to move a machine; it re-registers at runtime.
- The controlled machine does **not** need this plugin: it needs sshd, `dsh`, and an `acp` profile.

---

## Installation

The plugin is installed **on the controller only**.

### From npm

```sh
dsh plugin --profile desktop add dsh-duck-fleet
```

### From a local checkout

```sh
git clone git@github.com:new-sailfish/duck-fleet.git
dsh plugin --profile desktop add /path/to/duck-fleet
```

`dsh plugin add` installs the package into the profile and syncs `dsh.profile.bundles`.

> **Restart DSH once after installing.**
>
> The panel is the **client half**, and a client plugin's bundle is built and cached when the
> **application starts** — so **refreshing the page does nothing**: a running process does not re-read the
> bundle from disk.
>
> The server half (the `fleet_*` tools, delegation) applies as soon as the plugin row reloads, so **the
> restart is only for the panel**.
>
> The test: **tools working means the server half is current; a stale panel means a restart is due.**

### Manual mounting (equivalent)

The profile's `package.json`:

```json
{
  "dependencies": { "dsh-duck-fleet": "link:/path/to/duck-fleet" },
  "dsh": { "profile": { "bundles": ["…", "dsh-duck-fleet"] } }
}
```

---

## Quick start

### 1. On the controller: install the plugin

After installation, the plugin:

- adds a **DuckFleet** page under **Settings**;
- registers a usage section in the system prompt, so the model knows how to address one, several, or all
  machines;
- registers its management tools (`fleet_list` / `fleet_add` / `fleet_test` / `fleet_setup` / …).

Open **Settings → DuckFleet**.

### 2. On the controlled machine: DSH is all it needs

| Needed | Why |
|---|---|
| sshd running | so the controller can ssh in |
| `dsh` installed | **the only assumption the prompt makes** |
| an `acp` profile | created by the prompt |
| the controller's public key | written by the prompt |

All four are **checked and set up by the controlled machine's own agent**, working from the prompt. You do
not configure any of it by hand.

### 3. Get the setup prompt

**Settings → DuckFleet → "Add machine" → "Get it automatically"**, then choose how to deliver it:

| Way | How | When to use it |
|---|---|---|
| **Copy and paste** | click **"Copy prompt"**, paste it into the controlled machine's DSH or terminal | you can operate that machine directly |
| **LAN link** | click **"Serve on the LAN instead"** to get an address like `http://192.168.1.10:<port>/abcd`, and **open it on the controlled machine** | the machine is not at hand |

You can also say, in any session: "use `fleet_setup` to generate the setup prompt, user `dev`, host
`192.168.1.10`".

**The LAN link is temporary**: it stays open only until the prompt is fetched, and closes on its own
within a minute. Its path is four random lowercase letters, and **only the machine that fetched it can
read it** (any other host gets a 403). It listens on this machine only and **never goes through any
external service**.

The prompt is self-contained: it makes the controlled machine's agent **check the current state before
changing anything** and install only what is missing, so the same prompt covers a brand-new machine and a
half-configured one. Only the **public** key travels in it; the private key never leaves the controller.

> **The profile step is not optional.** The `acp` profile comes with a sandbox by default, and in an
> unattended session launched by ssh that sandbox makes **child process creation fail**. The symptom is
> "it connects and it talks, but no command runs", which looks like a broken machine when the only thing
> missing is two lines of configuration.

### 4. Add the machine

**Get it automatically** returns the full configuration in the machine's final report; the controller
writes it and verifies it. If more than one address is reported, the panel asks you to choose.

Or register it by hand:

| Way | How |
|---|---|
| Ask the agent | say: "use `fleet_add` to add a machine: label `laptop-01`, host `192.168.1.10`, user `dev`" |
| Settings page | **Settings → DuckFleet → "Add machine" → "Fill it in myself"**, then save and press "Test" |
| Edit the file | change `$DSH_HOME/fleet.json`; no restart needed |

The ASCII letters in the label determine the tool name (`Home Server` → `pc_home_server`), and you can
change it at any time. Call `fleet_test` to verify the SSH + ACP handshake (**costs no tokens**).

### 5. Delegate

| What you want | What you say |
|---|---|
| one | Have **desktop-01** report its disk usage |
| a few | Have **laptop-01** and **desktop-01** both check the Node version |
| all | Have **every machine** package up its log directory and send it to me |

Multiple machines run **concurrently**, so you do not wait twice as long. For long tasks, pass
`run_in_background: true` and collect the results later with `job_output`.

---

## Machine fields

The machine list lives in `$DSH_HOME/fleet.json`. **Shared settings** are set once and inherited by every
machine. **Per-machine fields** are independent, and a new machine inherits them from the shared settings.

### Shared settings (`defaults`)

| Field | Default | Description |
|---|---|---|
| `keyFile` | empty | Path to the SSH private key. **It must be right, or ssh will silently use another identity** |
| `sshCommand` | `ssh` | The ssh executable |
| `profile` | `acp` | Remote profile name |
| `autoArchive` | off | **Experimental.** Session-cleanup rules; see below |

### Per-machine fields

| Field | Default | Description |
|---|---|---|
| `label` | required | Display name, and the source of the tool name |
| `host` / `user` / `port` | required / required / `22` | SSH target |
| `toolName` | derived from `label` | The tool name the model calls; **changeable at any time** |
| `remoteCommand` | `dsh` | **How to start the agent on that machine.** A non-interactive SSH session usually has no `dsh` on PATH, so in practice this is an **absolute path**, such as `C:/Users/dev/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd` |
| `cwd` | empty | The workspace **on that machine**. Empty = let the remote side use its own default workspace |
| `permission` | `allow` | How permission prompts are answered on that machine |
| `description` | empty | One line on what this machine is for; appended to the tool description |
| `extraArgs` | `[]` | Extra ssh arguments |

`remoteCommand` is not a shared setting, because its usable value is the absolute path to `dsh` on that
machine and the path carries that machine's user name — sharing it would make other machines run another
machine's program.

---

## Agent management tools

| Tool | Purpose |
|---|---|
| `fleet_list` | List machines: `toolName  user@host  label` + workspace + permission + registration status |
| `fleet_add` | Add or change a machine (matched by `id` or `label`) |
| `fleet_remove` | Remove a machine and unregister its provider and tool |
| `fleet_test` | SSH + ACP handshake only, **costs no tokens** |
| `fleet_setup` | Generate the setup prompt for a controlled machine (with the public key) |
| `fleet_defaults` | Read or change the shared settings |
| `fleet_version` | Report which revision of the implementation is loaded |

The plugin registers a usage section in the system prompt, telling the model to call `fleet_list` first
for the "machine name → tool name" mapping, then to call concurrently within the same message. A tool
schema describes how to call, never when to call.

---

## Capability boundaries

DuckFleet is a **tool for your own use, on your own network**. The things below are **not implemented on
purpose** — boundaries, not bugs. Crossing one puts the security on you.

### Network: built for a network you already trust

- The plugin assumes the controller and the controlled machines sit on **one network you control**. Nothing
  about it is designed for the public internet.
- The LAN link does three things: a 4-letter random path, only the machine that fetched it may read it
  again, and it closes on fetch or timeout. It has **no TLS**, **no accounts**, **no rate limiting** and
  **no audit log**.
- **Do not put it behind a reverse proxy or port-forward it to the internet.** A 4-letter path is not a
  password.
- **There is no authentication between controller and controlled machine beyond SSH itself.** Whoever can
  ssh into a controlled machine with that key can delegate work on it. Guarding the private key is your
  responsibility.
- The panel's HTTP route lives on whatever address the harness already serves (by default `127.0.0.1`).
  Widening the harness's listen address widens the panel with it — **the plugin adds no access control of
  its own**.

### Permissions: the controlled side does not ask

A controlled machine's ACP profile **disables approval**. That session has **nobody to answer a prompt**,
so asking only burns a round trip; the authorization decision is made on the controller side instead (the
machine's `permission` field).

**The consequence**: a delegated task runs on the controlled machine with **the full rights of that SSH
account**, and will not stop to ask you. **You own the command you delegate.**

### Data: the list is plain text, the prompt carries a public key

- The machine list is `$DSH_HOME/fleet.json`, in **plain text**, holding hostnames, usernames and the key path.
- The setup prompt carries the **controller's public key**; the **private key never enters it**.
- The LAN link exposes that prompt on the LAN briefly — no private key, but **your hostname, account name
  and public key are in there**.

### What it does not do

- **It is not installed on the controlled machines.** The plugin runs only on the controller.
- **It does no orchestration beyond adding, changing and removing machines.** No task queue, no retries, no
  failover.
- **It does not proxy file transfer.** Have the controlled machine's agent handle files inside the task.

---

## Session cleanup (experimental, Windows only)

### The problem it solves

Every delegation opens a **new ACP session** on the controlled machine, and the ACP path **files that
session under no workspace** — it carries a `cwd` and nothing else. They all land in the sidebar's
**"ungrouped"** bucket, one per delegation.

Nothing on the controller can fix it after the fact: the operation that would attach a session has no ACP
equivalent and no HTTP route. **Archiving is the only lever.**

### How to use it

```bash
# Dry run: probe the platform and change nothing
fleet_prune --inspect

# Clean every machine, keeping the newest 5
fleet_prune

# Clean one machine, keeping the newest 2
fleet_prune --id huawei-vm --keep 2
```

The panel has the same entry point (the dashed box under the shared settings), with a per-machine button.

### Rules

| Item | Behaviour |
|---|---|
| What is eligible | **Only sessions whose directory name is a bare UUID** |
| How many stay | The newest N (default 5, configurable as `autoArchive.keepLast`) |
| Backup | First run writes `workspace.json.bak-before-archive` and **never overwrites an existing backup** |
| Reversible | Archived sessions can be un-archived from the sidebar's "Archived" view |

The test is "bare UUID" because a session created over ACP has a bare uuid id, while one created in the
DSH UI is prefixed `session-`. Filtering by directory alone is not enough: a controlled machine's `cwd` is
often a directory the operator also works in.

### This interrupts whatever is running

The cleanup has to **stop that machine's DSH**, archive, then start it again. **About 30 seconds, during
which delegations to that machine are interrupted.**

### Platform support

| Platform | Status |
|---|---|
| Windows | ✅ Verified repeatedly on real machines |
| macOS / Linux | ❌ **Not implemented and not tested** — refused outright, never attempted |

It refuses rather than "tries", because two parts are platform-specific: the registry lives at a different
path, and **how a GUI app is put back on the interactive desktop** after being stopped has no POSIX
equivalent written yet.

> **Known misclassification risk**: if DSH changes how it names sessions, or you hand-create a bare-uuid
> session in that directory, it will be treated as a delegation and archived. The backup and the
> reversibility exist for that.

---

## Known limitations

- **After upgrading the plugin, restart DSH for the panel to change** (see Installation). Tools working
  means the server half is current.
- **`cwd` has two sides**: the local ssh process's working directory is always the local session directory;
  the controlled machine's workspace travels as the ACP `session/new` argument.
- **A controlled machine must genuinely be able to execute commands**: a successful handshake **does not
  mean** it can do work. Under a restricted sandbox the ACP session starts and converses, but every child
  process fails. `fleet_test` verifies only the handshake; **actually running a command is the only real
  verification**.
- **One machine, one tool**: there is no separate broadcast tool. "All" = every machine `fleet_list`
  reports, called one by one in the same round.

---

## License

MIT
