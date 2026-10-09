/**
 * The three Windows-side scripts the session-prune feature runs on a controlled machine.
 *
 * They are shipped as JavaScript template strings rather than files for two reasons: `files` in
 * package.json then needs no extra entry, and there is no runtime path to resolve inside a packaged
 * plugin. Each one is written to a temporary file on the controlled machine and run with `-File`.
 *
 * ## Why the scripts are uploaded instead of sent inline
 *
 * Every attempt to run these as a one-liner over `ssh <target> powershell -Command "..."` lost quoting:
 * the value passes through `ssh`, then the far side's shell, then PowerShell, and each layer strips or
 * reinterprets quotes. A `-FleetSessionsSubdirectory '--C-Users-Public--'` argument arrived split on its
 * dashes. Files avoid the problem entirely, and the one value that must still travel is base64.
 *
 * ## Why ASCII only
 *
 * Windows PowerShell 5.1 parses a `.ps1` as ANSI, so a non-ASCII character in the source is mangled into a
 * syntax error — measured with a Chinese workspace title in a comparison literal. Comments stay in English
 * and non-ASCII values are compared by code point or round-tripped, never written as literals.
 *
 * @module dsh-duck-fleet/prune-scripts
 */

/**
 * Stop the controlled machine's DSH, and prove the workspace registry is free for editing.
 *
 * The registry is held in memory by the running app, so an edit made while it is alive would be
 * overwritten. The exclusive-open check is the precondition the archive step depends on.
 */
export const STOP_SCRIPT = String.raw`<#
  Stop every DSH process on this machine and confirm the workspace registry is editable.

  A force stop is deliberate: the sessions being cleaned up are finished delegations, and the app persists
  session state as it goes, so nothing in flight is lost.
#>
[CmdletBinding()]
param([int]$TimeoutSeconds = 30)

$ErrorActionPreference = 'Continue'

$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Write-Output ("processes before: " + $procs.Count)
if ($procs.Count -gt 0) { $procs | Stop-Process -Force -ErrorAction SilentlyContinue }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}

$remaining = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Write-Output ("processes after: " + $remaining.Count)
if ($remaining.Count -gt 0) { throw "could not stop DSH" }

$store = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
if (-not (Test-Path $store)) { throw "workspace registry not found: $store" }

try {
  $fs = [IO.File]::Open($store, 'Open', 'ReadWrite', 'None')
  $fs.Close()
  Write-Output 'registry is free for exclusive write: yes'
} catch {
  throw ("registry still locked: " + $_.Exception.Message)
}
`;

/**
 * Archive the older delegation sessions in the workspace registry.
 *
 * Sessions are selected by their DIRECTORY under the fleet's own cwd, so a session the operator created by
 * hand is never touched. The registry is round-tripped as JSON because `validateStoredState` re-checks its
 * shape on load (order vs table, unique paths, no session accounted twice).
 *
 * `-FleetSessionsSubdirectoryBase64` exists because the directory name starts with `--` and does not
 * survive being passed as a quoted argument through ssh and the far shell.
 */
export const ARCHIVE_SCRIPT = String.raw`<#
  Archive the older DuckFleet delegation sessions in a controlled machine's workspace registry.

  Sessions are chosen by their directory under the fleet's own cwd, newest first, and everything past
  -Keep is archived. Archiving only adds ids to a flat set, so it works for sessions that no workspace
  accounts for -- which is every session the ACP path creates.
#>
[CmdletBinding()]
param(
  [string]$FleetSessionsSubdirectory,
  [string]$FleetSessionsSubdirectoryBase64,
  [int]$Keep = 5
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not $FleetSessionsSubdirectory -and $FleetSessionsSubdirectoryBase64) {
  $FleetSessionsSubdirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($FleetSessionsSubdirectoryBase64))
}
if (-not $FleetSessionsSubdirectory) { throw 'FleetSessionsSubdirectory (or its base64 form) is required' }

$store = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
$fleetDir = Join-Path $env:USERPROFILE ('.dsh\sessions\' + $FleetSessionsSubdirectory)

if (-not (Test-Path $store)) { throw "workspace registry not found: $store" }
if (-not (Test-Path $fleetDir)) { throw "fleet session directory not found: $fleetDir" }

# Refuse to run against a live DSH: it would overwrite this file from memory.
$live = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($live.Count -gt 0) { throw ("DSH is still running (" + $live.Count + " processes); stop it first") }

# Round-trip guard: prove the read codec works BEFORE writing anything.
$doc = [IO.File]::ReadAllText($store, $utf8) | ConvertFrom-Json
$titlesBefore = @($doc.tables.workspaces.PSObject.Properties.Value | ForEach-Object { $_.title })
Write-Output ("registry read ok: workspaces=" + @($doc.global.workspaceIds).Count + " archived=" + @($doc.global.archivedSessionIds).Count)

# Back up once, and never overwrite an existing backup with an already-modified file.
$backup = "$store.bak-before-archive"
if (-not (Test-Path $backup)) { Copy-Item $store $backup -Force; Write-Output ("backup written: " + $backup) }
else { Write-Output ("backup already present, kept: " + $backup) }

$dirs = @(Get-ChildItem $fleetDir -Directory | Sort-Object LastWriteTime -Descending)
# Only ACP-created sessions are candidates, and the session id is what tells them apart: a delegation gets a
# bare uuid, while a session created in the app UI is prefixed with "session-". Filtering by DIRECTORY alone
# was not enough -- the fleet cwd is often a directory the operator also works in, so one of theirs would have
# been archived along with the delegations.
$all = @($dirs | Where-Object { $_.Name -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-' } | ForEach-Object { $_.Name })
$skipped = $dirs.Count - $all.Count
$archiving = @($all | Select-Object -Skip $Keep)
Write-Output ("fleet sessions: " + $all.Count + "   skipped(non-ACP): " + $skipped + "   keeping: " + [Math]::Min($Keep, $all.Count) + "   archiving: " + $archiving.Count)

$before = @($doc.global.archivedSessionIds).Count
$set = New-Object System.Collections.Generic.List[string]
foreach ($id in @($doc.global.archivedSessionIds)) { if (-not $set.Contains([string]$id)) { $set.Add([string]$id) } }
foreach ($id in $archiving) { if (-not $set.Contains($id)) { $set.Add($id) } }
$doc.global.archivedSessionIds = @($set)
$after = @($doc.global.archivedSessionIds).Count
Write-Output ("archivedSessionIds: " + $before + " -> " + $after)

# Write atomically, UTF-8 without BOM.
$tmp = "$store.tmp"
[IO.File]::WriteAllText($tmp, ($doc | ConvertTo-Json -Depth 20), $utf8)
Move-Item $tmp $store -Force

# Prove the written file parses and kept every non-ASCII title byte-for-byte.
$check = [IO.File]::ReadAllText($store, $utf8) | ConvertFrom-Json
$titlesAfter = @($check.tables.workspaces.PSObject.Properties.Value | ForEach-Object { $_.title })
$sameTitles = ($titlesBefore.Count -eq $titlesAfter.Count)
if ($sameTitles) { for ($i = 0; $i -lt $titlesBefore.Count; $i++) { if ($titlesBefore[$i] -cne $titlesAfter[$i]) { $sameTitles = $false } } }
Write-Output ("re-read ok: workspaces=" + @($check.global.workspaceIds).Count + " archived=" + @($check.global.archivedSessionIds).Count + " titles-unchanged=" + $sameTitles)
`;

/**
 * Start DSH on the logged-on user's interactive desktop.
 *
 * Four approaches were measured and rejected on a real machine — `Start-Process` (lands in session 0, no
 * desktop), `WTSQueryUserToken` (needs SeTcbPrivilege, absent from an ssh token), `CreateProcessAsUser` with
 * a token borrowed from explorer (fails 1314, the privileges cannot be assigned), and `schtasks /tr` with a
 * quoted path (splits the path, fails 0x80070002). What works is a scheduled task with an INTERACTIVE
 * principal at HIGHEST run level: the Task Scheduler supplies both the desktop and the elevation.
 */
export const START_SCRIPT = String.raw`<#
  Start DSH on the logged-on user's interactive desktop, from an SSH login.

  Register-ScheduledTask is used rather than schtasks because it takes the executable and its arguments as
  separate values: schtasks splits a quoted path and the run then fails ERROR_FILE_NOT_FOUND.
#>
[CmdletBinding()]
param(
  [string]$ExecutablePath,
  [string]$TaskName = 'DuckFleet-Restart-DSH',
  [int]$SettleSeconds = 20
)

$ErrorActionPreference = 'Stop'

if (-not $ExecutablePath) { $ExecutablePath = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe' }
if (-not (Test-Path $ExecutablePath)) { throw "executable not found: $ExecutablePath" }

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $ExecutablePath -WorkingDirectory (Split-Path $ExecutablePath -Parent)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30)
# The SID, not "DOMAIN\user": Register-ScheduledTask fails 0x80070534 when it cannot translate the string.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output ("task registered: Execute=" + (Get-ScheduledTask -TaskName $TaskName).Actions[0].Execute)

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds $SettleSeconds

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output ("LastTaskResult: " + $info.LastTaskResult + "   (0 = success)")

$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
$sessions = @($procs | ForEach-Object { $_.SessionId } | Sort-Object -Unique)
Write-Output ("processes: " + $procs.Count + "   sessions: " + ($sessions -join ','))

# Session 0 means it landed in the service session and will die -- the point of this whole script.
$onDesktop = @($procs | Where-Object { $_.SessionId -ne 0 }).Count
if ($procs.Count -gt 0 -and $onDesktop -eq $procs.Count) { Write-Output 'RESULT: running on an interactive desktop' }
else { Write-Output 'RESULT: NOT on an interactive desktop' }

$listening = Get-NetTCPConnection -State Listen -LocalPort 19387 -ErrorAction SilentlyContinue
Write-Output ("listening 19387: " + $(if ($listening) { 'yes' } else { 'no' }))

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output 'task removed'
`;

/**
 * One-liners that classify the controlled machine without assuming which shell exists there.
 *
 * `cmd.exe /c echo %OS%` is a positive Windows test: cmd exists only on Windows and `%OS%` expands to
 * `Windows_NT` there. Running it first means a POSIX machine answers through the shell that is actually
 * present, instead of a PowerShell invocation that would not exist to fail informatively.
 */
export const DETECT_WINDOWS = 'cmd.exe /c echo %OS%';
export const DETECT_POSIX = 'uname -s';

/**
 * Locate this user's `.dsh` home and count the session directories under the fleet's cwd.
 *
 * Reported by the prune tool as evidence, so the operator sees what was measured rather than only a verdict.
 * Written as a Windows script because the tool refuses to run anywhere else.
 */
export const INSPECT_SCRIPT = String.raw`[CmdletBinding()]
param([string]$FleetSessionsSubdirectoryBase64)

$utf8 = New-Object System.Text.UTF8Encoding($false)
if ($FleetSessionsSubdirectoryBase64) {
  $FleetSessionsSubdirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($FleetSessionsSubdirectoryBase64))
}

$home2 = Join-Path $env:USERPROFILE '.dsh'
Write-Output ("dshHome: " + $home2 + "  exists=" + (Test-Path $home2))

$store = Join-Path $home2 'storages\workspace.json'
Write-Output ("registry: exists=" + (Test-Path $store))

if ($FleetSessionsSubdirectory) {
  $fleetDir = Join-Path $home2 ('sessions\' + $FleetSessionsSubdirectory)
  Write-Output ("fleetDir: " + $fleetDir + "  exists=" + (Test-Path $fleetDir))
  if (Test-Path $fleetDir) {
    $n = @(Get-ChildItem $fleetDir -Directory -ErrorAction SilentlyContinue).Count
    Write-Output ("fleetSessions: " + $n)
  }
}

if (Test-Path $store) {
  $doc = [IO.File]::ReadAllText($store, $utf8) | ConvertFrom-Json
  Write-Output ("archived: " + @($doc.global.archivedSessionIds).Count + "  workspaces: " + @($doc.global.workspaceIds).Count)
}

$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Write-Output ("dshProcesses: " + $procs.Count + "  sessions: " + ((@($procs | ForEach-Object { $_.SessionId } | Sort-Object -Unique)) -join ','))
`;
