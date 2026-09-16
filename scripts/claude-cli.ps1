<#
.SYNOPSIS
  Finding the claude CLI, and telling a turn that did nothing from one that
  did. Dot-sourced by the runners; not run on its own.

.DESCRIPTION
  run-search.ps1, run-fill.ps1 and run-onboarding.ps1 all drive the same CLI on
  the same machine, so whether it can be found, whether it is logged in and
  whether it started are one set of facts. Each script used to keep its own
  copy of these checks, and the copies drifted: a failure wording one of them
  caught, another let through as a success.

  What each run does about a failure stays in that run, because each one
  reports to someone different - see Get-CliFailure.
#>

# The failure wordings. A new CLI wording goes here, once, and every run
# recognises it.
#
# All of them mean the same thing to a run: the CLI never did the work. An
# unauthenticated CLI prints its message and exits 0, so the job completes and
# Task Scheduler records a success; a launcher failure comes from the npm shim,
# not the CLI, and never matches the authentication wordings.
$script:CLI_NOT_AUTHENTICATED = @(
    "Not logged in", "Please run /login", "Invalid API key",
    "authentication_error", "Failed to authenticate", "Invalid bearer token"
)
$script:CLI_FAILED_TO_START = @(
    "failed to run", "ApplicationFailedException", "NativeCommandFailed", "is too long"
)

# How much of the output the wordings are looked for in. A CLI that can't start
# or can't log in says so before it does anything, so the message is at the
# top. A turn that did the work ends with its own summary, and that summary can
# legitimately contain these words - a search reporting that a careers page said
# "Not logged in" did not fail. Reading only the head keeps that from being
# mistaken for the CLI's own failure.
$script:CLI_FAILURE_WINDOW = 1000

<#
The CLI's path, or $null when it is not installed where a scheduled task can
find it. On PATH first; then npm's global shim, since a task's environment often
lacks the PATH an interactive shell has.
#>
function Find-ClaudeCli {
    $command = Get-Command claude -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $fallback = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $fallback) { return $fallback }
    return $null
}

<#
Why a finished CLI turn did no work, or $null when nothing says it failed.

Returns @{ Kind; Message; Hint }:
  - Kind "no-output"          the CLI printed nothing at all
  - Kind "not-authenticated"  the CLI could not log in
  - Kind "failed-to-start"    the launcher failed and the CLI never ran
  - Kind "incomplete"         the job running the CLI did not complete

Message says what happened, for a log line or a run record; each caller adds
what that meant for its own work. Hint, when there is one, is what the operator
does about it.

The first three are problems with this machine, not with anyone's search, and
the same fix clears them for every run on it. A $null result is not proof the
turn worked - only that none of these wordings appeared - so the runners still
check what the turn actually produced.
#>
function Get-CliFailure([string]$Output, [string]$JobState) {
    $text = if ($Output) { $Output.Trim() } else { "" }
    if (-not $text) {
        return @{ Kind = "no-output"; Message = "the CLI produced no output at all"; Hint = "" }
    }

    $head = if ($text.Length -gt $script:CLI_FAILURE_WINDOW) { $text.Substring(0, $script:CLI_FAILURE_WINDOW) } else { $text }
    foreach ($wording in $script:CLI_NOT_AUTHENTICATED) {
        if ($head.Contains($wording)) {
            return @{
                Kind = "not-authenticated"; Message = "the CLI is not authenticated"
                Hint = "Run ``claude setup-token``, then: setx CLAUDE_CODE_OAUTH_TOKEN `"<token>`""
            }
        }
    }
    foreach ($wording in $script:CLI_FAILED_TO_START) {
        if ($head.Contains($wording)) {
            return @{
                Kind = "failed-to-start"; Message = "the CLI failed to start"
                Hint = "See the output above - a launcher failure, not a result."
            }
        }
    }

    if ($JobState -and $JobState -ne "Completed") {
        return @{ Kind = "incomplete"; Message = "the run did not complete (job state: $JobState)"; Hint = "" }
    }
    return $null
}

<#
Whether a failure is the machine's rather than the work's: the same fix clears
it for every run on this machine, and nothing about the person or the search
caused it.
#>
function Test-MachineFailure($Failure) {
    return [bool]($Failure -and $Failure.Kind -in @("no-output", "not-authenticated", "failed-to-start"))
}
