<#
.SYNOPSIS
  Fills in the applications that were logged as nothing but a URL - one run
  for every account on this machine.

.DESCRIPTION
  Runs the tracker's fill
  prompt (`GET /api/prompt/_applications`, composed by ../server/src/prompt.js's
  buildAutofillPrompt) headless via `claude -p`, in one turn covering every
  account under <DataDir>, and logs to <DataDir>\logs\applications.log.

  One run rather than one per person: unlike a search, the job is the same for
  everyone and most accounts' queues are empty most nights, so a task per
  account would mostly pay for CLI startups that find nothing to do. Scoping is
  unchanged - every request uses one person's session token, and the API has no
  cross-user route.

  Tokens are passed as TRACKER_TOKEN_1..N environment variables that the prompt
  names, so the shell expands them inside curl and they never enter the model's
  context or this log.

.PARAMETER DataDir
  Path to the private data folder (the "silo"), holding one folder per person.
  Defaults to the JOB_SEARCH_DATA_DIR environment variable, then to a "private"
  folder next to this repo.

.PARAMETER User
  Only fill this one user id's applications, instead of everyone's. For trying
  it by hand; the scheduled task passes no -User.

.EXAMPLE
  .\run-fill.ps1
  .\run-fill.ps1 -User ab266b6c-00cc-45d1-92ac-cdad412c1558
#>
param(
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),

    [string]$User
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir, or the JOB_SEARCH_DATA_DIR environment variable, to your private job-search data folder."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

$logDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "applications.log"

# -Encoding utf8 on every writer to this log - see Log in run-search.ps1.
function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

Log "===== starting applications fill ====="
Log "data dir:         $DataDir"

# Same discovery as setup-scheduler.ps1: a person is a folder with a
# tracker.json in it. A single-user machine (no per-user folders, credentials in
# the environment) counts as one unnamed account.
$accounts = @()
foreach ($dir in (Get-ChildItem $DataDir -Directory | Sort-Object Name)) {
    $trackerFile = Join-Path $dir.FullName "tracker.json"
    if (-not (Test-Path $trackerFile)) { continue }
    if ($User -and $dir.Name -ne $User) { continue }
    $tracker = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
    $accounts += [pscustomobject]@{ Id = $dir.Name; Url = $tracker.url.TrimEnd("/"); Token = $tracker.token }
}
if ($accounts.Count -eq 0 -and -not $User -and $env:TRACKER_URL -and $env:TRACKER_API_TOKEN) {
    $accounts += [pscustomobject]@{ Id = "(single-user)"; Url = $env:TRACKER_URL.TrimEnd("/"); Token = $env:TRACKER_API_TOKEN }
}

if ($accounts.Count -eq 0) {
    Log "ERROR: no accounts found under $DataDir - nothing to fill"
    Write-Error "No accounts found. Each person needs <DataDir>\<user-id>\tracker.json - see ../private.example/README.md."
    exit 1
}

# One run has one TRACKER_URL, so accounts on another deployment can't be part
# of it. Named and skipped rather than silently dropped: a person whose
# applications quietly stop filling in has no way to notice from the page.
$trackerUrl = $accounts[0].Url
$offDeployment = @($accounts | Where-Object { $_.Url -ne $trackerUrl })
if ($offDeployment.Count -gt 0) {
    foreach ($a in $offDeployment) {
        Log "WARNING: skipping $($a.Id) - its tracker.json points at $($a.Url), not $trackerUrl"
        Write-Warning "Skipping $($a.Id): it is on a different tracker deployment ($($a.Url))."
    }
    $accounts = @($accounts | Where-Object { $_.Url -eq $trackerUrl })
}

Log "tracker:          $trackerUrl"
Log "accounts:         $($accounts.Count) ($(($accounts | ForEach-Object { $_.Id }) -join ', '))"

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

# The prompt is the same text for every account, so any account's token can
# fetch it. A failure here is fatal: running no prompt would look like a night
# where every queue was empty.
try {
    $promptBody = Invoke-RestMethod -Uri "$trackerUrl/api/prompt/_applications" `
        -Headers @{ Authorization = "Bearer $($accounts[0].Token)" } -ErrorAction Stop
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    $hint = if ($status -eq 401) { "the token in $($accounts[0].Id)'s tracker.json isn't valid (revoked, or from another deployment)" } else { $_.Exception.Message }
    Log "ERROR: couldn't fetch the fill prompt ($status): $hint"
    Write-Error "Couldn't fetch the fill prompt ($status): $hint"
    exit 1
}
if (-not $promptBody) {
    Log "ERROR: the tracker returned an empty fill prompt"
    Write-Error "The tracker returned an empty fill prompt."
    exit 1
}

# Which accounts this machine has is known only here, so the account list is
# added at this end rather than by the tracker. Only the variable names go in.
$accountLines = @()
for ($i = 0; $i -lt $accounts.Count; $i++) {
    $accountLines += "  - account $($i + 1): token is in the environment variable TRACKER_TOKEN_$($i + 1)"
}
$accountNote = @"
Tonight this run covers $($accounts.Count) account$(if ($accounts.Count -ne 1) { 's' }) on this machine:

$($accountLines -join "`n")

Work through them in that order, one at a time. TRACKER_URL is the same for
all of them. Never print a token, and never reuse one account's ids or token
against another account.
"@

# Headless preamble - see run-search.ps1 for why it exists. This prompt asks
# for subagents on purpose (one per posting, buildAutofillPrompt's step 2), so
# the rule here is to wait for them before ending the turn, not to avoid them.
$prompt = @"
IMPORTANT: this is one single non-interactive headless run. This process
exits as soon as your turn ends, and nobody reads any message after that -
there is no follow-up turn.

Subagents are expected here and the prompt below tells you when to use them.
What you must not do is end your turn with work still outstanding: wait for
every subagent you dispatch and use its result, and do not hand any part of
this off to a backgrounded Bash command or a background agent and finish early
saying you will report back. Anything still running when your turn ends is
killed with this process, and nothing it found gets written back.

$accountNote

$promptBody
"@

# Task is the subagent tool - the fan-out in step 2 needs it. No Write/Edit:
# this run reads job postings and posts what they say. It has no files to
# change, and the applications it fills in are the least recoverable rows in
# the database.
$allowedTools = "Task Read Glob Grep WebSearch WebFetch Bash"

Log "prompt:           $($promptBody.Length) chars from $trackerUrl/api/prompt/_applications"
Log "claude CLI:       $claudePath"
Log "allowed tools:    $allowedTools"
Log "CLAUDE_CODE_OAUTH_TOKEN set: $([bool]$env:CLAUDE_CODE_OAUTH_TOKEN)"

$job = Start-Job -ScriptBlock {
    param($claudePath, $prompt, $allowedTools, $workDir, $trackerUrl, $tokens)
    Set-Location $workDir
    # Set inside the script block because Start-Job runs in its own process.
    $env:TRACKER_URL = $trackerUrl
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        Set-Item -Path "env:TRACKER_TOKEN_$($i + 1)" -Value $tokens[$i]
    }
    # Output encoding and the prompt on stdin: see the same lines in
    # run-search.ps1.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $prompt | & $claudePath -p --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $DataDir, $trackerUrl, @($accounts | ForEach-Object { $_.Token })

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

# A clean CLI exit is not proof of work - see the output checks in
# run-search.ps1. It matters more here: this job writes no run record (see
# ../server/src/prompt.js), and a row left blank looks like a posting nobody
# could read, so the task's Last Run Result is the only signal it stopped.
$exitCode = if ($jobState -eq "Completed") { 0 } else { 1 }
$outputText = if ($output) { ($output | Out-String).Trim() } else { "" }
if (-not $outputText) {
    Log "ERROR: the CLI produced no output at all - nothing was filled in"
    $exitCode = 1
} elseif ($outputText -match "Not logged in|Please run /login|Invalid API key|authentication_error") {
    Log "ERROR: the CLI is not authenticated - nothing was filled in."
    Log "       Run ``claude setup-token``, then: setx CLAUDE_CODE_OAUTH_TOKEN ""<token>"""
    $exitCode = 1
} elseif ($outputText -match "failed to run|ApplicationFailedException|NativeCommandFailed|is too long") {
    # The launcher failed and the CLI never started; the authentication
    # patterns do not match its message.
    Log "ERROR: the CLI failed to start - nothing was filled in."
    Log "       See the output above; a launcher failure is not an empty queue."
    $exitCode = 1
}

$elapsed = [int]((Get-Date) - $start).TotalSeconds
Log "finished - job state: $jobState, elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
