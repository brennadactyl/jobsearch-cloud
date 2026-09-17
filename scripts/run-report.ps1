<#
.SYNOPSIS
  Prints one table for a night of scheduled searches: a row per run, built from
  the lines the runners write to each account's logs.

.DESCRIPTION
  Reads <DataDir>\<account>\logs\<search>.log and reports, for every run that
  started in the chosen night, when it started, how long it took and waited,
  how it exited, what it wrote back, whether it refreshed the profile, and which
  problems it logged.

  It prints no lead, company or file names and no free text from a log - only
  times, counts and the runner's fixed problem tags - so the table is safe to paste
  anywhere. A problem line is shown as its tag, never as written.

  It is a fixed parse of the runner's own lines (run-search.ps1, run-lock.ps1).
  The model's output block is skipped: nothing a run says about itself is read.

  Exit codes: 0 report printed; 1 no logs to read.

.PARAMETER DataDir
  The private data folder, one subfolder per account. Defaults to
  JOB_SEARCH_DATA_DIR, then <repo>\private.

.PARAMETER Night
  The evening the night began, as a date. A night runs from noon that day to
  noon the next, so the early-morning runs belong to the evening before.
  Defaults to last night.

.PARAMETER User
  Report only this account (a user id / folder name).

.EXAMPLE
  .\run-report.ps1
  .\run-report.ps1 -Night 2026-09-16
  .\run-report.ps1 -User ab266b6c-00cc-45d1-92ac-cdad412c1558
#>
param(
    [string]$DataDir,
    [datetime]$Night = (Get-Date).Date.AddDays(-1),
    [string]$User
)

$ErrorActionPreference = "Stop"

# The same three lines resolve the script folder in every scripts/*.ps1 that needs it; change them together.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
             else { "" }
# A missing script folder is fine when -DataDir is given, so only a missing data folder is refused.
if (-not $DataDir) {
    $DataDir = if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR }
               elseif ($scriptDir) { Join-Path $scriptDir "..\private" }
               else { "" }
}
if (-not $DataDir -or -not (Test-Path $DataDir)) {
    Write-Error "No data folder$(if ($DataDir) { " at $DataDir" }). Pass -DataDir, or set JOB_SEARCH_DATA_DIR. See private.example/README.md."
    exit 1
}

$from = $Night.Date.AddHours(12)
$to   = $from.AddDays(1)

# run-search.ps1 tags every WARNING and ERROR (`WARNING [doc-over-limit]: ...`),
# and only the tag is printed. Logs written before the tags carry none, so
# those lines are matched to the same tag by their wording, in this order; a
# line matching nothing is counted as "other" rather than printed.
$UNTAGGED = @(
    @{ Tag = "doc-over-limit";         Pattern = "over the \d+-byte limit" }
    @{ Tag = "refresh-refused";        Pattern = "during a profile refresh" }
    @{ Tag = "doc-changed-underneath"; Pattern = "changed underneath this run" }
    @{ Tag = "non-doc-changed";        Pattern = "changed during the run" }
    @{ Tag = "doc-missing";            Pattern = "is gone from the run directory" }
    @{ Tag = "write-back-failed";      Pattern = "couldn't write back" }
    @{ Tag = "no-run-record";          Pattern = "wrote no run record" }
    @{ Tag = "run-recorded-error";     Pattern = "recorded itself as an error" }
    @{ Tag = "run-failed";             Pattern = "not authenticated|not logged in" }
    @{ Tag = "profile-mark-failed";    Pattern = "couldn't be marked current" }
    @{ Tag = "profile-not-refreshed";  Pattern = "rewrite the profile" }
    @{ Tag = "log-upload-failed";      Pattern = "upload this run's log" }
    @{ Tag = "failed-run-unrecorded";  Pattern = "record the failed run" }
    @{ Tag = "run-note-failed";        Pattern = "add to the run record" }
    @{ Tag = "record-baseline-unread"; Pattern = "run record before starting" }
    @{ Tag = "record-check-skipped";   Pattern = "no baseline was read" }
    @{ Tag = "record-check-failed";    Pattern = "whether a run record was written" }
)

function Get-UntaggedProblem([string]$text) {
    foreach ($kind in $UNTAGGED) {
        if ($text -match $kind.Pattern) { return $kind.Tag }
    }
    return "other"
}
$LOG_LINE = '^(?<at>\d{4}-\d\d-\d\dT[\d:.]+[-+]\d\d:\d\d) - (?<text>.*)$'

$accounts = Get-ChildItem $DataDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName "logs") }
if ($User) { $accounts = @($accounts | Where-Object { $_.Name -eq $User }) }

$logs = @($accounts | ForEach-Object { Get-ChildItem (Join-Path $_.FullName "logs") -Filter *.log -File })
if ($logs.Count -eq 0) {
    Write-Error "No run logs under $DataDir$(if ($User) { " for -User $User" })."
    exit 1
}

$rows = New-Object System.Collections.Generic.List[object]

foreach ($log in $logs) {
    $account = $log.Directory.Parent.Name
    $run = $null
    $queueWait = $null   # run-lock.ps1 writes its line just before the run's header
    $inOutput = $false

    foreach ($line in [IO.File]::ReadLines($log.FullName)) {
        if ($line -notmatch $LOG_LINE) { continue }   # the model's output lines carry no timestamp
        $text = $Matches.text
        if ($text -eq "----- claude output -----") { $inOutput = $true; continue }
        if ($text -eq "----- end output -----")    { $inOutput = $false; continue }
        if ($inOutput) { continue }

        if ($text -match '^run queue: waited (\d+)s') { $queueWait = [int]$Matches[1]; continue }
        if ($text -match '^run queue: machine was free') { $queueWait = 0; continue }

        if ($text -match '^===== starting (.+) =====$') {
            if ($run) { $rows.Add($run) }
            $at = [datetime]::Parse($line.Substring(0, $line.IndexOf(" - ")))
            $run = if ($at -ge $from -and $at -lt $to) {
                [pscustomobject]@{
                    Account = $account.Substring(0, [Math]::Min(8, $account.Length))
                    Search = $Matches[1]; Start = $at; Minutes = $null; Waited = $queueWait
                    Exit = $null; Status = "-"; Leads = "-"; Screened = "-"; Delisted = "-"; Swept = "-"
                    DocUpdated = $null; DocRefused = $null; Profile = "none"
                    Problems = New-Object System.Collections.Generic.List[string]
                }
            } else { $null }
            $queueWait = $null
            continue
        }
        if (-not $run) { continue }

        if ($text -match '^finished .+ - job state: (?<state>\w+), elapsed: (?<el>\d+)s(, waited for the machine: (?<wait>\d+)s)?, exit code: (?<exit>-?\d+)') {
            $run.Minutes = [Math]::Round([int]$Matches.el / 60, 1)
            if ($Matches.wait) { $run.Waited = [int]$Matches.wait }
            $run.Exit = [int]$Matches.exit
            if ($Matches.state -ne "Completed") { $run.Problems.Add("job $($Matches.state.ToLower())") }
        }
        elseif ($text -match '^run record:\s+(.*)$') {
            foreach ($pair in ($Matches[1] -split '\s+')) {
                $k, $v = $pair -split '=', 2
                switch ($k) { "status" { $run.Status = $v } "leads_added" { $run.Leads = $v } "screened_added" { $run.Screened = $v } "delisted" { $run.Delisted = $v } "swept" { $run.Swept = $v } }
            }
        }
        elseif ($text -match '^write-back:\s+(\d+) document') { $run.DocUpdated = [int]$Matches[1] }
        elseif ($text -match '^profile:\s+rewritten') { $run.Profile = "rewritten" }
        elseif ($text -match '^profile:\s+stale since') { if ($run.Profile -eq "none") { $run.Profile = "kept stale" } }
        elseif ($text -match '^(WARNING|ERROR)( \[(?<tag>[a-z0-9-]+)\])?: ') {
            $label = if ($Matches.tag) { $Matches.tag } else { Get-UntaggedProblem $text }
            if ($label -eq "doc-over-limit" -or $label -eq "refresh-refused") {
                $run.DocRefused = if ($text -match 'grew (\d+) bytes .* over the (\d+)-byte limit') { [int]$Matches[1] - [int]$Matches[2] } else { 0 }
            }
            if ($label -eq "refresh-refused" -or $label -eq "profile-not-refreshed" -or $label -eq "profile-mark-failed") { $run.Profile = "kept stale" }
            $run.Problems.Add($label)
        }
        elseif ($text -eq "===== done =====") { $rows.Add($run); $run = $null }
    }
    if ($run) { $rows.Add($run) }   # a run still going, or one that died without its footer
}

$nightName = "{0:ddd d MMM} - {1:ddd d MMM yyyy}" -f $from, $to
if ($rows.Count -eq 0) {
    Write-Host "No runs started between $($from.ToString('yyyy-MM-dd HH:mm')) and $($to.ToString('yyyy-MM-dd HH:mm'))."
    exit 0
}

Write-Host "Night of $nightName (runs started $($from.ToString('HH:mm')) to $($to.ToString('HH:mm')), local time)"
$rows | Sort-Object Start | ForEach-Object {
    $problems = $_.Problems | Group-Object | ForEach-Object { if ($_.Count -gt 1) { "$($_.Name) x$($_.Count)" } else { $_.Name } }
    [pscustomobject]@{
        Account  = $_.Account
        Search   = $_.Search
        Start    = $_.Start.ToString("HH:mm")
        Minutes  = if ($null -ne $_.Minutes) { $_.Minutes } else { "-" }
        Waited   = if ($null -ne $_.Waited) { "{0}m" -f [Math]::Round($_.Waited / 60) } else { "-" }
        Exit     = if ($null -ne $_.Exit) { $_.Exit } else { "unfinished" }
        Status   = $_.Status
        Leads    = $_.Leads
        Screened = $_.Screened
        Delisted = $_.Delisted
        Swept    = $_.Swept
        Doc      = if ($_.DocRefused -gt 0) { "refused, +$($_.DocRefused) over" }
                   elseif ($null -ne $_.DocRefused) { "refused" }
                   elseif ($_.DocUpdated -gt 0) { "updated" }
                   elseif ($null -ne $_.DocUpdated) { "none" }
                   else { "-" }
        Profile  = $_.Profile
        Problems = if ($problems) { $problems -join ", " } else { "" }
    }
} | Format-Table -Property * -AutoSize | Out-String -Width 400 | ForEach-Object { $_.TrimEnd() } | Write-Host
exit 0
