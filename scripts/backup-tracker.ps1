<#
.SYNOPSIS
  Exports the entire tracker database to a timestamped .sql file, downloads
  every document from R2 beside it, and copies both to an off-machine mirror.

.DESCRIPTION
  A copy outside Cloudflare is the only one that survives `wrangler d1 delete`
  or losing the account; Time Travel recovers from neither. See README.md,
  "Backups".

  The export is staged in a temp file and validated before it lands, because
  wrangler can exit 0 with an empty export and the archive is append-only (see
  protect-backups.ps1), so a bad file could not be removed from it.

  Backups are kept for RetentionDays (30), here and in the mirror. That is what
  lets a deleted account leave the backups too: nothing of it is exported after
  the delete, and the last export holding it ages out a month later. Pruning
  only follows a clean run - a new export that landed and passed every check -
  so an export that has stopped working, or come back suspect, never deletes the
  good ones before it. The age is read from the date in each file's name, not
  from the file's timestamps, which a copy can change.

  Exit codes: 0 wrote and validated; 1 the export failed, nothing written; 2
  wrote the file but a check failed - read the log. Task Scheduler shows the
  code as "Last Run Result". A document problem is always 2, because the .sql
  has already landed by then.

.PARAMETER RepoDir
  The repository root - used to find server\wrangler.toml (for the database
  name) and the default backup folder. Defaults to the parent of this script.

.PARAMETER BackupDir
  Where dated exports are written. Defaults to <RepoDir>\private\backups.
  Documents land beside them under <BackupDir>\documents\<timestamp>\<user-id>\.

.PARAMETER DataDir
  Used only to find each person's tracker.json, whose token authenticates the
  document download. Defaults to JOB_SEARCH_DATA_DIR, else <RepoDir>\private.

.PARAMETER NoDocuments
  Skip the R2 document download. The .sql export still happens.

.PARAMETER MirrorDir
  A second copy off this machine's disk, such as a synced folder or an external
  drive. Defaults to JOB_SEARCH_BACKUP_MIRROR, then a folder in OneDrive. A
  failed mirror copy is a warning, not a failure, since the local copy landed.

.PARAMETER NoMirror
  Skip the off-machine copy entirely.

.PARAMETER RetentionDays
  How many days of backups to keep, in BackupDir and the mirror. Defaults to 30.
  0 keeps everything.

.PARAMETER MinBytes
  Refuse to call an export healthy below this size. Defaults to 10 KB: catches
  an empty or truncated file without tripping on a new install with few rows.

.EXAMPLE
  .\backup-tracker.ps1
  .\backup-tracker.ps1 -NoMirror -BackupDir D:\Backups
#>
param(
    [string]$RepoDir,
    [string]$BackupDir,
    [string]$DataDir,
    [string]$MirrorDir = $(
        if ($env:JOB_SEARCH_BACKUP_MIRROR) { $env:JOB_SEARCH_BACKUP_MIRROR }
        elseif ($env:OneDrive) { Join-Path $env:OneDrive "JobSearchTracker\backups" }
        else { "" }
    ),
    [switch]$NoMirror,
    [switch]$NoDocuments,
    [int]$RetentionDays = 30,
    [int]$MinBytes = 10240
)

$ErrorActionPreference = "Stop"

# A param default is evaluated before $PSScriptRoot is reliably set, so the
# script's own folder is resolved here instead. Everything below hangs off the
# repo root, so an empty one would write a backup somewhere nobody looks.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
             else { "" }
if (-not $RepoDir) {
    if (-not $scriptDir) {
        throw "Can't work out where this script lives, so it can't find the repo. Pass -RepoDir, or run it by its full path."
    }
    $RepoDir = (Resolve-Path (Join-Path $scriptDir "..")).Path
}
if (-not $DataDir) {
    $DataDir = if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $RepoDir "private" }
}

if (-not $BackupDir) { $BackupDir = Join-Path $RepoDir "private\backups" }
$logDir = Join-Path $RepoDir "private\logs"
foreach ($d in @($BackupDir, $logDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}
$logFile = Join-Path $logDir "backup.log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

Log "===== backup-tracker starting ====="

# Read from wrangler.toml so a renamed database can't leave this exporting the
# old name.
$wranglerToml = Join-Path $RepoDir "server\wrangler.toml"
if (-not (Test-Path $wranglerToml)) {
    Log "ERROR: no server\wrangler.toml under $RepoDir - can't tell which database to export."
    exit 1
}
$dbName = ([regex]::Match((Get-Content $wranglerToml -Raw), 'database_name\s*=\s*"([^"]+)"')).Groups[1].Value
if (-not $dbName) {
    Log "ERROR: server\wrangler.toml has no database_name."
    exit 1
}
Log "database: $dbName"

$stamp   = Get-Date -Format "yyyy-MM-dd-HHmmss"
$name    = "d1-$dbName-$stamp.sql"
$staging = Join-Path $env:TEMP $name

# Run wrangler through Start-Process rather than the call operator. Windows
# PowerShell 5.1 turns a native command's stderr into ErrorRecords when you
# redirect it, which both mangles wrangler's output and trips
# $ErrorActionPreference = "Stop" on a run that actually succeeded. Redirecting
# to files sidesteps the whole behaviour and still gets the output into the log.
$wranglerCmd = Join-Path $env:APPDATA "npm\wrangler.cmd"
if (-not (Test-Path $wranglerCmd)) { $wranglerCmd = "wrangler.cmd" }
$outFile = Join-Path $env:TEMP "backup-tracker-wrangler-out.txt"
$errFile = Join-Path $env:TEMP "backup-tracker-wrangler-err.txt"

function Invoke-Export {
    param([string]$Target)
    $p = Start-Process -FilePath $wranglerCmd `
        -ArgumentList @("d1", "export", $dbName, "--remote", "--output", "`"$Target`"") `
        -WorkingDirectory (Join-Path $RepoDir "server") `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    return $p.ExitCode
}

# One retry: the export endpoint fails transiently ("A request to the Cloudflare
# API failed"), and an unattended job that gives up leaves no backup.
Log "exporting to staging: $staging"
$code = Invoke-Export $staging
if ($code -ne 0 -or -not (Test-Path $staging)) {
    Log "export attempt 1 failed (exit $code) - retrying in 30s"
    Get-Content $errFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  wrangler: $_" }
    Start-Sleep -Seconds 30
    $code = Invoke-Export $staging
}

if ($code -ne 0 -or -not (Test-Path $staging)) {
    Log "ERROR: wrangler d1 export failed (exit $code) on both attempts. Nothing was written."
    Get-Content $outFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  wrangler: $_" }
    Get-Content $errFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  wrangler: $_" }
    exit 1
}

# ---- Validate the staged file before it becomes a backup. ------------------
$size    = (Get-Item $staging).Length
$text    = Get-Content $staging -Raw
$tables  = ([regex]::Matches($text, '(?im)^\s*CREATE TABLE')).Count
$inserts = ([regex]::Matches($text, '(?im)^\s*INSERT INTO')).Count
# A d1 export writes one INSERT per row, so this counts accounts, for the
# document completeness check below.
$userCount = ([regex]::Matches($text, '(?im)^\s*INSERT INTO\s+"?users"?\s')).Count
Log ("staged: {0:N0} bytes, {1} CREATE TABLE, {2} INSERT INTO, {3} account(s)" -f $size, $tables, $inserts, $userCount)

# The demo account (seed-demo-user.ps1) never has a private folder, so it is
# discounted from the completeness check below, which would otherwise warn on
# every run and stop being read. A name match alone isn't enough, since "Demo"
# can belong to a real person: like seed-demo-user.ps1, it also requires every
# posting on the account to be an example.com URL.
$exportLines = $text -split "`n"
$demoIds = @()
foreach ($m in [regex]::Matches($text, '(?im)^\s*INSERT INTO\s+"?users"?\s[^\r\n]*')) {
    $idm = [regex]::Match($m.Value, "'([0-9a-fA-F-]{36})'")
    $nm  = [regex]::Match($m.Value, "'[0-9a-fA-F-]{36}'\s*,\s*'([^']*)'")
    if (-not $idm.Success -or $nm.Groups[1].Value -ne 'Demo') { continue }
    $id = $idm.Groups[1].Value
    $urls = @()
    foreach ($line in $exportLines) {
        if ($line.IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        foreach ($u in [regex]::Matches($line, 'https?://[^''"\s,)]+')) { $urls += $u.Value }
    }
    $real = $urls | Where-Object { $_ -notmatch '(?i)^https?://([\w-]+\.)*example\.com(/|$|[/?#])' }
    if ($urls.Count -gt 0 -and -not $real) {
        $demoIds += $id
        Log ("  '{0}' ({1}...) is the demo account - {2} posting(s), all example.com - no folder expected here." -f $nm.Groups[1].Value, $id.Substring(0, 8), $urls.Count)
    } elseif ($urls.Count -gt 0) {
        Log ("  '{0}' ({1}...) is named Demo but has {2} non-example.com posting(s) - treating it as a person." -f $nm.Groups[1].Value, $id.Substring(0, 8), @($real).Count)
    }
}
$expectedAccounts = $userCount - $demoIds.Count

$problems = @()
if ($size -lt $MinBytes) { $problems += "only $size bytes (under the $MinBytes floor)" }
if ($tables -lt 1)       { $problems += "no CREATE TABLE statements" }
if ($inserts -lt 1)      { $problems += "no INSERT statements - the schema came back but no data" }

# A partial dump still reads as a valid file, so compare with the last backup.
$previous = Get-ChildItem $BackupDir -Filter "*.sql" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($previous -and $size -lt ($previous.Length * 0.5)) {
    $problems += ("less than half the size of the previous backup ({0:N0} vs {1:N0} bytes)" -f $size, $previous.Length)
}

foreach ($p in $problems) { Log "WARNING: $p" }

# ---- Land it ---------------------------------------------------------------
$final = Join-Path $BackupDir $name
Copy-Item $staging $final -Force
Log ("wrote {0} ({1:N0} bytes)" -f $final, (Get-Item $final).Length)

if (-not $NoMirror -and $MirrorDir) {
    try {
        if (-not (Test-Path $MirrorDir)) { New-Item -ItemType Directory -Force -Path $MirrorDir | Out-Null }
        Copy-Item $staging (Join-Path $MirrorDir $name) -Force
        Log "mirrored to $MirrorDir"
    } catch {
        Log "WARNING: mirror copy to $MirrorDir failed - $($_.Exception.Message)"
        Log "         the local copy is fine; only the off-machine copy is missing."
    }
} elseif (-not $NoMirror) {
    Log "WARNING: no mirror configured (set JOB_SEARCH_BACKUP_MIRROR) - this machine holds the only copy."
}

Remove-Item $staging -Force -ErrorAction SilentlyContinue

# ---- Documents (R2), which the .sql above does not contain. ----------------
#
# Fetched through the tracker API because `wrangler r2` cannot list a bucket and
# GET /api/documents can. A session sees only its own account, so this covers
# the accounts whose tracker.json is on this machine; the completeness check
# below reports any shortfall.
if (-not $NoDocuments) {
    $docRoot = Join-Path $BackupDir "documents\$stamp"
    $accounts = @()
    if (Test-Path $DataDir) {
        $accounts = Get-ChildItem $DataDir -Directory -ErrorAction SilentlyContinue |
                    Where-Object { Test-Path (Join-Path $_.FullName "tracker.json") }
    }

    if ($accounts.Count -eq 0) {
        Log "WARNING: no <user-id>\tracker.json under $DataDir - no document backup taken."
        Log "         Set -DataDir or JOB_SEARCH_DATA_DIR. See private.example/README.md."
        $problems += "no accounts found for the document backup"
    } else {
        # PS 5.1 draws a progress bar per web request, slow enough to dominate
        # a many-file pass.
        $oldProgress = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        $docTotal = 0; $docBytes = 0; $covered = 0

        foreach ($acct in $accounts) {
            $cfg = Get-Content (Join-Path $acct.FullName "tracker.json") -Raw | ConvertFrom-Json
            $headers = @{ Authorization = "Bearer $($cfg.token)" }
            try {
                $index = Invoke-RestMethod -Uri "$($cfg.url)/api/documents" -Headers $headers -ErrorAction Stop
            } catch {
                # 503 means no DOCS binding: documents are switched off, which
                # is supported and not a backup failure.
                $status = $null
                if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
                if ($status -eq 503) {
                    Log "documents are not configured on $($cfg.url) - skipping the document backup."
                    break
                }
                Log "WARNING: could not list documents for $($acct.Name) (HTTP $status) - $($_.Exception.Message)"
                $problems += "document listing failed for $($acct.Name)"
                continue
            }

            $covered++
            foreach ($doc in $index.documents) {
                # server/src/validate.js enforces this shape too; re-checked
                # because the path is joined onto a local directory and written.
                if ($doc.path -notmatch '^(docs|resumes|reference)/[\w][\w .-]*$') {
                    Log "WARNING: skipping unexpected document path for $($acct.Name): $($doc.path)"
                    $problems += "unexpected document path from the API"
                    continue
                }
                $dest = Join-Path $docRoot (Join-Path $acct.Name ($doc.path -replace '/', '\'))

                # Past MAX_PATH (260, without LongPathsEnabled) the write fails as
                # "Could not find a part of the path", which reads as a missing folder.
                if ($dest.Length -ge 260) {
                    Log ("WARNING: path too long for Windows ({0} chars, limit 260): {1}" -f $dest.Length, $dest)
                    Log "         Use a shorter -BackupDir, or enable long paths (LongPathsEnabled)."
                    $problems += "path over MAX_PATH: $($acct.Name)\$($doc.path)"
                    continue
                }

                $destDir = Split-Path $dest -Parent
                if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
                try {
                    # -UseBasicParsing: PS 5.1 otherwise parses with the IE engine, which prompts and throws under -NonInteractive.
                    Invoke-WebRequest -Uri "$($cfg.url)/api/documents/$($doc.path)" `
                        -Headers $headers -OutFile $dest -UseBasicParsing -ErrorAction Stop
                    $got = (Get-Item $dest).Length
                    # A truncated download looks like a real backup on disk, so
                    # compare with the size R2 reports.
                    if ($doc.bytes -and $got -ne $doc.bytes) {
                        Log ("WARNING: {0}\{1} came back {2:N0} bytes, expected {3:N0}" -f $acct.Name, $doc.path, $got, $doc.bytes)
                        $problems += "short download: $($acct.Name)\$($doc.path)"
                    }
                    $docTotal++; $docBytes += $got
                } catch {
                    Log "WARNING: failed to download $($acct.Name)\$($doc.path) - $($_.Exception.Message)"
                    $problems += "document download failed: $($acct.Name)\$($doc.path)"
                }
            }
        }
        $ProgressPreference = $oldProgress

        # Logged even at zero, so an empty bucket can't be mistaken for a pass
        # that never ran.
        if ($docTotal -gt 0) {
            Log ("documents: {0} file(s), {1:N0} bytes, from {2} account(s) -> {3}" -f $docTotal, $docBytes, $covered, $docRoot)
        } else {
            Log "documents: none - listed $covered account(s) and every one is empty."
        }

        # A shortfall is a NOTE, not a warning, because another machine may
        # hold the missing accounts' tracker.json.
        if ($expectedAccounts -gt 0 -and $covered -lt $expectedAccounts) {
            Log "NOTE: backed up documents for $covered of the $expectedAccounts account(s) that should have one."
            Log "      The rest have no tracker.json under $DataDir. If their documents matter,"
            Log "      run this where their folder lives, or copy their tracker.json here."
        }

        if (-not $NoMirror -and $MirrorDir -and $docTotal -gt 0) {
            try {
                $mirrorDocs = Join-Path $MirrorDir "documents\$stamp"
                Copy-Item $docRoot $mirrorDocs -Recurse -Force
                Log "documents mirrored to $mirrorDocs"
            } catch {
                Log "WARNING: mirroring documents to $MirrorDir failed - $($_.Exception.Message)"
                Log "         the local copy is fine; only the off-machine copy is missing."
            }
        }
    }
} else {
    Log "documents: skipped (-NoDocuments)"
}

# ---- Retention -------------------------------------------------------------
#
# The day a backup was taken, from its name: d1-<db>-yyyy-MM-dd-HHmmss.sql, or
# documents\yyyy-MM-dd-HHmmss. $null for anything else, which is never pruned -
# a file this script didn't name is not this script's to delete.
function Get-BackupDate([string]$Name) {
    $m = [regex]::Match($Name, '(\d{4}-\d{2}-\d{2})-\d{6}(\.sql)?$')
    if (-not $m.Success) { return $null }
    return [datetime]::ParseExact($m.Groups[1].Value, "yyyy-MM-dd", $null)
}

function Remove-ExpiredBackups([string]$Dir, [datetime]$Cutoff) {
    if (-not (Test-Path $Dir)) { return 0 }
    $removed = 0
    $expired = @(Get-ChildItem $Dir -Filter "*.sql" -File -ErrorAction SilentlyContinue)
    $docs = Join-Path $Dir "documents"
    if (Test-Path $docs) { $expired += @(Get-ChildItem $docs -Directory -ErrorAction SilentlyContinue) }
    foreach ($item in $expired) {
        $taken = Get-BackupDate $item.Name
        if (-not $taken -or $taken -ge $Cutoff) { continue }
        try {
            Remove-Item $item.FullName -Recurse -Force -ErrorAction Stop
            Log ("pruned {0} (taken {1:yyyy-MM-dd}, older than {2} days)" -f $item.FullName, $taken, $RetentionDays)
            $removed++
        } catch {
            Log "WARNING: could not prune $($item.FullName) - $($_.Exception.Message)"
        }
    }
    return $removed
}

if ($RetentionDays -gt 0 -and $problems.Count -eq 0) {
    $cutoff = (Get-Date).Date.AddDays(-$RetentionDays)
    $pruned = Remove-ExpiredBackups $BackupDir $cutoff
    if (-not $NoMirror -and $MirrorDir) { $pruned += Remove-ExpiredBackups $MirrorDir $cutoff }
    Log ("retention: kept backups taken on or after {0:yyyy-MM-dd}; pruned {1}" -f $cutoff, $pruned)
} elseif ($RetentionDays -gt 0) {
    Log "retention: skipped - this run has warnings, so nothing older is pruned until a clean run replaces it."
}

$kept = (Get-ChildItem $BackupDir -Filter "*.sql" -ErrorAction SilentlyContinue).Count
Log "$kept backup file(s) now in $BackupDir"

if ($problems.Count -gt 0) {
    Log "===== done, WITH WARNINGS ====="
    exit 2
}
Log "===== done ====="
exit 0
