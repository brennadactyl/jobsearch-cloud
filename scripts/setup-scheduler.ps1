<#
.SYNOPSIS
  Registers every tracked search as a Windows Scheduled Task, for every person
  set up on this machine.

.DESCRIPTION
  For each person with a
  <DataDir>\<user-id>\tracker.json (see private.example/README.md), reads their
  tracks from GET /api/config and registers one daily task per track at its
  configured time. Also registers one machine-wide task,
  "JobSearch-Applications", that runs run-fill.ps1 for every account.

  A track with `fed_by` set gets no task: its tab is filled by that sibling
  track's search (see server/migrations/0003_branched_tracks.sql).

  Safe to re-run: tasks for existing tracks are replaced in place, and tasks
  for removed tracks are unregistered. Cleanup is scoped to the people this run
  processed, so setting up one person never unregisters another's schedule.

  A single-user machine (no <DataDir>\*\tracker.json, credentials in
  TRACKER_URL/TRACKER_API_TOKEN) is treated as one unnamed user whose work dir
  is <DataDir> itself.

  Prerequisites checked/warned about, not auto-fixed:
    - Node.js + the claude CLI (npm install -g @anthropic-ai/claude-code)
    - CLAUDE_CODE_OAUTH_TOKEN set for your account (run `claude setup-token`,
      then `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`) so headless runs
      authenticate. Note this is the *machine owner's* Claude account, and
      every person's searches on this machine run through it.
    - Each person's <DataDir>\<user-id>\tracker.json holding their own
      tracker URL and session token (see ../server/README.md)

.PARAMETER DataDir
  Path to the private data folder. Defaults to the JOB_SEARCH_DATA_DIR
  environment variable, then to a "private" folder next to this repo.

.PARAMETER User
  Only set up this one user id, leaving everyone else's tasks alone. Omit to
  process every person found under DataDir.

.EXAMPLE
  .\setup-scheduler.ps1
  .\setup-scheduler.ps1 -DataDir "D:\JobSearchData" -User ab266b6c-00cc-45d1-92ac-cdad412c1558
#>
param(
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),
    [string]$User
)

$ErrorActionPreference = "Stop"
$runScript = Join-Path $PSScriptRoot "run-search.ps1"
$fillScript = Join-Path $PSScriptRoot "run-fill.ps1"

# "technical-pm" -> "TechnicalPm". Never emits a hyphen; stale-task cleanup
# below relies on that.
function ConvertTo-TaskSuffix([string]$key) {
    ($key -split "[-_ ]" | Where-Object { $_ } | ForEach-Object {
        $_.Substring(0, 1).ToUpper() + $_.Substring(1)
    }) -join ""
}

# Registers one daily task and applies the power settings that decide whether
# it runs overnight at all. Shared by the search tasks and the fill task so
# neither can miss those settings. Returns $true if the task was registered.
function Register-JobSearchTask([string]$Name, [string]$Script, [string]$Arguments, [string]$Time) {
    $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Script`" $Arguments"
    # /TR has a 261-character limit and native exes don't trip
    # ErrorActionPreference, so a too-long path (or any other failure)
    # would otherwise print the same cheerful line as a success and leave
    # a track silently unscheduled.
    schtasks /Create /TN $Name /TR $action /SC DAILY /ST $Time /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "  FAILED to register $Name (schtasks exit $LASTEXITCODE). Action string is $($action.Length) chars; /TR's limit is 261."
        return $false
    }

    # schtasks has no flag for waking the machine or catching up a missed run,
    # and it defaults "don't start if on batteries" to ON, so a task it
    # registers alone silently skips any night the machine is asleep.
    #
    # Applied after /Create rather than by switching to Register-ScheduledTask
    # wholesale, which would lose the /TR length check above.
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
    try {
        Set-ScheduledTask -TaskName $Name -Settings $settings -ErrorAction Stop | Out-Null
    } catch {
        Write-Warning ("  $Name was registered but its wake/catch-up settings did not apply: {0}" -f $_.Exception.Message)
        Write-Warning "  It will not wake a sleeping machine, and will not re-run a slot it misses."
    }
    return $true
}

Write-Host "== Checking prerequisites ==" -ForegroundColor Cyan

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Warning "claude CLI not found on PATH. Install Node.js, then: npm install -g @anthropic-ai/claude-code"
} else {
    Write-Host "claude CLI found: $($claude.Source)"
}

# The scheduled task runs in a fresh process as this user, so the persisted
# User (or Machine) value is what it sees. This shell's $env: copy can be
# missing after a `setx` the shell predates, or present from an inline set that
# was never persisted.
$tokenUser    = [Environment]::GetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN", "User")
$tokenMachine = [Environment]::GetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN", "Machine")
if ($tokenUser -or $tokenMachine) {
    $scope = if ($tokenUser) { "User" } else { "Machine" }
    Write-Host "CLAUDE_CODE_OAUTH_TOKEN is set ($scope scope) - scheduled runs will see it."
} elseif ($env:CLAUDE_CODE_OAUTH_TOKEN) {
    Write-Warning "CLAUDE_CODE_OAUTH_TOKEN is set in this shell only, not persisted."
    Write-Warning 'Scheduled runs start a fresh process and will NOT see it. Persist it: setx CLAUDE_CODE_OAUTH_TOKEN "<token>"'
} else {
    Write-Warning "CLAUDE_CODE_OAUTH_TOKEN is not set for this user. Headless/scheduled runs will fail to authenticate."
    Write-Warning 'Run `claude setup-token`, then `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`, then open a new terminal.'
}

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir. See private.example/README.md."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path
Write-Host "Data dir: $DataDir"

Write-Host "`n== Discovering people ==" -ForegroundColor Cyan

$people = @()
foreach ($dir in (Get-ChildItem $DataDir -Directory | Sort-Object Name)) {
    $trackerFile = Join-Path $dir.FullName "tracker.json"
    if (-not (Test-Path $trackerFile)) { continue }
    if ($User -and $dir.Name -ne $User) { continue }
    $tracker = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
    $people += [pscustomobject]@{ Id = $dir.Name; Url = $tracker.url.TrimEnd("/"); Token = $tracker.token }
}

# A single-user machine: no per-user folders, credentials in the environment.
# Treated as one person with no id, whose tasks use unprefixed
# "JobSearch-<Track>" names.
if ($people.Count -eq 0 -and -not $User -and $env:TRACKER_URL -and $env:TRACKER_API_TOKEN) {
    Write-Host "No per-user folders found - using TRACKER_URL/TRACKER_API_TOKEN for a single-user machine."
    $people += [pscustomobject]@{ Id = ""; Url = $env:TRACKER_URL.TrimEnd("/"); Token = $env:TRACKER_API_TOKEN }
}

if ($people.Count -eq 0) {
    Write-Warning "No people found. Each person needs <DataDir>\<user-id>\tracker.json with their tracker URL and token - see private.example/README.md."
    exit 1
}
Write-Host "Found $($people.Count) $(if ($people.Count -eq 1) {'person'} else {'people'}): $(($people | ForEach-Object { if ($_.Id) { $_.Id } else { '(single-user)' } }) -join ', ')"

Write-Host "`n== Registering scheduled tasks ==" -ForegroundColor Cyan

# Only the prefixes this run is responsible for. Anything outside them belongs
# to a person we weren't asked about, and must survive untouched.
$ownedPrefixes = @()
$registered = @()

# Shared across everyone on the machine, not reset per person: they all run
# through this machine's one Claude CLI, so two people's unscheduled tracks
# both landing on 08:00 is the collision this is here to avoid.
$auto = [datetime]"08:00"

# When the machine-wide application fill runs. Early enough that a URL pasted
# yesterday is filled in before anyone next looks at the tracker, and off the
# searches' stagger so it doesn't drift as tracks are added.
$FILL_TIME = "06:30"

foreach ($person in $people) {
    $label = if ($person.Id) { $person.Id } else { "single-user" }
    try {
        $config = Invoke-RestMethod -Uri "$($person.Url)/api/config" -Headers @{ Authorization = "Bearer $($person.Token)" } -ErrorAction Stop
    } catch {
        Write-Warning "Couldn't read config for $label ($($_.Exception.Message)) - skipping. Their existing tasks are left alone."
        continue
    }

    if (-not $config.tracks -or $config.tracks.Count -eq 0) {
        Write-Warning "$label has no tracks configured yet - nothing to schedule. Run the job-search-setup skill for them first."
        continue
    }

    # Prefixed per person so two people's tracks can share a key ("SWE") and
    # cleanup can tell whose is whose. Substring is guarded because a
    # hand-named folder can be shorter than 8 characters, and the throw would
    # abort the whole run under ErrorActionPreference=Stop.
    $prefix = if ($person.Id) {
        $short = if ($person.Id.Length -ge 8) { $person.Id.Substring(0, 8) } else { $person.Id }
        "JobSearch-$short-"
    } else { "JobSearch-" }
    $ownedPrefixes += $prefix

    foreach ($track in ($config.tracks | Sort-Object sort_order, key)) {
        # A tab, not a search: the track named in fed_by finds its postings and
        # files them here too. GET /api/prompt refuses to compose a prompt for
        # one of these, so a task registered for it would fail every morning.
        if ($track.fed_by) {
            Write-Host "  $($track.key) - no task; filled by $($track.fed_by)'s search"
            continue
        }
        $time = $track.schedule_time
        if (-not $time -or $time -notmatch '^\d{2}:\d{2}$') {
            $time = $auto.ToString("HH:mm")
            $auto = $auto.AddMinutes(30)
        }
        $name = $prefix + (ConvertTo-TaskSuffix $track.key)
        # Two keys differing only by separator ("technical-pm" / "technical_pm")
        # produce one suffix, and schtasks /F would silently overwrite - one of
        # the two searches would just stop running.
        if ($registered -contains $name) {
            Write-Warning "  $($track.key) collides with an already-registered task name ($name) - skipped. Rename one of the track keys."
            continue
        }
        $userArg = if ($person.Id) { " -User $($person.Id)" } else { "" }
        $trackArgs = "-Task $($track.key)$userArg -DataDir `"$DataDir`""
        if (-not (Register-JobSearchTask -Name $name -Script $runScript -Arguments $trackArgs -Time $time)) { continue }

        Write-Host "  $name - daily at $time ($label / $($track.key))"
        $registered += $name
    }

}

# The fill task (see run-fill.ps1). Registered whether or not anyone has pasted
# a URL yet: there is nothing to detect in advance, and a run with nothing to
# read costs one API call per account.
#
# Its name carries no user id, which keeps it clear of every "JobSearch-<id>-"
# prefix. It still goes into $registered, because a single-user machine owns the
# bare "JobSearch-" prefix and would otherwise remove it as stale.
if ($people.Count -gt 0) {
    Write-Host "`n== Registering the application fill (one task, all accounts) ==" -ForegroundColor Cyan
    $fillName = "JobSearch-Applications"
    if (Register-JobSearchTask -Name $fillName -Script $fillScript -Arguments "-DataDir `"$DataDir`"" -Time $FILL_TIME) {
        Write-Host "  $fillName - daily at $FILL_TIME (every account under $DataDir, applications added by URL)"
        $registered += $fillName
    }
}

if ($ownedPrefixes.Count -gt 0) {
    $stale = Get-ScheduledTask -TaskName "JobSearch-*" -ErrorAction SilentlyContinue | Where-Object {
        $taskName = $_.TaskName
        $mine = $false
        foreach ($p in $ownedPrefixes) {
            # The single-user prefix, a bare "JobSearch-", is also a prefix of
            # every per-user name ("JobSearch-ab266b6c-Swe"), so on its own it
            # would claim and delete other people's tasks - possible whenever
            # the single-user branch fires beside per-user folders (a -DataDir
            # pointing elsewhere, a tracker.json mid-write).
            # A second hyphen marks a per-user task: ConvertTo-TaskSuffix never
            # emits one, and the id segment need not be a GUID.
            if ($p -eq "JobSearch-" -and $taskName -match '^JobSearch-.+-') { continue }
            if ($taskName.StartsWith($p)) { $mine = $true }
        }
        $mine -and ($registered -notcontains $taskName)
    }
    if ($stale) {
        Write-Host "`n== Removing stale tasks (track no longer configured) ==" -ForegroundColor Cyan
        foreach ($s in $stale) {
            Unregister-ScheduledTask -TaskName $s.TaskName -Confirm:$false
            Write-Host "  removed $($s.TaskName)"
        }
    }
}

# Read the settings back rather than trusting that applying them worked: a task
# that cannot wake the machine looks normal in every listing, and a search that
# never fired looks like one that found nothing.
if ($registered.Count -gt 0) {
    $broken = @()
    foreach ($n in $registered) {
        $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        if (-not $t) { $broken += "$n (not found after registering)"; continue }
        $s = $t.Settings
        $missing = @()
        if (-not $s.WakeToRun)            { $missing += "won't wake the machine" }
        if (-not $s.StartWhenAvailable)   { $missing += "won't catch up a missed run" }
        if ($s.DisallowStartIfOnBatteries){ $missing += "won't start on battery" }
        if ($missing) { $broken += "$n - $($missing -join '; ')" }
    }
    if ($broken) {
        Write-Host "`n== These tasks will not run reliably overnight ==" -ForegroundColor Red
        $broken | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Host "Fix in Task Scheduler (Conditions + Settings tabs), or re-run this script." -ForegroundColor Red
    } else {
        Write-Host "`nAll $($registered.Count) task(s) verified: wake the machine, catch up a missed run, run on battery." -ForegroundColor Green
    }
}

Write-Host "`nDone. Tasks run only while you're logged in (no stored password required)." -ForegroundColor Green
Write-Host "They will wake a sleeping machine, and re-run a slot they missed once it's available."
Write-Host "A machine that is shut down or hibernated at the scheduled time cannot be woken by" -ForegroundColor Yellow
Write-Host "anything Task Scheduler does - leave it asleep rather than off if you want overnight runs." -ForegroundColor Yellow
if ($registered.Count -gt 0) {
    Write-Host "Test one now with, e.g.: schtasks /Run /TN $($registered[0])"
    Write-Host "View/manage them in Task Scheduler under the root task folder, or: schtasks /Query /TN $($registered[0]) /V /FO LIST"
}
