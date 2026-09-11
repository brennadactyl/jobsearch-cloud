<#
.SYNOPSIS
  Copies new database exports into the protected archive. Runs as SYSTEM.

.DESCRIPTION
  Copies exports not yet in the archive, matched by name, and never removes
  anything: an archive that mirrored deletions could be emptied by deleting the
  source.

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

.EXAMPLE
  .\archive-backups.ps1 -SourceDir C:\VibeCoding\private\backups
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [string]$ArchiveDir = (Join-Path $env:ProgramData "JobSearchTracker\backups"),

    [string]$Pattern = "*.sql"
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

$copied = 0
$failed = 0
foreach ($f in Get-ChildItem $SourceDir -Filter $Pattern -File | Sort-Object Name) {
    $dest = Join-Path $ArchiveDir $f.Name
    if (Test-Path $dest) { continue }
    try {
        Copy-Item $f.FullName $dest
        Log ("archived {0} ({1:N0} bytes)" -f $f.Name, $f.Length)
        $copied++
    } catch {
        Log "ERROR: could not archive $($f.Name) - $($_.Exception.Message)"
        $failed++
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
