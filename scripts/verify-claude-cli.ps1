<#
.SYNOPSIS
  Checks claude-cli.ps1's reading of a CLI turn: every failure wording is
  caught, and a turn that worked is never mistaken for one that didn't.

.DESCRIPTION
  Run it after changing claude-cli.ps1 - a new wording, a new kind, the window.
  It needs no tracker, no CLI and no network, and exits 1 on any failed check.

  The second half matters as much as the first. A missed wording lets a turn
  that did nothing record a success; a false match fails a night of work that
  was fine, and on the onboarding run it leaves a person's setup waiting.

.EXAMPLE
  .\verify-claude-cli.ps1
#>

$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
             else { "" }
if (-not $scriptDir) {
    throw "Can't work out where this script lives, so it can't find claude-cli.ps1. Run it by its full path."
}
. (Join-Path $scriptDir "claude-cli.ps1")

$script:pass = 0
$script:fail = 0
function Check($what, $ok) {
    if ($ok) { $script:pass++; Write-Host "  PASS  $what" }
    else { $script:fail++; Write-Host "  FAIL  $what" -ForegroundColor Red }
}

function KindOf($output, $jobState = "Completed") {
    $failure = Get-CliFailure $output $jobState
    if ($failure) { return $failure.Kind }
    return $null
}

# A turn that did the work: long, and ending in the run's own summary.
$work = ("Checked 24 companies from tonight's batch; verified 3 postings live. " * 40).Trim()

Write-Host "`nEvery failure wording is caught"
Check "no output at all" ((KindOf "") -eq "no-output")
Check "only whitespace" ((KindOf "   `r`n  ") -eq "no-output")
foreach ($wording in $CLI_NOT_AUTHENTICATED) {
    Check "not authenticated: '$wording'" ((KindOf "$wording - run claude setup-token") -eq "not-authenticated")
}
foreach ($wording in $CLI_FAILED_TO_START) {
    Check "failed to start: '$wording'" ((KindOf "Program 'claude.exe' $wording") -eq "failed-to-start")
}
# What the CLI on the search machine has actually printed when its token was
# missing and when it had expired, verbatim.
Check "the CLI's own 'not logged in' line" ((KindOf "Not logged in · Please run /login") -eq "not-authenticated")
Check "the CLI's own expired-token line" ((KindOf "Failed to authenticate. API Error: 401 Invalid bearer token") -eq "not-authenticated")
Check "a job that didn't complete" ((KindOf $work "Failed") -eq "incomplete")
Check "a login failure outranks the job state" ((KindOf "Not logged in" "Failed") -eq "not-authenticated")

Write-Host "`nA turn that worked is not mistaken for one that didn't"
Check "a normal completed turn" ($null -eq (KindOf $work))
Check "a summary quoting a site's 'Not logged in' page, past the window" `
    ($null -eq (KindOf ($work + " The Acme careers page said Not logged in, so it was screened.")))
Check "a posting id or HTTP status containing 401" `
    ($null -eq (KindOf "Verified req 401287 at Globex; the old link returned 401 and was replaced."))

Write-Host "`nWhose problem it is"
Check "no output is the machine's" (Test-MachineFailure (Get-CliFailure "" "Completed"))
Check "not authenticated is the machine's" (Test-MachineFailure (Get-CliFailure "Invalid API key" "Completed"))
Check "failed to start is the machine's" (Test-MachineFailure (Get-CliFailure "failed to run" "Completed"))
Check "an incomplete job is not" (-not (Test-MachineFailure (Get-CliFailure $work "Failed")))
Check "no failure is not" (-not (Test-MachineFailure $null))

Write-Host "`nThe CLI is found where a scheduled task can find it"
$found = Find-ClaudeCli
Check "Find-ClaudeCli returns a path that exists, or null" (($null -eq $found) -or (Test-Path $found))

Write-Host "`n$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
