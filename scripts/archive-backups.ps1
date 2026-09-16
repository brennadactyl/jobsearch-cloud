<#
.SYNOPSIS
  Copies new database exports into the protected archive. Runs as SYSTEM.

.DESCRIPTION
  Copies exports not yet in the archive, matched by name, and never mirrors a
  deletion: an archive that did could be emptied by deleting the source.

  It does prune by age, on its own rule: an export taken more than
  RetentionDays (30) ago is removed, which is how a deleted account's data
  leaves this archive too. The age is the date in the file's name. Nothing is
  pruned unless the archive also holds an export from inside the window, so an
  export that has stopped running never lets this empty the archive - the
  newest old backups stay until something newer arrives to replace them.

  Runs as SYSTEM because the archive is read-only to the everyday account (see
  protect-backups.ps1, which registers the task). Its log lives in the archive
  for the same reason, so nothing unelevated can rewrite it.

  See README.md, "Backups".

.PARAMETER SourceDir
  Where backup-tracker.ps1 writes. Required.

.PARAMETER ArchiveDir
  The protected destination. Defaults to a folder under ProgramData, outside the
  repository, so nothing aimed at the project reaches it.

.PARAMETER Pattern
  Which files to archive. Defaults to *.sql.

.PARAMETER RetentionDays
  How many days of exports the archive keeps. Defaults to 30. 0 keeps
  everything.

.EXAMPLE
  .\archive-backups.ps1 -SourceDir C:\VibeCoding\jobsearch-cloud\private\backups
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [string]$ArchiveDir = (Join-Path $env:ProgramData "JobSearchTracker\backups"),

    [string]$Pattern = "*.sql",

    [int]$RetentionDays = 30
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ArchiveDir)) {
    Write-Error "Archive folder $ArchiveDir does not exist. Run protect-backups.ps1 (elevated) first - it creates the folder, locks it down, and registers this task."
    exit 1
}

$logFile = Join-Path $ArchiveDir "archive.log"
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch { }
}

Log "===== archive-backups starting (running as $env:USERNAME) ====="

# The day an export was taken, from its name (d1-<db>-yyyy-MM-dd-HHmmss.sql), or
# $null for a name that doesn't carry one - never pruned.
function Get-ExportDate([string]$Name) {
    $m = [regex]::Match($Name, '(\d{4}-\d{2}-\d{2})-\d{6}\.sql$')
    if (-not $m.Success) { return $null }
    return [datetime]::ParseExact($m.Groups[1].Value, "yyyy-MM-dd", $null)
}
$cutoff = if ($RetentionDays -gt 0) { (Get-Date).Date.AddDays(-$RetentionDays) } else { $null }

# No early exits from here on: every run reaches the staleness check at the
# bottom, however it went. That check is the only thing that notices exports
# have stopped reaching the archive, and the usual cause is this run failing - a
# source folder that moved fails the same way every night, and a check that only
# ran on a successful night would never see it.
$exitCode = 0
$copied = 0
$failed = 0

if (-not (Test-Path $SourceDir)) {
    Log "ERROR: source folder $SourceDir does not exist, so nothing can be archived."
    Log "       If the repository moved, re-run protect-backups.ps1 elevated from its new location - it re-registers this task with the right folder."
    $exitCode = 1
} else {
    foreach ($f in Get-ChildItem $SourceDir -Filter $Pattern -File | Sort-Object Name) {
        $dest = Join-Path $ArchiveDir $f.Name
        if (Test-Path $dest) { continue }
        # Already past the window: copying it in would only have it pruned below,
        # and copied in again tomorrow while the source still holds it.
        $taken = Get-ExportDate $f.Name
        if ($cutoff -and $taken -and $taken -lt $cutoff) { continue }
        try {
            Copy-Item $f.FullName $dest
            Log ("archived {0} ({1:N0} bytes)" -f $f.Name, $f.Length)
            $copied++
        } catch {
            Log "ERROR: could not archive $($f.Name) - $($_.Exception.Message)"
            $failed++
        }
    }

    if ($cutoff) {
        $exports = @(Get-ChildItem $ArchiveDir -Filter $Pattern -File |
            ForEach-Object { [pscustomobject]@{ File = $_; Taken = (Get-ExportDate $_.Name) } } |
            Where-Object { $_.Taken })
        $inWindow = @($exports | Where-Object { $_.Taken -ge $cutoff })
        if ($inWindow.Count -eq 0) {
            Log ("retention: skipped - no export from the last {0} days is here, so nothing older is pruned until one arrives." -f $RetentionDays)
        } else {
            $pruned = 0
            foreach ($e in @($exports | Where-Object { $_.Taken -lt $cutoff })) {
                try {
                    Remove-Item $e.File.FullName -Force -ErrorAction Stop
                    Log ("pruned {0} (taken {1:yyyy-MM-dd}, older than {2} days)" -f $e.File.Name, $e.Taken, $RetentionDays)
                    $pruned++
                } catch {
                    Log "ERROR: could not prune $($e.File.Name) - $($_.Exception.Message)"
                    $failed++
                }
            }
            Log ("retention: kept exports taken on or after {0:yyyy-MM-dd}; pruned {1}" -f $cutoff, $pruned)
        }
    }

    if ($failed -gt 0) { $exitCode = 2 }
}

$total = (Get-ChildItem $ArchiveDir -Filter $Pattern -File).Count
$bytes = (Get-ChildItem $ArchiveDir -Filter $Pattern -File | Measure-Object -Property Length -Sum).Sum
Log ("$copied new, $failed failed; archive now holds {0} file(s), {1:N1} MB" -f $total, ($bytes / 1MB))

# Whether exports are still arriving, judged by the newest one's name - the day
# it was taken - rather than when it was copied in, since a late catch-up copy
# would otherwise make a week-old export look fresh. Two nights missed is a
# warning; one can be a machine that was off.
$newest = @(Get-ChildItem $ArchiveDir -Filter $Pattern -File |
    ForEach-Object { Get-ExportDate $_.Name } | Where-Object { $_ }) |
    Sort-Object -Descending | Select-Object -First 1
if (-not $newest) {
    Log "WARNING: the archive holds no dated export at all."
    if ($exitCode -eq 0) { $exitCode = 2 }
} else {
    $daysOld = ((Get-Date).Date - $newest).Days
    if ($daysOld -ge 2) {
        Log ("WARNING: the newest archived backup was taken {0:yyyy-MM-dd}, {1} days ago - backups have stopped reaching the archive." -f $newest, $daysOld)
        if ($exitCode -eq 0) { $exitCode = 2 }
    }
}

switch ($exitCode) {
    0 { Log "===== done =====" }
    1 { Log "===== done, WITH ERRORS =====" }
    default { Log "===== done, WITH WARNINGS =====" }
}
exit $exitCode
