<#
.SYNOPSIS
  Runs one daily job-search prompt through the Claude Code CLI.

.DESCRIPTION
  Generic runner - contains no personal data itself. It fetches the prompt for
  one track from the tracker API (`GET /api/prompt/<task>`), runs it
  non-interactively via `claude -p`, and logs output to
  <DataDir>\<User>\logs\<Task>.log.

  ---- Documents come from the tracker, not from this machine.

  The prompt names relative paths (docs/..., resumes/...) and those are now
  fetched from `GET /api/documents` into a throwaway directory,
  <DataDir>\<User>\.run\<Task>, which becomes the working directory for the
  run. Wiped and refilled every time, so what the search reads is what the
  tracker holds rather than whatever a previous run left lying around - and so
  the several hundred megabytes of scratch a run generates stops accumulating
  in the durable folder, which is what happened when that folder *was* the
  working directory.

  Afterwards, any file under docs\ whose contents changed is written back
  (`PUT /api/documents/<path>`), because the baseline doc is the one thing a
  run edits as it goes. What to send is decided by comparing SHA-256 against a
  manifest taken on the way down - not by working out which file the track's
  config points at, which would mean reimplementing the server's own fallback
  here where the two could drift. Files under resumes\ and reference\ are
  inputs and are never written back.

  Each write-back carries `If-Match` with the etag the file arrived with, so a
  run can only overwrite the version it read. A 412 means something else wrote
  the document during the run; the run's copy is saved next to the log and the
  run fails rather than clobbering it.

  The prompt is composed server-side from that track's config in D1, not read
  from a file here. That's what lets one machine run several people's searches
  without holding several people's search config, and what keeps the API's own
  calling convention (the curl steps) defined in one place instead of copied
  into a prompt file per track. See ../server/src/prompt.js.

  Runs with a scoped tool allowlist (Read/Write/Edit/Glob/Grep/WebSearch/WebFetch/
  Bash) so it doesn't stall on a permission prompt with nobody there to answer
  it. Bash is unscoped rather than limited to e.g. "Bash(curl:*)" - a narrower
  pattern blocked the model from even checking whether TRACKER_URL/
  TRACKER_API_TOKEN were set before attempting curl, since env-checking
  commands (printenv etc.) didn't match the pattern.

  Logs a config summary at the start, a heartbeat line every 20s while the
  search is running (searches take several minutes - without this the log
  looks identical whether it's working or stuck), and the full output plus
  exit status at the end.

.PARAMETER Task
  Which track to run - any key configured for this user in the tracker (e.g.
  "SWE", "engineering"). Not a fixed list: the runner has no opinion on how
  many tracks exist or what they're called, only that the API has config for
  the one you name.

.PARAMETER User
  Which person's search this is - the user id (a GUID) whose folder under
  <DataDir> holds their resumes, docs, logs, and tracker.json credentials.
  Omit it for a single-user machine, where those live in <DataDir> directly
  and the credentials come from the environment.

.PARAMETER DataDir
  Path to the private data folder (the "silo"). With -User, it holds each
  person's tracker.json and logs/. Defaults to the JOB_SEARCH_DATA_DIR
  environment variable, then to a "private" folder next to this repo.

.PARAMETER UseLocalFiles
  Skip the document fetch and run against whatever is already on disk, the way
  this script worked before documents moved into the tracker. For debugging a
  run against hand-edited files; a scheduled run should never use it.

.EXAMPLE
  .\run-search.ps1 -Task SWE -User ab266b6c-00cc-45d1-92ac-cdad412c1558
  .\run-search.ps1 -Task engineering                 # single-user machine
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Task,

    [string]$User,

    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),

    [switch]$UseLocalFiles
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir, or the JOB_SEARCH_DATA_DIR environment variable, to your private job-search data folder."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

# One folder per person when -User is given; the data dir itself otherwise, so
# a machine that was set up before there was more than one person keeps working
# untouched.
$workDir = if ($User) { Join-Path $DataDir $User } else { $DataDir }
if (-not (Test-Path $workDir)) {
    Write-Error "User folder not found: $workDir`nSee private.example/README.md for the expected layout."
    exit 1
}

# Credentials live next to the data they belong to, not in the machine's
# environment: one machine runs several people's searches, and an environment
# variable can only hold one person's token. The environment stays as the
# fallback for a single-user machine that predates this.
$trackerFile = Join-Path $workDir "tracker.json"
if (Test-Path $trackerFile) {
    $tracker = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
    $trackerUrl = $tracker.url
    $trackerToken = $tracker.token
} else {
    $trackerUrl = $env:TRACKER_URL
    $trackerToken = $env:TRACKER_API_TOKEN
}

if (-not $trackerUrl -or -not $trackerToken) {
    Write-Error "No tracker credentials. Create $trackerFile with {`"url`": `"...`", `"token`": `"...`"}, or set TRACKER_URL and TRACKER_API_TOKEN. See ../server/README.md."
    exit 1
}
$trackerUrl = $trackerUrl.TrimEnd("/")

$logDir = Join-Path $workDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "$Task.log"

# -Encoding utf8 is not optional here. Windows PowerShell 5.1's Out-File
# defaults to UTF-16LE, but this log file may already have been started as
# UTF-8 by an earlier version of this script - appending the default encoding
# to it produces one file with two encodings in it, which grep reports as
# binary and Get-Content silently decodes only the first half of, showing a
# stale tail that looks like the searches stopped running. Pin it explicitly
# on every writer (there are two - see the claude-output append below).
function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    $fallback = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $fallback) { $claude = $fallback } else {
        Log "ERROR: claude CLI not found on PATH or at $fallback"
        Write-Error "claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
        exit 1
    }
}
$claudePath = if ($claude -is [System.Management.Automation.CommandInfo]) { $claude.Source } else { $claude }

# The prompt comes from the tracker, composed from this track's config. A
# failure here is fatal and loud: running a stale or empty prompt would look
# like a search that ran and found nothing, which is the exact ambiguity the
# run record exists to prevent.
Log "===== starting $Task ====="
Log "data dir:         $DataDir"
Log "work dir:         $workDir"
Log "user:             $(if ($User) { $User } else { '(single-user machine)' })"
Log "tracker:          $trackerUrl"
Log "credentials from: $(if (Test-Path $trackerFile) { $trackerFile } else { 'environment' })"

try {
    $promptBody = Invoke-RestMethod -Uri "$trackerUrl/api/prompt/$Task" -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    $hint = switch ($status) {
        401 { "the token in $trackerFile isn't valid (revoked, or from another deployment)" }
        404 { "no track '$Task' is configured for this user - check the tracker's config" }
        default { $_.Exception.Message }
    }
    Log "ERROR: couldn't fetch the prompt ($status): $hint"
    Write-Error "Couldn't fetch the prompt for '$Task' ($status): $hint"
    exit 1
}
if (-not $promptBody) {
    Log "ERROR: the tracker returned an empty prompt for $Task"
    Write-Error "The tracker returned an empty prompt for '$Task'."
    exit 1
}

# ---- Materialize this person's documents into a throwaway directory. -------
#
# $manifest is what makes the write-back decidable: path -> the etag the file
# arrived with and the SHA-256 of its bytes. Afterwards, anything under docs\
# whose hash moved gets sent back, conditional on that etag. Hashes rather than
# "which file is this track's doc_file" on purpose - deriving that would mean
# reimplementing prompt.js's `track.doc_file || docs/tracked_<key>_postings.md`
# fallback in PowerShell, where it is free to drift from the server's version,
# and a run that fills several tabs (fed_by) can legitimately edit a sibling's
# doc, which a single-file rule would silently drop.
$runDir = $null
$manifest = @{}
$headers = @{ Authorization = "Bearer $trackerToken" }

if ($UseLocalFiles) {
    Log "documents:        SKIPPED (-UseLocalFiles) - running against $workDir as-is"
} else {
    $index = $null
    try {
        $index = Invoke-RestMethod -Uri "$trackerUrl/api/documents" -Headers $headers -ErrorAction Stop
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        if ($status -eq 503) {
            # A deployment with no DOCS bucket. Documented as a supported
            # choice (see server/README.md), and the honest answer is the old
            # behaviour: run against whatever is on disk.
            Log "documents:        not configured on this deployment - running against $workDir as-is"
        } else {
            Log "ERROR: couldn't list documents ($status): $($_.Exception.Message)"
            Write-Error "Couldn't list documents for '$Task' ($status). The search needs its baseline doc and resume."
            exit 1
        }
    }

    if ($index) {
        # Zero documents is refused rather than run. The prompt's first step is
        # "read docs/<the baseline doc>" and its second is "read the resume";
        # with neither present the search screens every posting against nothing
        # and reports success, which is indistinguishable from a real quiet
        # night. Almost always means the import has not been run yet.
        if (-not $index.documents -or $index.documents.Count -eq 0) {
            Log "ERROR: the tracker holds no documents for this account."
            Write-Error "No documents for this account - run scripts\import-documents.ps1 first. Refusing to search against an empty profile."
            exit 1
        }

        $runDir = Join-Path (Join-Path $workDir ".run") $Task
        if (Test-Path $runDir) { Remove-Item -Recurse -Force $runDir }
        New-Item -ItemType Directory -Force -Path $runDir | Out-Null

        $oldProgress = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        $bytes = 0
        foreach ($doc in $index.documents) {
            $dest = Join-Path $runDir ($doc.path -replace '/', '\')
            New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
            try {
                # -UseBasicParsing: without it PS 5.1 hands a *successful*
                # response to the IE engine to parse, which tries to prompt and
                # throws under a scheduled task's -NonInteractive.
                Invoke-WebRequest -Uri "$trackerUrl/api/documents/$($doc.path)" `
                    -Headers $headers -OutFile $dest -UseBasicParsing -ErrorAction Stop
            } catch {
                Log "ERROR: couldn't fetch $($doc.path): $($_.Exception.Message)"
                Write-Error "Couldn't fetch document '$($doc.path)'. Refusing to search against a partial profile."
                exit 1
            }
            $got = (Get-Item $dest).Length
            if ($doc.bytes -and $got -ne $doc.bytes) {
                Log "ERROR: $($doc.path) came back $got bytes, expected $($doc.bytes)"
                Write-Error "Document '$($doc.path)' downloaded short. Refusing to search against a truncated profile."
                exit 1
            }
            $manifest[$doc.path] = @{
                etag = $doc.etag
                sha  = (Get-FileHash -Path $dest -Algorithm SHA256).Hash
            }
            $bytes += $got
        }
        $ProgressPreference = $oldProgress
        Log ("documents:        {0} file(s), {1:N0} bytes -> {2}" -f $index.documents.Count, $bytes, $runDir)
    }
}

# Only the working directory moves. $workDir still holds tracker.json and logs\.
$cwd = if ($runDir) { $runDir } else { $workDir }

# This runs as a single headless, non-interactive `claude -p` turn - nobody is
# there to read a "kicked off as a background agent, I'll report back" reply.
# If the model backgrounds any part of the work (a Bash run_in_background
# call, or a subagent), this process's background-task wait ceiling (600s by
# default) kills it and exits before the search finishes - it never gets to
# verify postings, sync leads, or record the run. Confirmed happening for
# real on 2026-08-30 (technical-pm run): the model backgrounded the whole
# search, the ceiling hit, and nothing was synced or recorded even though
# Task Scheduler saw exit code 0. So the prompt has to say explicitly, every
# run, not to do that - it's about how this runner invokes the CLI, which is
# why it's here and not in the prompt the tracker composes.
$prompt = @"
IMPORTANT: this is one single non-interactive headless run. This process
exits as soon as your turn ends, and nobody reads any message after that -
there is no follow-up turn. Do all of the work below yourself, synchronously,
in this one turn. Do not hand any part of it (web searches, URL
verification, curl calls, or the task as a whole) off to a backgrounded Bash
command or a background subagent and end your turn early saying you'll
report back - a backgrounded task does not survive this process exiting, so
it would be killed mid-run and nothing would get verified, synced, or
recorded. If the work risks running long, that's fine - just do it inline;
do not shorten or skip verification steps to save time either.

$promptBody
"@
$allowedTools = "Read Write Edit Glob Grep WebSearch WebFetch Bash"

Log "prompt:           $($promptBody.Length) chars from $trackerUrl/api/prompt/$Task"
Log "claude CLI:       $claudePath"
Log "allowed tools:    $allowedTools"
Log "CLAUDE_CODE_OAUTH_TOKEN set: $([bool]$env:CLAUDE_CODE_OAUTH_TOKEN)"

$job = Start-Job -ScriptBlock {
    param($claudePath, $prompt, $allowedTools, $cwd, $trackerUrl, $trackerToken)
    Set-Location $cwd
    # The prompt's own curl calls read these from the environment. Set inside
    # the script block because Start-Job runs in its own process - and set from
    # the resolved per-user values, so two people's searches on one machine
    # each authenticate as themselves.
    $env:TRACKER_URL = $trackerUrl
    $env:TRACKER_API_TOKEN = $trackerToken
    # The claude CLI writes UTF-8. Without this, PowerShell decodes its stdout
    # using the console's OEM codepage instead, so every non-ASCII character
    # the model writes is mangled before it ever reaches the log file - an
    # em-dash lands as "-o" garbage, and no amount of fixing the file's own
    # encoding recovers it, because the damage happened upstream of the write.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    & $claudePath -p $prompt --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $cwd, $trackerUrl, $trackerToken

$start = Get-Date
Log "job started (id $($job.Id)), waiting..."

while ($job.State -eq "Running") {
    Start-Sleep -Seconds 20
    $elapsed = [int]((Get-Date) - $start).TotalSeconds
    Log "... still running (${elapsed}s elapsed)"
}

$output = Receive-Job $job -ErrorAction SilentlyContinue
$jobState = $job.State
Remove-Job $job -Force

Log "----- claude output -----"
if ($output) { $output | Out-String | Out-File -Append -Encoding utf8 -FilePath $logFile }
Log "----- end output -----"

$exitCode = if ($jobState -eq "Completed") { 0 } else { 1 }

# ---- Write back what the run edited. --------------------------------------
#
# Only docs\. resumes\ and reference\ are inputs, and a rule that discards
# changes there is a better guarantee than an instruction in a prompt asking
# the model not to make them.
#
# A failure here is fatal even when the search itself succeeded, and that is
# the point: the run's findings are in that document. Reporting success while
# they sit in a directory the next run wipes would be the same class of bug as
# a run that exits 0 having synced nothing.
if ($runDir -and $manifest.Count -gt 0) {
    $sent = 0
    foreach ($rel in @($manifest.Keys)) {
        $local = Join-Path $runDir ($rel -replace '/', '\')
        $folder = $rel.Split("/")[0]

        if (-not (Test-Path $local)) {
            # Never mirrored as a delete. Removing someone's baseline doc
            # because a run deleted its local copy is not a decision this
            # script gets to make on its own.
            Log "WARNING: $rel is gone from the run directory - left untouched in the tracker."
            continue
        }

        $now = (Get-FileHash -Path $local -Algorithm SHA256).Hash
        if ($now -eq $manifest[$rel].sha) { continue }

        if ($folder -ne "docs") {
            Log "WARNING: $rel changed during the run and was discarded - only docs/ is written back."
            continue
        }

        try {
            $body = [System.IO.File]::ReadAllBytes($local)
            $null = Invoke-WebRequest -Uri "$trackerUrl/api/documents/$rel" -Method Put `
                -Headers (@{ Authorization = "Bearer $trackerToken"; "If-Match" = $manifest[$rel].etag }) `
                -Body $body -ContentType "text/markdown" -UseBasicParsing -ErrorAction Stop
            $sent++
            Log ("wrote back {0} ({1:N0} bytes)" -f $rel, $body.Length)
        } catch {
            $status = $_.Exception.Response.StatusCode.value__
            if ($status -eq 412) {
                # Something wrote this document between the fetch and now. The
                # run's copy is the newer *edit* but the older *base*, so
                # sending it would erase whatever landed in between. Keep it
                # where a person can merge it by hand.
                $rescue = Join-Path $logDir "$Task-doc-conflict-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
                Copy-Item $local $rescue -Force
                Log "ERROR: $rel changed underneath this run (412). This run's version: $rescue"
                Write-Error "'$rel' was modified during the run. This run's copy is at $rescue - merge it by hand; nothing was overwritten."
            } else {
                Log "ERROR: couldn't write back $rel ($status): $($_.Exception.Message)"
                Write-Error "Couldn't write back '$rel' ($status). The run's edits are in $local - do not let the next run wipe it."
            }
            $exitCode = 1
        }
    }
    Log "write-back:       $sent document(s) updated"
}

$elapsed = [int]((Get-Date) - $start).TotalSeconds
Log "finished $Task - job state: $jobState, elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
