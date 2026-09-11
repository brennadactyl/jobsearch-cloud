<#
.SYNOPSIS
  Runs one daily job-search prompt through the Claude Code CLI.

.DESCRIPTION
  Fetches one track's prompt
  from the tracker (`GET /api/prompt/<task>`), downloads that person's documents
  into a throwaway run directory, runs the prompt headless via `claude -p`,
  writes back any docs\ file the run changed, and logs to
  <DataDir>\<User>\logs\<Task>.log.

  The prompt is composed server-side from the track's config in D1 (see
  ../server/src/prompt.js), so one machine can run several people's searches
  without holding their search config.

  The tool allowlist exists so a run never stalls on a permission prompt with
  nobody there to answer it. Bash stays unscoped: it runs ./tracker, and a
  pattern-scoped Bash blocks anything else a run has reason to do, down to
  checking whether an environment variable is set.

.PARAMETER Task
  Which track to run - any track key configured for this user in the tracker
  (e.g. "SWE", "engineering").

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
  Skip the document fetch and run against whatever is already on disk in the
  work dir. For debugging a run against hand-edited files; a scheduled run
  should never use it.

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

$workDir = if ($User) { Join-Path $DataDir $User } else { $DataDir }
if (-not (Test-Path $workDir)) {
    Write-Error "User folder not found: $workDir`nSee private.example/README.md for the expected layout."
    exit 1
}

# Credentials come from the person's own folder: one machine runs several
# people's searches, and an environment variable holds only one token. The
# environment is the single-user fallback.
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

# -Encoding utf8 on every writer to this log (here and the claude-output append
# below). Windows PowerShell 5.1's Out-File defaults to UTF-16LE, and mixing
# encodings in one file makes grep report it as binary and Get-Content decode
# only part of it, showing a stale tail.
function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

# ---- Transient failures. ---------------------------------------------------
#
# Same rule and numbers as tracker.ps1, which explains them; change both
# together. The document listing below relies on 503 not being retried.
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

# Rethrows the last error unchanged, so each caller's catch block handles it
# exactly as it would without the retry.
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

# ---- Recording a failed run, from wherever the run gives up. ---------------
#
# A run that dies before its own `./tracker run` step writes no run record, and
# "never ran" then looks the same on the page as "ran and found nothing". So a
# failure is recorded (`POST /api/runs`, status "error") at the moment the run
# gives up, not only at the tail, which two kinds of failure never reach:
#
#   - Every fatal check before the CLI is launched exits on the spot.
#   - The write-back loop. With $ErrorActionPreference "Stop", Write-Error is a
#     terminating error: the script ends inside that catch, and nothing after
#     the loop runs.
#
# Fires once, keeping the first reason: a later one is usually its consequence.
# Never fatal and never touches $exitCode - an unreachable tracker costs a log
# line, not a second failure.
#
# A direct call rather than `./tracker run`: the helper lives in the run
# directory this script builds, so a reporter that depends on it is silent when
# the run never got that far.
$scriptStart = Get-Date
$script:runRecorded = $false

function Record-FailedRun($reason) {
    if ($script:runRecorded) { return }
    $script:runRecorded = $true
    $secs = [int]((Get-Date) - $scriptStart).TotalSeconds
    $note = "runner-reported failure after ${secs}s: $reason"
    try {
        $null = Invoke-WithRetry "POST /api/runs" {
            Invoke-RestMethod -Uri "$trackerUrl/api/runs" -Method Post -TimeoutSec 30 `
                -Headers @{ Authorization = "Bearer $trackerToken" } `
                -ContentType "application/json" `
                -Body (@{
                    search = $Task
                    status = "error"
                    # Local date: the server's UTC default stamps an evening
                    # run with tomorrow.
                    on     = (Get-Date).ToString("yyyy-MM-dd")
                    note   = $note
                } | ConvertTo-Json -Compress)
        }
        Log "recorded a failed run against $Task - the page will show it as an error rather than a stale stamp"
    } catch {
        Log "WARNING: could not record the failed run ($($_.Exception.Message)). The failure above still stands; only the tracker's copy of it is missing."
    }
}

# Every fatal path before the CLI runs exits through here, so none can skip
# recording. The checks above - data dir, user folder, credentials - cannot use
# it, since there is no tracker to record to yet.
function Stop-Run($reason, $userMessage) {
    Log "ERROR: $reason"
    Record-FailedRun $reason
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

# A prompt fetch failure is fatal: a stale or empty prompt would look like a
# search that ran and found nothing.
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
    # After a 401 or 404 the failure record is refused too; recording is
    # best-effort, so the run still exits on the error that explains it.
    Stop-Run "couldn't fetch the prompt ($status): $hint" "Couldn't fetch the prompt for '$Task' ($status): $hint"
}
if (-not $promptBody) {
    Stop-Run "the tracker returned an empty prompt for $Task" "The tracker returned an empty prompt for '$Task'."
}

# ---- Materialize this person's documents into a throwaway directory. -------
#
# Wiped and refilled every run, so the search reads what the tracker holds and
# a run's scratch never accumulates in the durable folder.
#
# $manifest maps path -> the etag the file arrived with and its SHA-256. The
# write-back sends any docs\ file whose hash changed, conditional on that etag.
# Hashes rather than the track's doc_file: deriving that would reimplement
# prompt.js's `track.doc_file || docs/tracked_<key>_postings.md` fallback here,
# where it can drift, and a run that fills several tabs (fed_by) can
# legitimately edit a sibling's doc.
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
            # A deployment with no DOCS bucket, which is supported (see
            # server/README.md): run against whatever is on disk.
            Log "documents:        not configured on this deployment - running against $workDir as-is"
        } else {
            Stop-Run "couldn't list documents ($status): $($_.Exception.Message)" "Couldn't list documents for '$Task' ($status). The search needs its baseline doc and resume."
        }
    }

    if ($index) {
        # Zero documents is refused: with no baseline doc and no resume the
        # search screens every posting against nothing and reports success,
        # which looks like a quiet night. Usually the import has not been run.
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
# The prompt invokes `./tracker <command>` by relative path, so the helper is
# copied in beside the documents - fresh every run, so an edit to tracker.ps1
# takes effect on the next search with nothing to redeploy.
#
# The run's shell is POSIX and cannot execute a .ps1, hence the shim. It is
# written with LF endings and no BOM: a CR or a BOM ahead of the shebang makes
# the file unrunnable rather than producing a readable error.
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

# The CLI runs as one headless `claude -p` turn with nobody to read an "I'll
# report back" reply. If the model backgrounds any part of the work (a Bash
# run_in_background call, or a subagent), the CLI's background-task wait
# ceiling (600s by default) ends the process before the search finishes:
# nothing is verified, synced or recorded, and the exit code is still 0. The
# preamble forbids it on every run. It lives here rather than in the tracker's
# prompt because it is about how this runner invokes the CLI.
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

# ---- The run record as it stands before this run touches anything. ---------
#
# The post-run check compares against this value rather than a clock: "the
# record changed" is exact, while "newer than $start" mixes this machine's clock
# with Cloudflare's and has no correct slack.
#
# $null means no baseline could be read; the check then says so and declines to
# judge.
$recordBefore = $null
try {
    $cfgBefore = Invoke-WithRetry "GET /api/config" {
        Invoke-RestMethod -Uri "$trackerUrl/api/config" -TimeoutSec 30 `
            -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
    }
    $trackBefore = $cfgBefore.tracks | Where-Object { $_.key -eq $Task } | Select-Object -First 1
    $recordBefore = if ($trackBefore -and $trackBefore.last_run) { [string]$trackBefore.last_run.at } else { "" }
    Log "run record before: $(if ($recordBefore) { $recordBefore } else { '(never recorded)' })"
} catch {
    Log "WARNING: couldn't read this track's run record before starting ($($_.Exception.Message)) - the post-run check will have nothing to compare against."
}

$job = Start-Job -ScriptBlock {
    param($claudePath, $prompt, $allowedTools, $cwd, $trackerUrl, $trackerToken, $task)
    Set-Location $cwd
    # For tracker.ps1. Set inside the script block because Start-Job runs in
    # its own process, and from the resolved per-user values so each person's
    # search authenticates as themselves.
    $env:TRACKER_URL = $trackerUrl
    $env:TRACKER_API_TOKEN = $trackerToken
    # The helper stamps this on every row it sends, so the run never has to
    # state its own track key.
    $env:TRACKER_SEARCH = $task
    # The claude CLI writes UTF-8. Without this, PowerShell decodes its stdout
    # with the console's OEM codepage and mangles every non-ASCII character
    # before it reaches the log, beyond any later repair.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    # The prompt goes in on stdin rather than as an argument. Windows caps a
    # command line at ~32k characters, and over it the npm shim fails with
    # `Program 'claude.exe' failed to run: The filename or extension is too long`:
    # the CLI never starts, yet the job completes and the task records a
    # success. Piping has no such limit.
    $prompt | & $claudePath -p --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $cwd, $trackerUrl, $trackerToken, $Task

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

# The CLI exiting cleanly is not the same as the CLI having done anything. An
# unauthenticated CLI prints "Not logged in - Please run /login" and exits 0, so
# the job completes, nothing is searched or synced, and Task Scheduler records a
# success.
#
# Checked against the output rather than by pre-flighting the credential: the
# token is read by the CLI in a child process, and what matters is whether that
# process could use it, not whether this one can see it.
$outputText = if ($output) { ($output | Out-String).Trim() } else { "" }
# Carried into the failed-run record, so the tracker says why.
$failureReason = if ($jobState -ne "Completed") { "the run did not complete (job state: $jobState)" } else { "" }
if (-not $outputText) {
    Log "ERROR: the CLI produced no output at all - nothing was searched or synced"
    $failureReason = "the CLI produced no output - nothing was searched or synced"
    $exitCode = 1
} elseif ($outputText -match "Not logged in|Please run /login|Invalid API key|authentication_error|Failed to authenticate|Invalid bearer token|401") {
    Log "ERROR: the CLI is not authenticated - nothing was searched or synced."
    Log "       Run ``claude setup-token``, then: setx CLAUDE_CODE_OAUTH_TOKEN ""<token>"""
    $failureReason = "the CLI is not authenticated - nothing was searched or synced"
    $exitCode = 1
} elseif ($outputText -match "failed to run|ApplicationFailedException|NativeCommandFailed|is too long") {
    # The launcher failed and the CLI never started. The message comes from the
    # shim rather than the CLI, so the authentication patterns miss it.
    Log "ERROR: the CLI failed to start - nothing was searched or synced."
    Log "       See the output above; a launcher failure is not a search result."
    $failureReason = "the CLI failed to start - nothing was searched or synced"
    $exitCode = 1
}

# ---- Did the run actually record itself? ----------------------------------
#
# The output patterns above are a denylist and miss any failure that looks new.
# A run that worked wrote its own run record (step 9c, `./tracker run`), so a
# record unchanged since this run started means the run did not finish, whatever
# the output says.
#
# This can only turn a false success into a failure: if the tracker cannot be
# reached, it says so and leaves $exitCode alone. Only the run record is
# asserted, never leads or screened rows - a quiet night adds none, and the
# record is the one thing every run writes.
if ($exitCode -eq 0) {
    if ($null -eq $recordBefore) {
        Log "WARNING: no baseline was read before the run - skipping the check that it wrote a record."
    } else {
        try {
            $cfg = Invoke-WithRetry "GET /api/config" {
                Invoke-RestMethod -Uri "$trackerUrl/api/config" -TimeoutSec 30 `
                    -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
            }
            $track = $cfg.tracks | Where-Object { $_.key -eq $Task } | Select-Object -First 1
            $recordedAt = if ($track -and $track.last_run) { [string]$track.last_run.at } else { "" }
            if (-not $recordedAt -or $recordedAt -eq $recordBefore) {
                Log "ERROR: the run wrote no run record - it did not finish, whatever the output says."
                Log "       Run record for $Task is unchanged since this run started$(if ($recordBefore) { " ($recordBefore)" } else { ' (there has never been one)' })."
                $failureReason = "the run wrote no run record - it did not finish its own bookkeeping"
                $exitCode = 1
            } elseif ($track.last_run.status -eq "error") {
                # The run recorded its own failure. That record stands, so none
                # is added - but the task must not report exit 0 over it.
                $script:runRecorded = $true
                Log "ERROR: the run recorded itself as an error: $($track.last_run.note)"
                $failureReason = "the run recorded itself as an error: $($track.last_run.note)"
                $exitCode = 1
            }
        } catch {
            Log "WARNING: couldn't check whether a run record was written ($($_.Exception.Message)) - leaving the run's own result alone."
        }
    }
}

# ---- Write back what the run edited. --------------------------------------
#
# Only docs\. resumes\ and reference\ are inputs, and discarding changes there
# is a firmer guarantee than asking the model not to make them.
#
# Each PUT carries If-Match with the etag the file arrived with, so a run only
# overwrites the version it read. A failure is fatal even when the search
# succeeded: the run's findings are in that document, and the next run wipes
# this directory.
if ($runDir -and $manifest.Count -gt 0) {
    $sent = 0
    foreach ($rel in @($manifest.Keys)) {
        $local = Join-Path $runDir ($rel -replace '/', '\')
        $folder = $rel.Split("/")[0]

        if (-not (Test-Path $local)) {
            # Never mirrored as a delete: removing someone's baseline doc
            # because a run deleted its local copy is not this script's call.
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
            # Retried like every other call. A PUT that lands but loses its
            # response makes the retry see a moved etag and report a false 412.
            # That is accepted: it is loud and harmless, since the tracker holds
            # this run's bytes and the rescue copy matches them. Treating a
            # post-retry 412 as success would hide a real overwrite.
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
                # Something wrote this document during the run, and sending this
                # copy would erase it. Keep the copy for a person to merge.
                $rescue = Join-Path $logDir "$Task-doc-conflict-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
                Copy-Item $local $rescue -Force
                Log "ERROR: $rel changed underneath this run (412). This run's version: $rescue"
                $failureReason = "$rel changed underneath this run (412) - this run's version is at $rescue"
            } else {
                Log "ERROR: couldn't write back $rel ($status): $($_.Exception.Message)"
                $failureReason = "couldn't write back $rel ($status) - the run's edits are in $local"
            }
            $exitCode = 1
            # Recorded before the Write-Error below, which ends the script (see
            # "Recording a failed run" above).
            Record-FailedRun $failureReason
            if ($status -eq 412) {
                Write-Error "'$rel' was modified during the run. This run's copy is at $rescue - merge it by hand; nothing was overwritten."
            } else {
                Write-Error "Couldn't write back '$rel' ($status). The run's edits are in $local - do not let the next run wipe it."
            }
        }
    }
    Log "write-back:       $sent document(s) updated"
}

$elapsed = [int]((Get-Date) - $start).TotalSeconds

# ---- Record a failed run. -------------------------------------------------
#
# The backstop for failures between the CLI returning and here; see "Recording
# a failed run" above.
if ($exitCode -ne 0) {
    if (-not $failureReason) { $failureReason = "the run failed (exit code $exitCode)" }
    Record-FailedRun $failureReason
}

Log "finished $Task - job state: $jobState, elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
