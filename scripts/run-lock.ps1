<#
.SYNOPSIS
  One run at a time on this machine. Dot-sourced by the runners; not run on its
  own.

.DESCRIPTION
  Each person's nightly search and the application fill drive the same
  `claude` CLI under one Claude account; run-search.ps1 and run-fill.ps1
  dot-source this. Two at once is two runs fighting over it: they interleave,
  slow each other down, and the second one's failures read as search failures.

  Spacing the schedule alone can't prevent that: spacing is a guess about how
  long a run takes, and it stops being true the moment one person's search
  gets slower or another person joins. So a run waits for whichever is going,
  rather than starting on top of it.

  The lock is a named mutex, which the operating system releases when the
  process holding it exits, however it exits. A run that is killed, crashes or
  loses power cannot leave the machine locked: the next run is handed the lock
  and told it was abandoned.

  `Global\` needs a privilege a normal user doesn't have, so the name falls back
  to `Local\`, which covers runs in one logon session - what scheduled tasks
  registered "run only when the user is logged on" actually are.
#>

# Every runner uses this one name: the point is that they contend.
$script:RUN_LOCK_NAME = "JobSearchTrackerRun"

# How long a run waits before giving up on the machine. Long enough for a slow
# search plus a retry (searches take 10-40 minutes), short enough that a run
# still fails in time to be visible in the morning rather than sitting silent
# until the next night.
$script:RUN_LOCK_MAX_WAIT_MINUTES = 150

$script:runLock = $null
$script:runLockWaitedSeconds = 0

<#
Waits for the machine, and takes it. Returns $true when this run holds the lock
and $false when it gave up waiting - the caller decides what giving up means,
since a search records a failed run and the onboarding build tells a person.

`Log` is expected to exist in the caller: these lines belong in that run's log,
next to what it was doing.
#>
function Enter-RunLock {
    $created = $false
    foreach ($scope in @("Global", "Local")) {
        try {
            $script:runLock = New-Object System.Threading.Mutex($false, "$scope\$($script:RUN_LOCK_NAME)")
            $created = $true
            break
        } catch [System.UnauthorizedAccessException] {
            # Creating a Global object needs SeCreateGlobalPrivilege, which an
            # ordinary logged-in user doesn't hold. Local is the same lock for
            # every run in this logon session.
            Log "run queue: no permission for a machine-wide lock - using this logon session's"
        } catch {
            Log "WARNING: run queue: couldn't create the $scope lock ($($_.Exception.Message))"
        }
    }
    if (-not $created) {
        # Better to run than to refuse: an unlocked run risks a slow night, and
        # refusing guarantees a missed one.
        Log "WARNING: run queue: no lock could be created - running without waiting for other runs"
        return $true
    }

    $start = Get-Date
    $waitMs = $script:RUN_LOCK_MAX_WAIT_MINUTES * 60 * 1000
    try {
        if (-not $script:runLock.WaitOne($waitMs)) {
            $script:runLockWaitedSeconds = [int]((Get-Date) - $start).TotalSeconds
            Log "ERROR: run queue: another run has been going for $($script:RUN_LOCK_MAX_WAIT_MINUTES) minutes and is still going - giving up"
            $script:runLock.Dispose()
            $script:runLock = $null
            return $false
        }
    } catch [System.Threading.AbandonedMutexException] {
        # The run holding it died without releasing. The lock is ours; the
        # machine is free. Worth a line, because that run reported nothing.
        Log "run queue: the previous run ended without releasing the lock - taking it"
    }

    $script:runLockWaitedSeconds = [int]((Get-Date) - $start).TotalSeconds
    if ($script:runLockWaitedSeconds -ge 2) {
        Log "run queue: waited $($script:runLockWaitedSeconds)s for another run to finish"
    } else {
        Log "run queue: machine was free"
    }
    return $true
}

<#
Gives the machine back. Safe to call twice, and safe to call without ever having
taken the lock - which is what makes it callable from the paths that give up
early.
#>
function Exit-RunLock {
    if (-not $script:runLock) { return }
    try { $script:runLock.ReleaseMutex() } catch {
        # Already released, or never held because the wait timed out. Either way
        # this run is not the holder and has nothing to give back.
    }
    $script:runLock.Dispose()
    $script:runLock = $null
}
