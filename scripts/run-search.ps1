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

    [string]$DataDir,

    [switch]$UseLocalFiles
)

$ErrorActionPreference = "Stop"

# A param default is evaluated before $PSScriptRoot is reliably set, so the
# script's own folder is resolved here instead. It also finds run-lock.ps1 and
# the tracker helper this run copies into its work dir.
# The same three lines resolve the script folder in every scripts/*.ps1 that needs it; change them together.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
             else { "" }
if (-not $scriptDir) {
    throw "Can't work out where this script lives, so it can't find run-lock.ps1 or tracker.ps1. Run it by its full path."
}
if (-not $DataDir) {
    $DataDir = if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $scriptDir "..\private" }
}

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

# Where this run's part of the log begins, and the name the uploaded copy of it
# carries: the start of the run, in UTC. See Send-RunLog.
$runLogOffset = if (Test-Path $logFile) { (Get-Item $logFile).Length } else { 0 }
$runStarted = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")

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

# A download's -OutFile write fails with no HTTP response, which the status
# rule reads as a dropped connection. Retrying a local path error only delays
# it and logs it as a network problem. Matched by exception type anywhere in
# the chain: a real network failure carries a plain IOException at most, never
# these two. tracker.ps1 writes no files inside its retry, so it needs no
# counterpart.
function Test-LocalPathError($err) {
    for ($e = $err.Exception; $e; $e = $e.InnerException) {
        if ($e -is [System.IO.DirectoryNotFoundException] -or $e -is [System.IO.PathTooLongException]) { return $true }
    }
    return $false
}

# Rethrows the last error unchanged, so each caller's catch block handles it
# exactly as it would without the retry.
function Invoke-WithRetry($what, $action) {
    for ($attempt = 1; ; $attempt++) {
        try {
            return & $action
        } catch {
            $status = Get-HttpStatus $_
            if ($status -eq 0 -and (Test-LocalPathError $_)) { throw }
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
        Log "WARNING [failed-run-unrecorded]: could not record the failed run ($($_.Exception.Message)). The failure above still stands; only the tracker's copy of it is missing."
    }
}

# ---- How much a track doc may grow in one run. ----------------------------
#
# Every run reads its track doc in full, so the doc's size is a cost paid every
# night, and it only grows. What runs append is mostly per-company fetch notes,
# which belong on the shared company list through the prompt's step 9d ("RECORD
# WHAT YOU COVERED"); a sentence in the prompt saying so doesn't stop it, so the
# limit lives here. The budget is what the prompt tells the run it may add: it
# is passed to GET /api/prompt as ?doc_budget, so the number the run is told and
# the one it is held to can't disagree. The refusal is set well above it, so a
# run that aims for the budget and overshoots a little still saves its notes;
# a batch of fetch notes doesn't. A doc may always shrink.
$DocBudgetBytes = 1000
$DocGrowthLimitBytes = [int]($DocBudgetBytes * 2.5)

# ---- The one section a profile refresh may rewrite. ------------------------
#
# When a search's resume has changed, its run rewrites the profile drawn from
# the old one (the prompt's step 2b). The prompt asks it to leave the rest of
# the doc alone; this is what holds it to that. Everything outside the section
# must come back exactly as it arrived, so a refresh can't quietly drop the
# fetch notes and fit reasoning earlier runs built up.
#
# The section runs from the first line starting "## Candidate Profile" to the
# next "## " heading. Live docs title it differently ("& Role Fit",
# "(from Brady_Jerin_Resume.pdf)"), so it is found by that prefix.
#
# Returns $null for a doc with no such heading; otherwise the section, and the
# doc with the section cut out - which is what must match.
function Split-ProfileSection([string]$text) {
    $heading = [regex]::Match($text, '(?m)^## Candidate Profile[^\r\n]*(\r?\n)?')
    if (-not $heading.Success) { return $null }
    $bodyStart = $heading.Index + $heading.Length
    $next = [regex]::Match($text.Substring($bodyStart), '(?m)^## ')
    $end = if ($next.Success) { $bodyStart + $next.Index } else { $text.Length }
    return @{
        Section = $text.Substring($heading.Index, $end - $heading.Index)
        Outside = $text.Substring(0, $heading.Index) + "`0" + $text.Substring($end)
    }
}

# Puts a sentence in front of this track's run record note, so something the
# runner decided after the run shows on the page rather than only in a log
# nobody reads. In front, because the tracker keeps 500 characters and cuts
# from the end. Keeps the run's own status, date and time. Never fatal.
function Add-RunNote($text) {
    try {
        $cfg = Invoke-WithRetry "GET /api/config" {
            Invoke-RestMethod -Uri "$trackerUrl/api/config" -TimeoutSec 30 `
                -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
        }
        $track = $cfg.tracks | Where-Object { $_.key -eq $Task } | Select-Object -First 1
        $run = if ($track) { $track.last_run } else { $null }
        $body = @{
            search = $Task
            status = if ($run -and $run.status) { [string]$run.status } else { "ok" }
            on     = if ($run -and $run.on) { [string]$run.on } else { (Get-Date).ToString("yyyy-MM-dd") }
            note   = "runner: $text" + $(if ($run -and $run.note) { " | $($run.note)" } else { "" })
        }
        if ($run -and $run.at) { $body.at = [string]$run.at }
        $null = Invoke-WithRetry "POST /api/runs" {
            Invoke-RestMethod -Uri "$trackerUrl/api/runs" -Method Post -TimeoutSec 30 `
                -Headers @{ Authorization = "Bearer $trackerToken" } `
                -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress)
        }
    } catch {
        Log "WARNING [run-note-failed]: couldn't add to the run record ($($_.Exception.Message)): $text"
    }
}

# Every fatal path before the CLI runs exits through here, so none can skip
# recording. The checks above - data dir, user folder, credentials - cannot use
# it, since there is no tracker to record to yet.
# ---- This run's log, off this machine. ------------------------------------
#
# Uploads the part of the log this run wrote (PUT /api/logs), so what a search
# did is kept with the tracker rather than only on the machine that ran it. It
# is the last thing a run does, whether it succeeded or failed, so the upload
# carries everything the run logged before it.
#
# A failed upload is a warning in the local log and never changes the run's
# result: the search has already happened, and the local log still has all of
# it. The same name on every attempt means a retry replaces its own copy.
function Send-RunLog {
    try {
        $all = [System.IO.File]::ReadAllBytes($logFile)
        # A log file that shrank since the run began was replaced, so all of it
        # is this run's.
        $from = if ($runLogOffset -le $all.Length) { $runLogOffset } else { 0 }
        # Out-File marks a new file as UTF-8 with three bytes at its very start;
        # the uploaded copy is labelled UTF-8 already, and a reader would show them.
        if ($from -eq 0 -and $all.Length -ge 3 -and $all[0] -eq 0xEF -and $all[1] -eq 0xBB -and $all[2] -eq 0xBF) { $from = 3 }
        $length = $all.Length - $from
        if ($length -le 0) { return }
        $part = New-Object byte[] $length
        [Array]::Copy($all, $from, $part, 0, $length)
        $null = Invoke-WithRetry "PUT /api/logs/$Task/$runStarted" {
            Invoke-WebRequest -Uri "$trackerUrl/api/logs/$Task/$runStarted" -Method Put `
                -Headers @{ Authorization = "Bearer $trackerToken" } `
                -Body $part -ContentType "text/plain; charset=utf-8" -UseBasicParsing -ErrorAction Stop
        }
        Log ("run log:          uploaded {0:N0} bytes as {1}" -f $length, $runStarted)
    } catch {
        # The tracker's own reason (a 413's size, a 404's track) is in the
        # response body, which Windows PowerShell keeps in ErrorDetails rather
        # than in the exception's message.
        $why = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        Log "WARNING [log-upload-failed]: couldn't upload this run's log ($(Get-HttpStatus $_)): $why - it is still in $logFile"
    }
}

# A paused search is not a failed one. Its task shouldn't exist - the next
# scheduler run removes it - so this exits 0 and records nothing: a run row
# would talk over the tab's Paused state, and a red Last Run Result for an
# expected state teaches people to ignore red. The log carries the word
# "paused" and the date so a leftover task is findable by grep, since that is
# the only place it shows.
function Stop-PausedRun($sentence, $pausedSince) {
    Log "paused:           $sentence"
    Log "run outcome:      status=paused since=$pausedSince"
    Log "       Nothing was searched and no run was recorded. This task will go the next time setup-scheduler.ps1 runs; until then this search logs this every night."
    if (Get-Command Exit-RunLock -ErrorAction SilentlyContinue) { Exit-RunLock }
    Send-RunLog
    Log "finished $Task - paused, nothing to do"
    exit 0
}

function Stop-Run($tag, $reason, $userMessage) {
    # The tag names the shape of the failure rather than its wording, so
    # scripts/run-report.ps1 keeps counting it after the sentence is reworded.
    Log "ERROR [$tag]: $reason"
    Record-FailedRun $reason
    # Guarded: the early fatal checks can reach this before the queue below is
    # even loaded, and a run that never took the lock has nothing to give back.
    if (Get-Command Exit-RunLock -ErrorAction SilentlyContinue) { Exit-RunLock }
    Send-RunLog
    Write-Error $userMessage
    exit 1
}

# ---- Wait for the machine. -------------------------------------------------
#
# One run at a time: every run on this machine drives the same CLI under one
# Claude account, and two at once is two runs fighting over it. See run-lock.ps1
# for why this is a lock rather than more spacing in the schedule.
#
# Taken here, before any tracker call, so a run that waits an hour reads its
# documents and its prompt when it is about to use them rather than an hour
# stale.
. (Join-Path $scriptDir "run-lock.ps1")
if (-not (Enter-RunLock)) {
    Stop-Run "queue-timeout" "another run on this machine was still going after $RUN_LOCK_MAX_WAIT_MINUTES minutes - nothing was searched or synced" `
        "The machine was busy with another run for $RUN_LOCK_MAX_WAIT_MINUTES minutes. See $logFile."
}

. (Join-Path $scriptDir "claude-cli.ps1")
$claudePath = Find-ClaudeCli
if (-not $claudePath) {
    Stop-Run "cli-missing" "the claude CLI is not on PATH or in npm's global folder - nothing was searched or synced" "claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
}

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
        Invoke-RestMethod -Uri "$trackerUrl/api/prompt/${Task}?doc_budget=$DocBudgetBytes" -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
    }
} catch {
    $status = Get-HttpStatus $_
    # The tracker's own reason is in the response body, which Windows
    # PowerShell keeps in ErrorDetails; a refusal it expects carries a `code`
    # beside it, and the code is what this branches on - the sentence is
    # written for a person and may be reworded.
    $body = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { "" }
    $refusal = $null
    if ($body) { try { $refusal = $body | ConvertFrom-Json } catch { } }
    if ($status -eq 409 -and $refusal -and $refusal.code -eq "paused") {
        Stop-PausedRun ([string]$refusal.error) ([string]$refusal.paused_since)
    }
    $hint = switch ($status) {
        401 { "the token in $trackerFile isn't valid (revoked, or from another deployment)" }
        404 { "no track '$Task' is configured for this user - check the tracker's config" }
        default { if ($refusal -and $refusal.error) { [string]$refusal.error } else { $_.Exception.Message } }
    }
    # After a 401 or 404 the failure record is refused too; recording is
    # best-effort, so the run still exits on the error that explains it.
    Stop-Run "prompt-fetch-failed" "couldn't fetch the prompt ($status): $hint" "Couldn't fetch the prompt for '$Task' ($status): $hint"
}
if (-not $promptBody) {
    Stop-Run "prompt-empty" "the tracker returned an empty prompt for $Task" "The tracker returned an empty prompt for '$Task'."
}

# ---- Materialize this search's documents into a throwaway directory. -------
#
# Wiped and refilled every run, so the search reads what the tracker holds and
# a run's scratch never accumulates in the durable folder.
#
# Only this search's documents: its tracking doc and the files its track lists
# (GET /api/documents?search=). A person with two searches keeps each one's
# resumes and tracking doc out of the other's run.
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
    # A profile refresh: whether one is due, which doc it rewrote, and whether
    # the tracker took that doc. See "Mark a rewritten profile current".
    $profileStale = $null
    $profileDoc = $null
    $profileWrittenBack = $false
    try {
        $index = Invoke-WithRetry "GET /api/documents?search=$Task" {
            Invoke-RestMethod -Uri "$trackerUrl/api/documents?search=$([uri]::EscapeDataString($Task))" -Headers $headers -ErrorAction Stop
        }
    } catch {
        $status = Get-HttpStatus $_
        if ($status -eq 503) {
            # A deployment with no DOCS bucket, which is supported (see
            # server/README.md): run against whatever is on disk.
            Log "documents:        not configured on this deployment - running against $workDir as-is"
        } else {
            # The tracker's reason - a track with no documents listed is a 409
            # that says so - is in the response body, which Windows PowerShell
            # keeps in ErrorDetails.
            $why = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
            Stop-Run "documents-list-failed" "couldn't list this search's documents ($status): $why" "Couldn't list documents for '$Task' ($status): $why"
        }
    }

    if ($index) {
        # A document the track lists that isn't in the tracker. Refused like a
        # failed download: the search would run without a file it was set up to
        # read, most likely its resume.
        if ($index.missing -and $index.missing.Count -gt 0) {
            Stop-Run "documents-missing" "this search lists documents the tracker doesn't have: $($index.missing -join ', ')" "Search '$Task' lists documents that aren't in the tracker: $($index.missing -join ', '). Upload them, or correct the track's documents list. Refusing to search against a partial profile."
        }
        # Zero documents is refused: with no baseline doc and no resume the
        # search screens every posting against nothing and reports success,
        # which looks like a quiet night. Usually the import has not been run.
        if (-not $index.documents -or $index.documents.Count -eq 0) {
            Stop-Run "no-documents" "the tracker holds no documents for this account" "No documents for this account - run scripts\import-documents.ps1 first. Refusing to search against an empty profile."
        }

        # Set when a resume was chosen since this search's profile was written.
        # The prompt then asks the run to rewrite the profile first, and the
        # write-back below holds that rewrite to its own section.
        $profileStale = $index.profile_stale
        if ($profileStale) {
            Log "profile:          stale since $($profileStale.since), written from $($profileStale.was) - this run rewrites it"
        }

        $runDir = Join-Path (Join-Path $workDir ".run") $Task

        # A download's -OutFile write stops at MAX_PATH: a file path of 260
        # characters or more, or a folder of 248 or more, fails as "Could not
        # find a part of the path",
        # which reads as a missing folder. Checked up front so a data dir that
        # is too deep says so, rather than failing on whichever document happens
        # to be longest. The helper files are written into the same directory.
        $longest = $null
        $longestLimit = 0
        $over = 0
        foreach ($rel in @($index.documents | ForEach-Object { $_.path -replace '/', '\' }) + @("tracker.ps1", "tracker")) {
            $file = Join-Path $runDir $rel
            $dir = Split-Path $file -Parent
            foreach ($check in @(@{ path = $file; limit = 259 }, @{ path = $dir; limit = 247 })) {
                $excess = $check.path.Length - $check.limit
                if ($excess -gt $over) { $over = $excess; $longest = $check.path; $longestLimit = $check.limit }
            }
        }
        if ($longest) {
            Stop-Run "path-too-long" "run directory path too long: $longest is $($longest.Length) characters, over the Windows limit of $longestLimit" ("The run would write '{0}', which is {1} characters - Windows PowerShell cannot write paths longer than {2}. Use a data dir at least {3} characters shorter: set JOB_SEARCH_DATA_DIR or pass -DataDir." -f $longest, $longest.Length, $longestLimit, $over)
        }

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
                Stop-Run "document-fetch-failed" "couldn't fetch $($doc.path) ($(Get-HttpStatus $_)): $($_.Exception.Message)" "Couldn't fetch document '$($doc.path)'. Refusing to search against a partial profile."
            }
            $got = (Get-Item $dest).Length
            if ($doc.bytes -and $got -ne $doc.bytes) {
                Stop-Run "document-short" "$($doc.path) came back $got bytes, expected $($doc.bytes)" "Document '$($doc.path)' downloaded short. Refusing to search against a truncated profile."
            }
            $manifest[$doc.path] = @{
                etag  = $doc.etag
                sha   = (Get-FileHash -Path $dest -Algorithm SHA256).Hash
                bytes = $got
                # A track doc's text as it arrived: a profile refresh is checked
                # against it section by section.
                text  = if ($doc.path -like "docs/*") { [System.IO.File]::ReadAllText($dest, [System.Text.Encoding]::UTF8) } else { $null }
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
$helperSrc = Join-Path $scriptDir "tracker.ps1"
if (-not (Test-Path $helperSrc)) {
    Stop-Run "helper-missing" "$helperSrc is missing - the run would have no way to sync anything" "scripts\tracker.ps1 not found. The search prompt invokes it for every API call."
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
    Log "WARNING [record-baseline-unread]: couldn't read this track's run record before starting ($($_.Exception.Message)) - the post-run check will have nothing to compare against."
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

# The CLI exiting cleanly is not the same as the CLI having done anything (see
# claude-cli.ps1). Checked against the output rather than by pre-flighting the
# credential: the token is read by the CLI in a child process, and what matters
# is whether that process could use it, not whether this one can see it.
#
# For a search, any failure is recorded against the track, so its tab says the
# search didn't run rather than showing a stale stamp.
$outputText = if ($output) { ($output | Out-String).Trim() } else { "" }
# Carried into the failed-run record, so the tracker says why.
$failureReason = ""
$failure = Get-CliFailure $outputText $jobState
if ($failure) {
    $failureReason = "$($failure.Message) - nothing was searched or synced"
    # The kind is the tag: which of the CLI's failures this was is exactly what
    # a report of many nights wants to count.
    Log "ERROR [cli-$($failure.Kind)]: $failureReason"
    if ($failure.Hint) { Log "       $($failure.Hint)" }
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
#
# The check ends in one fixed line, whatever it found: what a run did is
# otherwise only in the model's prose, which scripts/run-report.ps1 won't parse.
# The counts are the records' own, which the tracker derives from the rows that
# landed, summed over every tab the run fills. `swept` is this search's own
# number, never summed - a tab another search fills reads 0 - and is left off
# entirely by a deployment that doesn't keep one, so a report shows "no count"
# rather than a false zero.
$recordSummary = "status=unchecked"
if ($exitCode -eq 0) {
    if ($null -eq $recordBefore) {
        Log "WARNING [record-check-skipped]: no baseline was read before the run - skipping the check that it wrote a record."
    } else {
        try {
            $cfg = Invoke-WithRetry "GET /api/config" {
                Invoke-RestMethod -Uri "$trackerUrl/api/config" -TimeoutSec 30 `
                    -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
            }
            $track = $cfg.tracks | Where-Object { $_.key -eq $Task } | Select-Object -First 1
            $recordedAt = if ($track -and $track.last_run) { [string]$track.last_run.at } else { "" }
            if (-not $recordedAt -or $recordedAt -eq $recordBefore) {
                $recordSummary = "status=none"
                Log "ERROR [no-run-record]: the run wrote no run record - it did not finish, whatever the output says."
                Log "       Run record for $Task is unchanged since this run started$(if ($recordBefore) { " ($recordBefore)" } else { ' (there has never been one)' })."
                $failureReason = "the run wrote no run record - it did not finish its own bookkeeping"
                $exitCode = 1
            } else {
                $r = $track.last_run
                # A search that fills other tabs lands most of its rows there,
                # and each tab keeps its own counts, so the search's numbers are
                # the sum over every tab this run recorded - matched on the
                # record's instant, which one ./tracker run stamps on all of them.
                $group = @($cfg.tracks | Where-Object {
                    $_ -and ($_.key -eq $Task -or $_.fed_by -eq $Task) -and
                    $_.last_run -and [string]$_.last_run.at -eq $recordedAt
                })
                $sum = { param($field) ($group | ForEach-Object { [int]$_.last_run.$field } | Measure-Object -Sum).Sum }
                $recordSummary = "status=$([string]$r.status) leads_added=$(& $sum 'leads_added') screened_added=$(& $sum 'screened_added') delisted=$(& $sum 'delisted')"
                if ($null -ne $r.PSObject.Properties["swept"] -and $null -ne $r.swept) {
                    $recordSummary += " swept=$([int]$r.swept)"
                }
            }
            if ($recordedAt -and $recordedAt -ne $recordBefore -and $track.last_run.status -eq "error") {
                # The run recorded its own failure. That record stands, so none
                # is added - but the task must not report exit 0 over it.
                $script:runRecorded = $true
                Log "ERROR [run-recorded-error]: the run recorded itself as an error: $($track.last_run.note)"
                $failureReason = "the run recorded itself as an error: $($track.last_run.note)"
                $exitCode = 1
            }
        } catch {
            Log "WARNING [record-check-failed]: couldn't check whether a run record was written ($($_.Exception.Message)) - leaving the run's own result alone."
        }
    }
}
# What this run amounted to, for a person and for run-report.ps1. It is not the
# run record: that is the `search_runs` row the run writes itself, and a paused
# or unfinished run reaches this line having written none.
Log "run outcome:      $recordSummary"

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
            Log "WARNING [doc-missing]: $rel is gone from the run directory - left untouched in the tracker."
            continue
        }

        $now = (Get-FileHash -Path $local -Algorithm SHA256).Hash
        if ($now -eq $manifest[$rel].sha) { continue }

        if ($folder -ne "docs") {
            Log "WARNING [non-doc-changed]: $rel changed during the run and was discarded - only docs/ is written back."
            continue
        }

        if ($profileStale) {
            # A refresh run rewrites one section and nothing else. The growth
            # limit doesn't apply to it: a new resume can be longer than the old.
            $old = Split-ProfileSection $manifest[$rel].text
            $new = Split-ProfileSection ([System.IO.File]::ReadAllText($local, [System.Text.Encoding]::UTF8))
            $refusal = if (-not $old) { "has no Candidate Profile section to rewrite" }
                       elseif (-not $new) { "lost its Candidate Profile heading" }
                       elseif ($old.Outside -cne $new.Outside) { "changed outside its Candidate Profile section" }
                       else { $null }
            if ($refusal) {
                # Not a failed run: the search itself is fine. The profile stays
                # marked out of date, so the next run tries the rewrite again.
                $kept = Join-Path $logDir "$Task-doc-refused-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
                Copy-Item $local $kept -Force
                Log "WARNING [refresh-refused]: $rel $refusal during a profile refresh - not written back, and the profile stays marked out of date. This run's version: $kept"
                Add-RunNote "the profile refresh $refusal, so it wasn't saved and runs again next time - this run's version is in logs\$(Split-Path $kept -Leaf)"
                continue
            }
            $profileDoc = $rel
        } else {
            $grew = (Get-Item $local).Length - $manifest[$rel].bytes
            if ($grew -gt $DocGrowthLimitBytes) {
                # Not a failed run: the search itself is fine. The edit is kept for a
                # person to look at rather than sent, and the run record says where.
                $kept = Join-Path $logDir "$Task-doc-refused-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
                Copy-Item $local $kept -Force
                Log "WARNING [doc-over-limit]: $rel grew $grew bytes in this run, over the $DocGrowthLimitBytes-byte limit - not written back. This run's version: $kept"
                Add-RunNote "$rel grew $grew bytes, over the $DocGrowthLimitBytes-byte limit, so this run's doc edit wasn't saved - it is in logs\$(Split-Path $kept -Leaf)"
                continue
            }
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
            if ($rel -eq $profileDoc) { $profileWrittenBack = $true }
            Log ("wrote back {0} ({1:N0} bytes)" -f $rel, $body.Length)
        } catch {
            $status = Get-HttpStatus $_
            if ($status -eq 412) {
                # Something wrote this document during the run, and sending this
                # copy would erase it. Keep the copy for a person to merge.
                $rescue = Join-Path $logDir "$Task-doc-conflict-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
                Copy-Item $local $rescue -Force
                Log "ERROR [doc-changed-underneath]: $rel changed underneath this run (412). This run's version: $rescue"
                $failureReason = "$rel changed underneath this run (412) - this run's version is at $rescue"
            } else {
                Log "ERROR [write-back-failed]: couldn't write back $rel ($status): $($_.Exception.Message)"
                $failureReason = "couldn't write back $rel ($status) - the run's edits are in $local"
            }
            $exitCode = 1
            # Recorded before the Write-Error below, which ends the script (see
            # "Recording a failed run" above) - and the log sent for the same
            # reason.
            Record-FailedRun $failureReason
            Send-RunLog
            if ($status -eq 412) {
                Write-Error "'$rel' was modified during the run. This run's copy is at $rescue - merge it by hand; nothing was overwritten."
            } else {
                Write-Error "Couldn't write back '$rel' ($status). The run's edits are in $local - do not let the next run wipe it."
            }
        }
    }
    Log "write-back:       $sent document(s) updated"

    # ---- Mark a rewritten profile current. ----------------------------------
    #
    # Only after the tracker holds the rewritten doc: a refresh that was refused,
    # or never happened, leaves the mark, so the next run tries again. Sent with
    # the `since` this run read, so a resume chosen again mid-run keeps the mark
    # and is refreshed next time - the server clears it only on a match.
    if ($profileStale) {
        if ($profileWrittenBack) {
            try {
                $cleared = Invoke-WithRetry "POST /api/writeup" {
                    Invoke-RestMethod -Uri "$trackerUrl/api/writeup" -Method Post -TimeoutSec 30 `
                        -Headers @{ Authorization = "Bearer $trackerToken" } -ContentType "application/json" `
                        -Body (@{ search = $Task; profile_refreshed = [string]$profileStale.since } | ConvertTo-Json -Compress) `
                        -ErrorAction Stop
                }
                if (@($cleared.written) -contains "profile_refreshed") {
                    Log "profile:          rewritten and marked current"
                } else {
                    Log "profile:          rewritten, but the resume changed again during this run - it stays marked, and the next run rewrites it from the newer one"
                }
            } catch {
                Log "WARNING [profile-mark-failed]: the profile was rewritten but couldn't be marked current ($(Get-HttpStatus $_)) - the next run rewrites it again"
            }
        } else {
            Log "WARNING [profile-not-refreshed]: this run was asked to rewrite the profile from the new resume and didn't - it stays marked for the next run"
            Add-RunNote "the resume changed, but this run's profile rewrite wasn't saved - the next run tries again"
        }
    }
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

Log "finished $Task - job state: $jobState, elapsed: ${elapsed}s, waited for the machine: ${runLockWaitedSeconds}s, exit code: $exitCode"
Log "===== done ====="

Exit-RunLock
Send-RunLog

exit $exitCode
