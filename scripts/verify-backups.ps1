<#
.SYNOPSIS
  Checks that the protected backup archive is actually protected. Run it from a
  NORMAL, unelevated PowerShell - that is the whole point.

.DESCRIPTION
  Tests protect-backups.ps1's guarantees from an unelevated process, the kind
  the protection exists to stop: reads work, writes don't, the script SYSTEM
  runs can't be edited, and the permissions can't be granted back. Run it after
  protect-backups.ps1 and after anything that touches permissions, ownership or
  the archive location, because an ACL that stopped applying looks like one
  that works.

  The destructive probes are real attempts, each expected to be refused. One
  that succeeds loses nothing: every archived file also exists in the working
  folder and the mirror, and the next archive run copies it back.

  See README.md, "Backups".

.PARAMETER ArchiveDir
  The protected folder. Defaults to the same path protect-backups.ps1 uses.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\VibeCoding\scripts\verify-backups.ps1"
#>
param(
    [string]$ArchiveDir = (Join-Path $env:ProgramData "JobSearchTracker\backups")
)

if (-not (Test-Path $ArchiveDir)) {
    Write-Host "No archive at $ArchiveDir - run protect-backups.ps1 (elevated) first." -ForegroundColor Yellow
    exit 1
}

$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($elevated) {
    Write-Host "You are running elevated. The write probes below SHOULD succeed for you," -ForegroundColor Yellow
    Write-Host "so this run proves nothing - re-run it from an ordinary PowerShell window." -ForegroundColor Yellow
    Write-Host ""
}

$pass = 0; $fail = 0
function Probe($label, $shouldSucceed, $block) {
    $err = $null
    try { & $block } catch { $err = $_.Exception.Message }
    $ok = ($null -eq $err)
    if ($ok -eq $shouldSucceed) { $script:pass++; $v = "PASS" } else { $script:fail++; $v = "FAIL" }
    "  {0}  {1,-46} {2}" -f $v, $label, $(if ($ok) { "succeeded" } else { "refused" })
}

$owner  = (Get-Acl $ArchiveDir).Owner
$sqls   = @(Get-ChildItem $ArchiveDir -Filter *.sql -File)
$logPath = Join-Path $ArchiveDir "archive.log"
"archive: $ArchiveDir"
"owner  : $owner"
"holds  : $($sqls.Count) backup(s)"
""

if ($sqls.Count -eq 0) {
    Write-Host "Nothing archived yet - run the JobSearchTracker-ArchiveBackups task, then this again." -ForegroundColor Yellow
    exit 1
}
# The smallest file, so a destructive probe that gets through loses the least.
$target = $sqls | Sort-Object Length | Select-Object -First 1

"===== reads (must work - restoring a backup shouldn't need ceremony) ====="
Probe "list the archive"            $true  { Get-ChildItem $ArchiveDir -File | Out-Null }
Probe "read a backup end to end"    $true  { [System.IO.File]::ReadAllBytes($target.FullName) | Out-Null }
Probe "read the archive log"        $true  { Get-Content $logPath -Raw | Out-Null }

""
"===== writes (must all be refused) ====="
Probe "open a backup for writing"   $false { $fs = [System.IO.File]::Open($target.FullName, "Open", "Write"); $fs.Close() }
Probe "create a new file"           $false { [System.IO.File]::WriteAllText((Join-Path $ArchiveDir "probe.sql"), "x") }
Probe "rewrite the archive log"     $false { Set-Content -Path $logPath -Value "x" -ErrorAction Stop }
Probe "rename a backup"             $false { Rename-Item $target.FullName ($target.Name + ".bak") -ErrorAction Stop }
Probe "delete a backup"             $false { Remove-Item $target.FullName -Force -ErrorAction Stop }
Probe "delete the archive folder"   $false { Remove-Item -Recurse -Force $ArchiveDir -ErrorAction Stop }

""
"===== escalation (the script SYSTEM runs must not be user-writable) ====="
# A SYSTEM task running a user-editable script hands out administrator access,
# which is why the archiver runs from a copy inside the archive.
$sysScript = Join-Path $ArchiveDir "bin\archive-backups.ps1"
Probe "edit the script SYSTEM runs" $false { $fs = [System.IO.File]::Open($sysScript, "Open", "Write"); $fs.Close() }
Probe "replace it with a new file"  $false { [System.IO.File]::WriteAllText($sysScript, "# owned") }

""
"===== undoing the protection (Administrators owns it, so no WRITE_DAC) ====="
# An owner always holds WRITE_DAC, so these are refused only while Administrators
# owns the folder.
Probe "grant myself full control"   $false {
    & icacls $ArchiveDir /grant "${env:USERNAME}:(OI)(CI)F" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "access denied" }
}
Probe "take ownership back"         $false {
    & icacls $ArchiveDir /setowner "$env:USERNAME" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "access denied" }
}

""
$still = @(Get-ChildItem $ArchiveDir -Filter *.sql -File).Count
"===== $pass passed, $fail failed; $still backup(s) still present ====="
if ($fail -gt 0) {
    Write-Host "The archive is NOT protected as intended - re-run protect-backups.ps1 elevated." -ForegroundColor Red
    exit 1
}
exit 0
