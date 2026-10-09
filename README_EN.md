# DuckFleet

[中文](./README.md) | **English**

[![npm version](https://img.shields.io/npm/v/dsh-duck-fleet)](https://www.npmjs.com/package/dsh-duck-fleet)
[![License](https://img.shields.io/npm/l/dsh-duck-fleet)](./LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4dabf7)](https://github.com/topics/dsh-plugin)
[![Listed on awesome-dsh-hub](https://img.shields.io/badge/Listed%20on-awesome_dsh_hub-4dabf7)](https://github.com/ukinch605/awesome-dsh-hub)

> One flock, one command.

DuckFleet is a DSH plugin: install it once on the controller, connect several machines into one flock,
and **every machine automatically gets a delegation tool**. After that, you can put "one / a few / all"
of them to work in plain natural language.

```
You: have every machine report its current CPU and memory usage

DuckFleet: → delegates to 3 machines concurrently → collects the results machine by machine
```

---

## The problem it solves

The old way: for every machine you added, you **hand-wrote two mounting lines** in `cordis.patch.yml` —
one `dsh-subagent-acp` provider and one `dsh-tool-subagent` tool — and you kept `id` / `providerName` /
`toolName` / `maxDepth` / `cwd` / `permission` straight yourself.

Get one wrong and you may see no error at all — **the tool simply fails to appear**. With a few machines,
that YAML turns into copy-paste.

With DuckFleet installed:

- The machine list becomes **a single source of data** (`$DSH_HOME/fleet.json`, or a visual settings page);
- Adding a machine registers its ACP provider and delegation tool **immediately**, in the same process;
- Changing an address means editing one field, `host`; it re-registers on the spot, **with no restart**;
- Controlled machines **do not need this plugin** — they need only sshd + `dsh` + an `acp` profile.

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

`dsh plugin add` packs it into the profile and syncs it into `dsh.profile.bundles`.

> **Restart DSH once after installing.**
>
> The panel is the plugin's **client half**, and a client plugin's bundle is built and cached when the
> **application starts** — DSH caches it as `immutable`, keyed by a revision derived from the file's
> **timestamps and size**. So **refreshing the page is not enough**: a running process does not re-read a
> new bundle from disk.
>
> The server half (the `fleet_*` tools, delegation) applies as soon as the plugin row reloads, so the
> restart is only for the panel.

### Manual mounting (equivalent)

The profile's `package.json`:

```json
{
  "dependencies": { "dsh-duck-fleet": "link:/path/to/duck-fleet" },
  "dsh": { "profile": { "bundles": ["…", "dsh-duck-fleet"] } }
}
```

After you change the plugin's **server** source, **disable and re-enable** the `fleet` row in Settings to
apply it; after you change the **client** side (`lib/client.js`, the panel), **restart DSH**.

---

## Quick start

### 1. On the controller: install the plugin

Once `dsh plugin add` has installed it, the plugin does the following — all of it **on the controller**:

- it adds a **DuckFleet** page under Settings;
- it registers a usage section in the system prompt, so the model knows how "one / a few / all machines"
  should be delegated;
- it registers a set of management tools (`fleet_list` / `fleet_add` / `fleet_test` / `fleet_setup` / …).

At this point the list is still empty and **no machine is connected yet** — the plugin is only serving you
so far. Open **Settings → DuckFleet**; with no machines configured, the setup guide is already expanded on
the page.

### 2. On the controlled machine: DSH is all it needs

The controlled machine does **not** need this plugin installed. What it needs:

| Needed | Why |
|---|---|
| sshd running | so the controller can ssh in |
| `dsh` installed | **the only assumption the prompt makes** |
| an `acp` profile | created by the prompt below |
| the controller's public key | written by the prompt below |

The SSH service, the firewall, the profile and the key: all four are **checked and set up by the
controlled machine's own agent**, working from the prompt. You do not configure any of it by hand, and you
do not need to know the details.

### 3. Get the setup prompt — three entry points, two ways to deliver it

**Entry points (on the controller; any one of them):**

| Entry point | Where |
|---|---|
| Setup guide | **Settings → DuckFleet → "Setup guide"** (top right, always available) |
| While editing a machine | in the add/edit dialog → **"Copy the controlled-machine setup prompt"** |
| Ask the agent | just say: "use `fleet_setup` to generate the controlled-machine setup prompt, user `dev`, host `192.168.1.10`" |

**Delivery (getting the prompt onto the controlled machine):**

| Way | How | When to use it |
|---|---|---|
| **Copy and paste** | click **"Copy prompt"**, paste it into the controlled machine's DSH or terminal | you can operate that machine directly |
| **LAN link** | click **"Serve on the LAN instead"** to get an address like `http://192.168.1.10:<port>/abcd` (the port is assigned by the system), and **open it on the controlled machine** to fetch the prompt | the machine is not at hand (a different box, a different screen) |

The LAN link is **temporary**: it closes itself after **5 minutes** by default, its path is **four random
lowercase letters**, and **only the one machine that fetched it can ever read it** (any other host gets a
403) — you can also hit "Close now" to kill it immediately after the fetch. It listens on this machine
only and **never goes through any external service**.

The prompt is self-contained: it makes the controlled machine's agent **check the current state before
changing anything** and install only what is missing, so the same prompt covers a brand-new machine and a
half-configured one. Only the **public** key travels in it; the private key never leaves the controller.

> **Why the profile step is not optional**: the `acp` profile comes with a sandbox by default. In an
> unattended session launched by ssh, a restricted sandbox makes **child process creation fail** (on
> Windows this shows up as `0xC0000142` / `STATUS_DLL_INIT_FAILED` — it cannot even start
> `Write-Output`). The symptom is "it connects and it talks, but no command runs", which looks like a
> broken machine when the only thing missing is two lines of configuration. The prompt writes the
> correct `cordis.patch.yml`.

### 4. Come back and add the machine

Once the prompt has done its work, register the machine on the controller:

**Option A: have the agent add it (recommended)**

> Use `fleet_add` to add a machine: label `laptop-01`, host `192.168.1.10`, user `dev`

The ASCII letters in the label determine the tool name (`Home Server` → `pc_home_server`), and you can
change it by hand at any time.
The moment it is added, call `fleet_test` to verify the SSH + ACP handshake (**costs no tokens**).

**Option B: the settings page** — Settings → DuckFleet → "Add machine", fill in host and user, save, then
press "Test".

**Option C: edit `$DSH_HOME/fleet.json` directly** — no restart needed.

### 5. Delegate

All three scopes are supported, and **you just say it in natural language**:

| What you want | What you say |
|---|---|
| one | Have **desktop-01** report its disk usage |
| a few | Have **laptop-01** and **desktop-01** both check the Node version |
| all | Have **every machine** package up its log directory and send it to me |

Multiple machines run **concurrently** (one tool call per machine, all in the same message), so you do
not wait twice as long.
For long tasks, pass `run_in_background: true` and collect the results later with `job_output`.

---

## Machine fields

The machine list lives in `$DSH_HOME/fleet.json`. **Shared settings** concern the controller only: set
them once and every machine inherits them. **Per-machine fields** are independent per machine, and a new
machine inherits them from the shared settings.

### Shared settings (`defaults`)

| Field | Default | Description |
|---|---|---|
| `keyFile` | empty | Path to the SSH private key. **It must be right, or ssh will silently use another identity** |
| `sshCommand` | `ssh` | The ssh executable |
| `profile` | `acp` | Remote profile name |
| `autoArchive` | off | **Experimental.** Session-cleanup rules; see below |

> **Why `remoteCommand` is not here**: its usable value is the **absolute path** to the `dsh` CLI on the
> controlled machine, and that path carries that machine's user name (for example
> `C:/Users/dev/AppData/...`). Sharing it would amount to making other machines run another machine's
> program. **The test is: a value may be shared only when it does not depend on any controlled machine.**

### Per-machine fields

| Field | Default | Description |
|---|---|---|
| `label` | required | Display name, and the source of the tool name |
| `host` / `user` / `port` | required / required / `22` | SSH target |
| `toolName` | derived from `label` | The tool name the model calls; **changeable at any time** |
| `remoteCommand` | `dsh` | **How to start the agent on that machine.** A non-interactive SSH session usually has no `dsh` on PATH, so in practice the value is an absolute path, such as `C:/Users/dev/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd` |
| `cwd` | empty | The workspace **on that machine**. Empty = let the remote side open its own default workspace; a real delegation falls back to the controller session's workspace |
| `permission` | `allow` | How permission prompts are answered on that machine |
| `description` | empty | One line on what this machine is for; it is appended to the tool description |
| `extraArgs` | `[]` | Extra ssh arguments |

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
| `fleet_version` | Report which revision of the implementation is currently loaded |

### How natural language finds the right tool

The plugin registers a **usage section** in the system prompt (`ctx.systemPrompt.section`) that tells the
model to call `fleet_list` first for the "machine name → tool name" mapping, and then to call
concurrently within the same message.

**That section is required**: a tool schema describes how to call, never when to call. Without it, "run
this on all machines" has no addressee, and a machine the user names the way it appears in the settings
page can only be guessed at.

---

## Capability boundaries (read this first)

DuckFleet is a **tool for your own use, on your own network**. The things below are **not implemented on
purpose** — they are boundaries, not bugs. If your usage crosses one of them, the security is on you.

### Network: built for a network you already trust

The plugin assumes the controller and the controlled machines sit on **one network you control** (a LAN, a
VPN, or two machines that can already reach each other). Nothing about it is designed for the public
internet:

- **The LAN link exists to save you from typing, not to be a service.** It does exactly three things: a
  4-letter random path, only the **one machine that fetched it** may read it again (every other host gets a
  403), and it **closes itself after 5 minutes**. It has **no TLS**, **no accounts**, **no rate limiting**
  and **no audit log**.
- **Do not put it behind a reverse proxy or port-forward it to the internet.** Doing so removes what little
  protection there is: a 4-letter path is not a password, and five minutes is nowhere near a guarantee that
  nobody scanned it. **We have written no security policy for that usage.**
- **There is no authentication between controller and controlled machine beyond SSH itself.** Trust rests
  entirely on SSH: whoever can ssh into a controlled machine with that key can delegate work on it. Guarding
  the private key is your responsibility.
- The panel's HTTP route lives on whatever address the harness already serves (by default `127.0.0.1`). If
  you widen the harness's listen address, the panel widens with it — **the plugin adds no access control of
  its own**.

### Permissions: the controlled side does not ask

A controlled machine's ACP profile **disables approval** (`approval: policy: never`). The reason is plain:
that session has **nobody to answer a prompt**, so asking only burns a round trip. The authorization
decision is made on the controller side instead (the machine's `permission` field).

**The consequence**: a delegated task runs on the controlled machine with **the full rights of that SSH
account**, and it will not stop to ask you. So — **you own the command you delegate**.

### Data: the list is plain text, the prompt carries a public key

- The machine list is `$DSH_HOME/fleet.json`, in **plain text**, holding hostnames, usernames and the key path.
- The setup prompt carries the **controller's public key** (a public key is meant to be public). The
  **private key never enters it**.
- The LAN link exposes that prompt on the LAN for a few minutes — no private key in it, but **your hostname,
  account name and public key are in there**.

### What it does not do

- **It is not installed on the controlled machines.** They need sshd + `dsh` + an `acp` profile; the plugin
  itself runs only on the controller.
- **It does no orchestration beyond adding, changing and removing machines.** No task queue, no retries, no
  automatic failover — the work is done by **the agent on the controlled machine**, and failures are
  reported back per machine by the model.
- **It does not proxy file transfer.** If you need files moved, have the controlled machine's agent handle it
  inside the task.

---

## Session cleanup (experimental, Windows only)

### The problem it solves

Every delegation opens a **new ACP session** on the controlled machine. The ACP path **files that session
under no workspace** — it carries a `cwd` and never calls `workspace.attachSession`. So they all land in the
sidebar's **"ungrouped"** bucket, one per delegation, until the list is unusable.

Nothing on the controller can fix it after the fact: the operation that would attach a session
(`workspaceRegistry.attachSession`) has no ACP equivalent and no HTTP route, and every delegation goes
through ACP.

**Archiving is the only lever.** `archivedSessionIds` in `workspace.json` is a flat set, and
`validateStoredState` asks nothing of its contents beyond the ids existing — so sessions that belong to no
workspace can still be hidden.

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

### Rules and safety properties

| Item | Behaviour |
|---|---|
| What is eligible | **Only sessions whose directory name is a bare UUID** |
| How many stay | The newest N (default 5, configurable as `autoArchive.keepLast`) |
| Backup | First run writes `workspace.json.bak-before-archive` and **never overwrites an existing backup** |
| Reversible | Archived sessions can be un-archived from the sidebar's "Archived" view |
| Write check | The file is re-parsed after writing, and every workspace title is compared character by character |

> **Why the test is "bare UUID"**: a session created over ACP has a bare uuid id (`1da62ac9-…`), while one
> created in the DSH UI is prefixed `session-` (`session-f7737053-…`). **Filtering by directory alone is not
> enough** — a controlled machine's `cwd` is often a directory the operator also works in, and that would
> archive your own sessions along with the delegations. The distinction was measured, not assumed.

### This interrupts whatever is running

The cleanup has to **stop that machine's DSH** (the registry is held in memory and would otherwise be
overwritten), archive, then start it again. **About 30 seconds, during which delegations to that machine are
interrupted.**

### Platform support

| Platform | Status |
|---|---|
| Windows | ✅ Verified repeatedly on two real machines |
| macOS / Linux | ❌ **Not implemented and not tested** — refused outright, never attempted |

It refuses rather than "tries", because two parts are platform-specific: the registry lives at a different
path, and **how a GUI app is put back on the interactive desktop** after being stopped is a scheduled task
with an interactive principal on Windows, with **no POSIX equivalent written yet**.

> **Known misclassification risk**: if DSH ever changes how it names sessions, or you hand-create a bare-uuid
> session in that directory, it will be treated as a delegation and archived. The backup and the
> reversibility exist for exactly that.

---

## Known limitations

- **The controller must be the "superior" of the controlled machines**: the plugin registers providers
  and tools at runtime, so **adding a machine needs no restart** (editing `fleet.json`, the shared settings,
  and adding or removing machines all apply immediately).
- **After upgrading the plugin, restart DSH for the panel to change.** This is not a defect in this plugin
  but how DSH loads a **client plugin**: its bundle is built when the **application starts** and cached as
  `immutable`, with a revision derived from the file's **timestamps and size** — so **refreshing the page
  does not help**, because a running process does not re-read the bundle from disk. The server half (the
  `fleet_*` tools, delegation) applies as soon as the plugin row reloads, so **the restart is only for the
  panel**. The test is simple: **tools working means the server half is current; a stale panel means a
  restart is due.**
- **`cwd` has two sides**: the local ssh process's working directory is always the local session
  directory (a path that exists only on the controlled machine cannot serve as the local working
  directory — then not even the name `ssh` resolves, and you get `ENOENT: spawn ssh ENOENT`, which reads
  like "ssh is not installed"). The controlled machine's workspace travels as the ACP `session/new`
  argument.
- **A controlled machine must genuinely be able to execute commands**: a successful handshake **does not
  mean** it can do work. Under a restricted sandbox the ACP session starts and converses, but every child
  process fails. `fleet_test` verifies only the handshake; **actually running a command is the only real
  verification**.
- **One machine, one tool**: there is no separate broadcast tool. "All" = every machine `fleet_list`
  reports, called one by one by the model in the same round.

---

## License

MIT
