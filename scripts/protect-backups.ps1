<#
.SYNOPSIS
  One-time elevated setup: creates the protected backup archive and the SYSTEM
  task that fills it. Must be run from an Administrator PowerShell.

.DESCRIPTION
  Elevation is the boundary. The everyday account is an Administrators member
  but runs unelevated with a filtered token (Administrators deny-only, no
  take-ownership privilege), so rights granted to Administrators are out of its
  reach without a UAC prompt, and it can't undo what this sets up.

  It sets up:

  1. An archive folder outside the repository, owned by Administrators with
     inheritance removed: Administrators and SYSTEM full control, Authenticated
     Users read. Unelevated processes can read the backups but not change or
     delete them. Ownership matters as much as the entries: an owner always
     holds WRITE_DAC and could grant the rights back.

  2. A copy of archive-backups.ps1 inside that folder, and a daily task running
     that copy as SYSTEM, because SYSTEM must never run a script the everyday
     account can edit. Re-run this script after changing the repo copy.

  3. The nightly export task (backup-tracker.ps1), registered as the invoking
     user rather than SYSTEM, since it only writes to the repo's own folder.

  It does not protect the D1 database itself; see README.md, "Backups".

  Safe to re-run: it refreshes the permissions, the script copy, and the tasks.

.PARAMETER SourceDir
  Where backup-tracker.ps1 writes its exports. Defaults to
  <repo>\private\backups.

.PARAMETER ArchiveDir
  The protected destination. Defaults to a folder under ProgramData, outside the
  repository, so nothing aimed at the project reaches it.

.PARAMETER At
  When the daily archive task runs. Defaults to 03:45, after the export.

.PARAMETER TaskName
  Name of the archive task.

.PARAMETER ExportAt
  When the nightly export runs. Defaults to 03:15, after the searches.

.PARAMETER ExportTaskName
  Name of the export task.

.EXAMPLE
  # From an Administrator PowerShell. -ExecutionPolicy Bypass because the
  # machine policy is Undefined, which is Restricted for an interactive shell.
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\VibeCoding\scripts\protect-backups.ps1"
#>
param(
    [string]$SourceDir,
    [string]$ArchiveDir = (Join-Path $env:ProgramData "JobSearchTracker\backups"),
    [string]$At = "03:45",
    [string]$TaskName = "JobSearchTracker-ArchiveBackups",
    [string]$ExportAt = "03:15",
    [string]$ExportTaskName = "JobSearchTracker-Backup"
)

# Neither task name may match "JobSearch-*": setup-scheduler.ps1 unregisters
# tasks matching that as stale searches.

$ErrorActionPreference = "Stop"

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $SourceDir) { $SourceDir = Join-Path $repoDir "private\backups" }

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "This script has to run elevated - that is the point of it." -ForegroundColor Yellow
    Write-Host "Right-click PowerShell, Run as administrator, then:"
    Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Write-Host ""
    exit 1
}

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---- 1. The archive folder ------------------------------------------------
Step "Creating $ArchiveDir"
$binDir = Join-Path $ArchiveDir "bin"
foreach ($d in @($ArchiveDir, $binDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

Step "Taking ownership as Administrators"
# Well-known SIDs rather than names: "BUILTIN\Administrators" is localized, and
# a script that silently no-ops on a non-English Windows is worse than one that
# fails.
& icacls $ArchiveDir /setowner "*S-1-5-32-544" /T /C /Q | Out-Null

Step "Locking permissions (Administrators + SYSTEM full, everyone else read)"
& icacls $ArchiveDir /inheritance:r /Q | Out-Null
& icacls $ArchiveDir /grant "*S-1-5-32-544:(OI)(CI)F" /Q | Out-Null   # Administrators
& icacls $ArchiveDir /grant "*S-1-5-18:(OI)(CI)F"     /Q | Out-Null   # SYSTEM
& icacls $ArchiveDir /grant "*S-1-5-11:(OI)(CI)(RX)"  /Q | Out-Null   # Authenticated Users: read

# ---- 2. The SYSTEM-executed copy of the archiver --------------------------
Step "Copying archive-backups.ps1 into $binDir (SYSTEM must not run a user-writable script)"
$srcScript = Join-Path $PSScriptRoot "archive-backups.ps1"
if (-not (Test-Path $srcScript)) { throw "archive-backups.ps1 not found next to this script." }
Copy-Item $srcScript (Join-Path $binDir "archive-backups.ps1") -Force
$runScript = Join-Path $binDir "archive-backups.ps1"

# ---- 3. The nightly export, running as the person who set this up ---------
# Interactive logon, like the search tasks: no stored password, so it runs only
# while that user is logged in.
Step "Registering '$ExportTaskName' to run as $env:USERNAME daily at $ExportAt"
$exportScript = Join-Path $PSScriptRoot "backup-tracker.ps1"
if (-not (Test-Path $exportScript)) { throw "backup-tracker.ps1 not found next to this script." }
$exportAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`" -RepoDir `"{1}`"" -f $exportScript, $repoDir)
$exportPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$exportSettings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $ExportTaskName -Action $exportAction `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $ExportAt) `
    -Principal $exportPrincipal -Settings $exportSettings -Force `
    -Description "Exports the job-search tracker database to a dated .sql file, locally and to an off-machine mirror." | Out-Null

# ---- 4. The archive task ---------------------------------------------------
Step "Registering '$TaskName' to run as SYSTEM daily at $At"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`" -SourceDir `"{1}`" -ArchiveDir `"{2}`"" -f $runScript, $SourceDir, $ArchiveDir)
$trigger   = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force `
    -Description "Copies job-search tracker database exports into an archive the everyday account cannot modify or delete." | Out-Null

# ---- 5. Run it once, so a broken setup shows now --------------------------
Step "Running it once"
Start-ScheduledTask -TaskName $TaskName
$deadline = (Get-Date).AddSeconds(60)
do {
    Start-Sleep -Seconds 2
    $state = (Get-ScheduledTask -TaskName $TaskName).State
} while ($state -eq "Running" -and (Get-Date) -lt $deadline)
$result = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult

Write-Host ""
Write-Host "----- result -----"
Write-Host "Archive task last run result: $result  (0 = clean, 2 = ran with warnings, anything else = look at $ArchiveDir\archive.log)"
Write-Host ("Nightly export '{0}' registered for {1} at {2}; archive '{3}' as SYSTEM at {4}." -f $ExportTaskName, $env:USERNAME, $ExportAt, $TaskName, $At)
$archived = Get-ChildItem $ArchiveDir -Filter "*.sql" -File -ErrorAction SilentlyContinue
Write-Host ("Archived backups: {0} file(s), {1:N1} MB" -f $archived.Count, (($archived | Measure-Object -Property Length -Sum).Sum / 1MB))
Write-Host ""
Write-Host "----- permissions on $ArchiveDir -----"
& icacls $ArchiveDir
Write-Host ""
Write-Host "Verify from a NORMAL (unelevated) PowerShell - both should refuse:" -ForegroundColor Yellow
Write-Host "    Remove-Item '$ArchiveDir\*.sql'"
Write-Host "    Set-Content '$ArchiveDir\archive.log' -Value 'x'"
Write-Host ""
Write-Host "To prune old backups later, do it from an elevated prompt - that is the only"
Write-Host "way anything in here can be removed, and it is meant to take a deliberate act."
