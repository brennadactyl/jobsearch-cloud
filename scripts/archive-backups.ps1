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
  .\archive-backups.ps1 -SourceDir C:\VibeCoding\private\backups
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

if (-not (Test-Path $SourceDir)) {
    Log "ERROR: source folder $SourceDir does not exist."
    exit 1
}

# The day an export was taken, from its name (d1-<db>-yyyy-MM-dd-HHmmss.sql), or
# $null for a name that doesn't carry one - never pruned.
function Get-ExportDate([string]$Name) {
    $m = [regex]::Match($Name, '(\d{4}-\d{2}-\d{2})-\d{6}\.sql$')
    if (-not $m.Success) { return $null }
    return [datetime]::ParseExact($m.Groups[1].Value, "yyyy-MM-dd", $null)
}
$cutoff = if ($RetentionDays -gt 0) { (Get-Date).Date.AddDays(-$RetentionDays) } else { $null }

$copied = 0
$failed = 0
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

$total = (Get-ChildItem $ArchiveDir -Filter $Pattern -File).Count
$bytes = (Get-ChildItem $ArchiveDir -Filter $Pattern -File | Measure-Object -Property Length -Sum).Sum
Log ("$copied new, $failed failed; archive now holds {0} file(s), {1:N1} MB" -f $total, ($bytes / 1MB))

# Checked even on a clean run: this is the only place that notices the daily
# export has stopped.
$newest = Get-ChildItem $ArchiveDir -Filter $Pattern -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest -and ((Get-Date) - $newest.LastWriteTime).TotalDays -gt 2) {
    Log ("WARNING: newest archived backup is {0:N1} days old - the daily export may have stopped running." -f ((Get-Date) - $newest.LastWriteTime).TotalDays)
    Log "===== done, WITH WARNINGS ====="
    exit 2
}

Log "===== done ====="
if ($failed -gt 0) { exit 2 }
exit 0
