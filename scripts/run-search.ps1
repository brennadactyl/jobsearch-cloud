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

  tracker.ps1 is copied in beside them, with a `tracker` shim next to it, and
  that is what the prompt's sync steps invoke (`./tracker leads leads.json`)
  instead of composing curl calls out of prose. The helper reads TRACKER_URL,
  TRACKER_API_TOKEN and TRACKER_SEARCH from the environment this script sets
  for the run, so nothing about the calling convention has to reach the model.
  See ./tracker.ps1 and ../docs/prompt-size-plan.md.

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
  it. Bash is unscoped rather than limited to a pattern: back when the prompt
  carried curl invocations, "Bash(curl:*)" blocked the model from even checking
  whether TRACKER_URL/TRACKER_API_TOKEN were set first. It is now what runs
  ./tracker, and narrowing it to that would be a fresh version of the same
  mistake the first time a run has a reason to run anything else.

  Logs a config summary at the start, a heartbeat line every 20s while the
  search is running (searches take several minutes - without this the log
  looks identical whether it's working or stuck), and the full output plus
  exit status at the end.

  ---- A run that fails says so in the tracker, not only to Task Scheduler.

  Every path that decides this run failed records it (`POST /api/runs` with
  `status: "error"` and the reason) before exiting. Until that existed the run
  record was written only by the model, from a step at the end of the composed
  prompt, so a run that died before reaching that step left nothing behind at
  all - and a missing record reads on the page as a stale run stamp, which is
  indistinguishable from a night that genuinely found nothing. That is the one
  thing the record exists to tell apart.

  The model's own success record is left alone. What this adds on top of it is
  a check that there is one: after the CLI returns, the run record for this
  track has to be newer than this run's start, or the run failed for a reason
  no list of known failure strings had on it. Asserting what a success looks
  like catches the next failure; listing what the last three looked like does
  not.

  Calls to the tracker retry a transient failure - a Cloudflare 1101, a 429, a
  connection that never got an answer - with backoff, and stop at once on
  anything the server actually means. ./tracker.ps1 applies the same rule to
  the calls the run itself makes.

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

# ---- Transient failures. ---------------------------------------------------
#
# The same rule and the same numbers as scripts/tracker.ps1, deliberately:
# these are two halves of one night's traffic to one worker, and a run should
# not get a different answer about what is worth retrying depending on which
# half made the call.
#
# Cloudflare answers a Worker *exception* with a 5xx whose body is
# `error code: 1101`. On 2026-09-10 three consecutive GETs to /api/documents
# got one during rapid sequential requests and all three succeeded immediately
# on retry. That path is fatal here - a document that will not download aborts
# the run before the search starts - so an unretried blip costs a whole night
# and nothing was wrong.
#
#   retry   no status at all (the connection never got an answer: reset, DNS,
#           timeout), 429, and any other 5xx - which is where 1101 lands.
#   stop    503, and every 4xx except 429. A 4xx is the server saying the
#           request itself is wrong, and it will be as wrong in twelve seconds.
#           503 is excluded from the 5xx rule on this API's own terms: it is
#           what a handler returns when the deployment is missing a binding,
#           where "the fix is a config change rather than a retry"
#           (server/src/routes/documents.js) - and the document listing below
#           branches on precisely that.
$RetryAttempts = 4
$RetryBackoff = @(2, 5, 12)

function Get-HttpStatus($err) {
    $resp = $err.Exception.Response
    if (-not $resp) { return 0 }
    try { return [int]$resp.StatusCode } catch { return 0 }
}

function Test-Transient($status) {
    if ($status -eq 503) { return $false }
    return ($status -eq 0 -or $status -eq 429 -or $status -ge 500)
}

# Re-runs $action until it stops failing transiently, then rethrows the last
# error unchanged - so every caller's existing catch block still sees exactly
# what it saw before, and the retry is invisible to the handling around it.
function Invoke-WithRetry($what, $action) {
    for ($attempt = 1; ; $attempt++) {
        try {
            return & $action
        } catch {
            $status = Get-HttpStatus $_
            if ($attempt -ge $RetryAttempts -or -not (Test-Transient $status)) { throw }
            $wait = $RetryBackoff[[Math]::Min($attempt - 1, $RetryBackoff.Count - 1)]
            Log "transient failure on $what ($status) - retrying in ${wait}s (attempt $attempt of $RetryAttempts)"
            Start-Sleep -Seconds $wait
        }
    }
}

# ---- Recording a run that failed. ------------------------------------------
#
# Until this existed the run record was written only by the model, from the
# `./tracker run` step at the end of the composed prompt - so a run that died
# before reaching that step wrote nothing at all. `grep -c "api/runs"
# run-search.ps1` returned 0.
#
# That is exactly the 2026-09-10 failure: the CLI never started, the run lasted
# twenty seconds, nothing was searched or synced, and the task reported exit 0.
# No run record, so the tracker page showed a stale run stamp - indistinguishable
# from a night that genuinely found nothing. The record exists to tell those two
# apart, and it was absent in the one case where that mattered most.
#
# None of this is inferred. The runner already decides, in code, that the CLI
# never started; it simply had nowhere to put that knowledge except an exit code
# only Task Scheduler ever sees.
#
# Best-effort on purpose: if the tracker cannot be reached the run has still
# failed, and the original reason is still the one worth reporting, so a failure
# to record is logged and swallowed rather than replacing it.
$script:runRecorded = $false
$script:failed = $false
$script:failureNote = ""

function Record-FailedRun($note) {
    # At most one record per run, and always the first reason given: that is the
    # one describing what actually went wrong, where a later one is usually its
    # consequence.
    if ($script:runRecorded) { return }
    $script:runRecorded = $true
    try {
        $body = @{
            search = $Task
            status = "error"
            # Today's *local* date, by the same rule and for the same reason as
            # tracker.ps1's: letting the server fall back to its own UTC date
            # stamps an evening run with tomorrow.
            on     = (Get-Date).ToString("yyyy-MM-dd")
            # Prefixed, so the morning after can tell a record the runner wrote
            # about a run that never started from one a search wrote about
            # itself.
            note   = "runner: $note"
        } | ConvertTo-Json -Depth 5 -Compress
        $null = Invoke-WithRetry "POST /api/runs" {
            Invoke-RestMethod -Uri "$trackerUrl/api/runs" -Method Post `
                -Headers @{ Authorization = "Bearer $trackerToken" } `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
                -ContentType "application/json; charset=utf-8" -ErrorAction Stop
        }
        Log "run record:       wrote '$Task' as 'error' - $note"
    } catch {
        Log "WARNING: couldn't record the failed run ($(Get-HttpStatus $_)): $($_.Exception.Message)"
        Log "         The run still failed for the reason above - this line is only about recording it."
    }
}

# Marks the run failed, and records it there and then rather than at the end.
#
# The timing is not incidental. $ErrorActionPreference is "Stop", which makes
# Write-Error a *terminating* error: a failure in the write-back loop below
# ends the script on the spot, and anything left to the tail of the file - a
# summary line, a deferred POST - never happens. Recording at the moment of
# failure is the only placement that survives every exit this script has.
#
# It also means marking a run failed and giving a reason are one operation, so
# a future failure path cannot do the first without the second, and the reason
# it gives is the one that reaches the tracker.
function Set-Failed($note) {
    Log "ERROR: $note"
    if (-not $script:failureNote) { $script:failureNote = $note }
    $script:failed = $true
    Record-FailedRun $note
}

# Every fatal path goes through here, so recording a failure is not something a
# new one can forget: it is what exiting looks like. The three checks above this
# point - no data dir, no user folder, no credentials - cannot use it, because
# there is by definition no tracker to record to yet.
function Stop-Run($note, $userMessage) {
    Set-Failed $note
    Write-Error $userMessage
    exit 1
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    $fallback = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $fallback) { $claude = $fallback } else {
        Stop-Run "the claude CLI is not on PATH or at $fallback - nothing was searched or synced" "claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
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
    $promptBody = Invoke-WithRetry "GET /api/prompt/$Task" {
        Invoke-RestMethod -Uri "$trackerUrl/api/prompt/$Task" -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
    }
} catch {
    $status = Get-HttpStatus $_
    $hint = switch ($status) {
        401 { "the token in $trackerFile isn't valid (revoked, or from another deployment)" }
        404 { "no track '$Task' is configured for this user - check the tracker's config" }
        default { $_.Exception.Message }
    }
    # A 401 or a 404 here means the POST below will be refused for the same
    # reason, and that is fine: it is attempted, it fails, and the run exits on
    # the error that actually explains the night. Recording is best-effort
    # precisely so the cases where it cannot work cost nothing.
    Stop-Run "couldn't fetch the prompt ($status): $hint" "Couldn't fetch the prompt for '$Task' ($status): $hint"
}
if (-not $promptBody) {
    Stop-Run "the tracker returned an empty prompt for $Task" "The tracker returned an empty prompt for '$Task'."
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
        $index = Invoke-WithRetry "GET /api/documents" {
            Invoke-RestMethod -Uri "$trackerUrl/api/documents" -Headers $headers -ErrorAction Stop
        }
    } catch {
        $status = Get-HttpStatus $_
        if ($status -eq 503) {
            # A deployment with no DOCS bucket. Documented as a supported
            # choice (see server/README.md), and the honest answer is the old
            # behaviour: run against whatever is on disk.
            Log "documents:        not configured on this deployment - running against $workDir as-is"
        } else {
            Stop-Run "couldn't list documents ($status): $($_.Exception.Message)" "Couldn't list documents for '$Task' ($status). The search needs its baseline doc and resume."
        }
    }

    if ($index) {
        # Zero documents is refused rather than run. The prompt's first step is
        # "read docs/<the baseline doc>" and its second is "read the resume";
        # with neither present the search screens every posting against nothing
        # and reports success, which is indistinguishable from a real quiet
        # night. Almost always means the import has not been run yet.
        if (-not $index.documents -or $index.documents.Count -eq 0) {
            Stop-Run "the tracker holds no documents for this account" "No documents for this account - run scripts\import-documents.ps1 first. Refusing to search against an empty profile."
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
                # This is the call that returned `error code: 1101` three times
                # running on 2026-09-10 and succeeded on retry every time. It is
                # also fatal, which makes it the most valuable place in this
                # script for a retry: one Worker exception on one document
                # otherwise costs the entire night.
                Invoke-WithRetry "GET /api/documents/$($doc.path)" {
                    # -UseBasicParsing: without it PS 5.1 hands a *successful*
                    # response to the IE engine to parse, which tries to prompt
                    # and throws under a scheduled task's -NonInteractive.
                    Invoke-WebRequest -Uri "$trackerUrl/api/documents/$($doc.path)" `
                        -Headers $headers -OutFile $dest -UseBasicParsing -ErrorAction Stop
                }
            } catch {
                Stop-Run "couldn't fetch $($doc.path) ($(Get-HttpStatus $_)): $($_.Exception.Message)" "Couldn't fetch document '$($doc.path)'. Refusing to search against a partial profile."
            }
            $got = (Get-Item $dest).Length
            if ($doc.bytes -and $got -ne $doc.bytes) {
                Stop-Run "$($doc.path) came back $got bytes, expected $($doc.bytes)" "Document '$($doc.path)' downloaded short. Refusing to search against a truncated profile."
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

# ---- Ship the API helper into the working directory. -----------------------
#
# The prompt names commands (`./tracker leads leads.json`) rather than
# describing curl calls, so the helper has to be somewhere the run can reach by
# a relative path - the same reasoning that puts the documents there. Copied
# fresh every run, so an edit to tracker.ps1 takes effect on the next search
# with nothing to redeploy.
#
# The shim exists because the run's shell is POSIX (that is what let the old
# prompt's `curl -d '{...}'` work at all) and cannot execute a .ps1. It is
# written with LF endings and no BOM on purpose: a CR or a BOM ahead of the
# shebang is not a shebang, and the failure is an unrunnable file rather than a
# readable error.
$helperSrc = Join-Path $PSScriptRoot "tracker.ps1"
if (-not (Test-Path $helperSrc)) {
    Stop-Run "$helperSrc is missing - the run would have no way to sync anything" "scripts\tracker.ps1 not found. The search prompt invokes it for every API call."
}
Copy-Item -Path $helperSrc -Destination (Join-Path $cwd "tracker.ps1") -Force
$shim = "#!/bin/sh`n" +
        "# Written by run-search.ps1 - see tracker.ps1.`n" +
        "exec powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tracker.ps1 `"`$@`"`n"
[System.IO.File]::WriteAllText(
    (Join-Path $cwd "tracker"), $shim, (New-Object System.Text.UTF8Encoding($false)))
Log "helper:           tracker.ps1 + tracker -> $cwd"

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
    param($claudePath, $prompt, $allowedTools, $cwd, $trackerUrl, $trackerToken, $task)
    Set-Location $cwd
    # tracker.ps1 reads these from the environment. Set inside the script block
    # because Start-Job runs in its own process - and set from the resolved
    # per-user values, so two people's searches on one machine each
    # authenticate as themselves.
    $env:TRACKER_URL = $trackerUrl
    $env:TRACKER_API_TOKEN = $trackerToken
    # Which track this run is. The helper stamps it on every row it sends, so
    # a `search` value is one thing the prompt no longer has to state and the
    # run no longer has to get right.
    $env:TRACKER_SEARCH = $task
    # The claude CLI writes UTF-8. Without this, PowerShell decodes its stdout
    # using the console's OEM codepage instead, so every non-ASCII character
    # the model writes is mangled before it ever reaches the log file - an
    # em-dash lands as "-o" garbage, and no amount of fixing the file's own
    # encoding recovers it, because the damage happened upstream of the write.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    # The prompt goes in on stdin rather than as an argument. Windows caps a
    # command line at ~32k characters and the composed prompt is most of the way
    # there on its own, so a track whose config gains a paragraph pushes the
    # whole invocation over. What comes back is not a prompt error - it is
    # `Program 'claude.exe' failed to run: The filename or extension is too long`
    # from the npm shim, i.e. the CLI never starts.
    #
    # That happened on 2026-09-10: 31,877 characters of prompt, twenty seconds,
    # nothing searched, nothing synced - and because the *job* completed, the
    # runner reported exit 0 and Task Scheduler recorded a success. Piping has no
    # such ceiling, so prompt length stops being something the runner can die of.
    # Shrinking the prompt is worth doing on its own merits (see
    # docs/prompt-size-plan.md); it is not what keeps this from breaking again.
    $prompt | & $claudePath -p --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $cwd, $trackerUrl, $trackerToken, $Task

$start = Get-Date
# Kept in UTC because it gets compared against a timestamp the *worker* wrote.
# See the run-record assertion below - that is the whole reason this is
# captured rather than derived from the elapsed time at the end.
$startedAtUtc = $start.ToUniversalTime()
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

if ($jobState -ne "Completed") {
    Set-Failed "the CLI job ended in state '$jobState' - nothing was searched or synced"
}

# ---- What failure is known to look like. -----------------------------------
#
# The CLI exiting cleanly is not the same as the CLI having done anything. An
# unauthenticated run prints "Not logged in - Please run /login" and exits 0:
# job state Completed, twenty seconds, nothing searched, nothing synced, and
# Task Scheduler records a success. run-fill.ps1 has guarded this since its own
# first real invocation did exactly that; this one never did, and it cost a run
# on 2026-09-09 that reported 0x0 having done nothing at all.
#
# It matters as much here as there. A search that finds nothing writes nothing,
# so "ran and found nothing" and "never ran" look identical on the page - the
# run record is what tells them apart, and an unauthenticated run does not
# write one either.
#
# Checked against the output rather than by pre-flighting the credential: the
# token is read by the CLI in a child process, and what matters is whether that
# process could use it, not whether this one can see it.
#
# This is a denylist, and it is kept for what a denylist is good at: it names
# the cause. "The CLI is not authenticated" is a better thing to find in a log
# than "no run record", and it costs no round trip. What it cannot do is catch
# the next failure, which is what the assertion after it is for.
$outputText = if ($output) { ($output | Out-String).Trim() } else { "" }
if (-not $outputText) {
    Set-Failed "the CLI produced no output at all - nothing was searched or synced"
} elseif ($outputText -match "Not logged in|Please run /login|Invalid API key|authentication_error") {
    Set-Failed "the CLI is not authenticated - nothing was searched or synced"
    Log "       Run ``claude setup-token``, then: setx CLAUDE_CODE_OAUTH_TOKEN ""<token>"""
} elseif ($outputText -match "failed to run|ApplicationFailedException|NativeCommandFailed|is too long") {
    # The CLI never started. This is the same class of failure as the one above -
    # the job completes, the elapsed time looks like a fast run, and nothing was
    # searched - but it comes from the shim rather than from the CLI, so the
    # authentication patterns miss it entirely. Seen on 2026-09-10 when the
    # prompt was passed as an argument and exceeded the Windows command-line
    # limit; that specific cause is fixed above, and this stays because "the
    # launcher failed" must not keep reading as success.
    Set-Failed "the CLI failed to start - nothing was searched or synced"
    Log "       See the output above; a launcher failure is not a search result."
}

# ---- What success is required to look like. --------------------------------
#
# The guard above lists what failure looked like the last three times. It was
# written against the CLI's own output and did not survive the first failure
# that arrived from the npm shim *above* the CLI - same silence, same false
# success, a source nobody had thought to list. A denylist misses the next one
# by construction, so this asks the opposite question, and asks it of the
# tracker rather than of the output: did this run do the one thing every run
# does?
#
# The run record, and only the run record. A good night usually also leaves
# leads, screened rows and verifications - but "usually" is not something that
# can be asserted, and a genuinely quiet night that added no leads must not
# read as a failure. The record is the one artefact every run writes
# unconditionally, including the runs that found nothing, which is the entire
# reason it exists (server/src/routes/runs.js).
#
# Checked by *instant*, not by date. A record stamped today is not evidence
# that this run wrote it: an earlier run of the same track earlier the same day
# satisfies that, and re-running after a failure is exactly when someone is
# watching. So the record has to be newer than this run's start, with a few
# minutes of slack because that timestamp is the edge's clock and the start is
# this machine's.
#
# Skipped when the run has already failed: there is a specific reason in hand,
# and it is a better one than anything this could add.
if (-not $script:failed) {
    $config = $null
    try {
        $config = Invoke-WithRetry "GET /api/config" {
            Invoke-RestMethod -Uri "$trackerUrl/api/config" -Headers $headers -ErrorAction Stop
        }
    } catch {
        # Not evidence of anything. This is the check being unable to look,
        # which is a different thing from having looked and found nothing, and
        # only one of the two means the run failed. Treating them alike would
        # make a network blip at 01:30 indistinguishable from a search that
        # never ran, which is the confusion this whole section exists to end.
        Log "WARNING: couldn't ask the tracker whether the run recorded itself ($(Get-HttpStatus $_)): $($_.Exception.Message)"
        Log "         The run is left as it stands - unable to check is not the same as failed."
    }

    if ($config) {
        $track = @($config.tracks | Where-Object { $_ -and $_.key -eq $Task })[0]
        $recordedAt = $null
        if ($track -and $track.last_run -and $track.last_run.at) {
            try {
                $recordedAt = [datetime]::Parse(
                    $track.last_run.at,
                    [System.Globalization.CultureInfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
            } catch {
                Log "WARNING: couldn't read the run record's timestamp '$($track.last_run.at)'"
            }
        }

        if (-not $track) {
            # Not called a failed run: the POST would be refused for the same
            # reason (runs.js rejects an unknown track key), and the track being
            # absent is a config problem rather than a search that didn't happen.
            Log "WARNING: the tracker has no track '$Task' - can't check for a run record."
        } elseif ($null -eq $recordedAt -or $recordedAt -lt $startedAtUtc.AddMinutes(-5)) {
            $seen = if ($null -eq $recordedAt) { "there has never been one" } else { "the newest is from $($track.last_run.at)" }
            Set-Failed "'$Task' recorded no run for tonight - $seen. The CLI exited cleanly and matched no known failure, so nothing was synced for a reason not on any list."
        } elseif ($track.last_run.status -eq "error") {
            # The run reached its own recording step and reported a failure. It
            # is already in the tracker, honestly, so there is nothing to write -
            # but the task must not go on reporting exit 0 over the top of it.
            $script:runRecorded = $true
            Set-Failed "'$Task' recorded itself as 'error': $($track.last_run.note)"
        } else {
            Log "run record:       '$Task' recorded 'ok' at $($track.last_run.at)"
        }
    }
}
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
            # Retried on a transient failure like every other call, and the 412
            # below is why that is worth spelling out. A PUT that lands but
            # whose response is lost leaves the retry looking at a document
            # whose etag has moved, so the retry gets a 412 and this reports a
            # conflict that nobody caused.
            #
            # Still the right trade, in both directions. The window for that is
            # the width of one lost response, where a plain 5xx is whatever
            # Cloudflare is having; and the false conflict is loud and costs
            # nothing - the tracker already holds the bytes this run wrote, and
            # the rescue copy beside the log is identical to them. The opposite
            # arrangement, treating a post-retry 412 as success, would call the
            # run a success in the one case where somebody really did write
            # over it. Erring loud is the whole disposition of this script.
            $null = Invoke-WithRetry "PUT /api/documents/$rel" {
                Invoke-WebRequest -Uri "$trackerUrl/api/documents/$rel" -Method Put `
                    -Headers (@{ Authorization = "Bearer $trackerToken"; "If-Match" = $manifest[$rel].etag }) `
                    -Body $body -ContentType "text/markdown" -UseBasicParsing -ErrorAction Stop
            }
            $sent++
            Log ("wrote back {0} ({1:N0} bytes)" -f $rel, $body.Length)
        } catch {
            $status = Get-HttpStatus $_
            if ($status -eq 412) {
                # Something wrote this document between the fetch and now. The
                # run's copy is the newer *edit* but the older *base*, so
                # sending it would erase whatever landed in between. Keep it
                # where a person can merge it by hand.
                $rescue = Join-Path $logDir "$Task-doc-conflict-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
                Copy-Item $local $rescue -Force
                # Set-Failed records the run before Write-Error is reached, and
                # that ordering is load-bearing here: $ErrorActionPreference is
                # "Stop", so the Write-Error below ends the script on the spot.
                # Nothing after this loop runs - not the summary line, not the
                # "finished" line, not the exit at the bottom of the file.
                Set-Failed "$rel changed underneath this run (412). This run's version: $rescue"
                Write-Error "'$rel' was modified during the run. This run's copy is at $rescue - merge it by hand; nothing was overwritten."
            } else {
                Set-Failed "couldn't write back $rel ($status): $($_.Exception.Message)"
                Write-Error "Couldn't write back '$rel' ($status). The run's edits are in $local - do not let the next run wipe it."
            }
        }
    }
    Log "write-back:       $sent document(s) updated"
}

# One place decides the exit code, from one flag, and every path that sets that
# flag has already recorded the run - see Set-Failed. There is no longer a way
# to decide this run failed and still leave the tracker with nothing to show
# for it.
$exitCode = if ($script:failed) { 1 } else { 0 }
$elapsed = [int]((Get-Date) - $start).TotalSeconds
Log "finished $Task - job state: $jobState, elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
