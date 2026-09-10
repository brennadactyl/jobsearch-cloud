<#
.SYNOPSIS
  Exports the entire tracker database to a timestamped .sql file, downloads
  every document from R2 beside it, and copies both to an off-machine mirror.

.DESCRIPTION
  Generic script - contains no personal data. Runs `wrangler d1 export` against
  the deployed database and writes one dated file per run, then fetches the
  documents (resumes, each track's baseline doc) that live in R2 and which that
  export does not contain.

  This is the whole of the off-account recovery story. Cloudflare's own
  protection for D1 is Time Travel, which is point-in-time recovery *inside*
  the account - it restores a database that still exists. It cannot help with
  `wrangler d1 delete`, which takes the database and its Time Travel history in
  one step, and it cannot help if the account itself goes away. A file on this
  machine is the only copy that survives either.

  Three deliberate details:

  - **Staged, then copied in.** The export goes to a temp file first and is
    validated before it lands in the backup folder. A half-written or empty
    export that reached the archive would sit there looking like a backup; the
    archive is append-only by design (see protect-backups.ps1), so a bad file
    could not be removed afterwards.

  - **Validated, not just written.** `wrangler d1 export` can exit 0 having
    produced something useless. The checks below are for the failure mode that
    actually matters: a backup that exists, is the right shape, and is empty.

  - **Nothing is ever deleted.** No retention pruning, on purpose. At roughly
    half a megabyte a day this costs well under a gigabyte a year, which is not
    worth the risk of a script that deletes backups on a schedule. Pruning old
    files is a human decision, made with elevation - see protect-backups.ps1.

  Exit codes: 0 wrote and validated; 1 the export itself failed, nothing
  written; 2 wrote the file but a validity check failed - look at the log.
  Task Scheduler surfaces the code as "Last Run Result", which is the only
  signal anyone sees without opening the log.

  A document problem is a 2, never a 1: by the time that pass runs the .sql has
  already landed, and reporting "nothing was written" over a failed resume
  download would be a lie about the artifact that matters most.

.PARAMETER RepoDir
  The repository root - used to find server\wrangler.toml (for the database
  name) and the default backup folder. Defaults to the parent of this script.

.PARAMETER BackupDir
  Where dated exports are written. Defaults to <RepoDir>\private\backups.
  Documents land beside them under <BackupDir>\documents\<timestamp>\<user-id>\.

.PARAMETER DataDir
  The private data folder, used only to find each person's tracker.json - the
  credential the document download authenticates with. Same default as the other
  scripts: JOB_SEARCH_DATA_DIR, else <RepoDir>\private.

.PARAMETER NoDocuments
  Skip the R2 document download. The .sql export still happens.

.PARAMETER MirrorDir
  A second copy, meant to be somewhere this machine's filesystem isn't the last
  word - a synced folder, an external drive. Defaults to the
  JOB_SEARCH_BACKUP_MIRROR environment variable, then to a folder in OneDrive.
  A mirror that can't be written is a warning, not a failure: the local copy
  still happened.

.PARAMETER NoMirror
  Skip the off-machine copy entirely.

.PARAMETER MinBytes
  Refuse to call an export healthy below this size. Defaults to 10 KB - large
  enough to catch an empty or truncated file, small enough not to trip on a
  brand-new install with almost no rows.

.EXAMPLE
  .\backup-tracker.ps1
  .\backup-tracker.ps1 -NoMirror -BackupDir D:\Backups
#>
param(
    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$BackupDir,
    [string]$DataDir = $(
        if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR }
        else { Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "private" }
    ),
    [string]$MirrorDir = $(
        if ($env:JOB_SEARCH_BACKUP_MIRROR) { $env:JOB_SEARCH_BACKUP_MIRROR }
        elseif ($env:OneDrive) { Join-Path $env:OneDrive "JobSearchTracker\backups" }
        else { "" }
    ),
    [switch]$NoMirror,
    [switch]$NoDocuments,
    [int]$MinBytes = 10240
)

$ErrorActionPreference = "Stop"

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

# The database name lives in wrangler.toml, not here - one definition, and a
# renamed database doesn't silently start backing up nothing.
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

# The export endpoint is genuinely flaky - it returned "A request to the
# Cloudflare API failed" once and succeeded on the next call seconds later, with
# nothing changed. One retry, because an unattended nightly job that gives up on
# a transient 500 is a backup that quietly stops existing.
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
# One INSERT per row in a d1 export, so this is a straight count of accounts.
# Used further down to tell whether the document pass covered everybody.
$userCount = ([regex]::Matches($text, '(?im)^\s*INSERT INTO\s+"?users"?\s')).Count
Log ("staged: {0:N0} bytes, {1} CREATE TABLE, {2} INSERT INTO, {3} account(s)" -f $size, $tables, $inserts, $userCount)

$problems = @()
if ($size -lt $MinBytes) { $problems += "only $size bytes (under the $MinBytes floor)" }
if ($tables -lt 1)       { $problems += "no CREATE TABLE statements" }
if ($inserts -lt 1)      { $problems += "no INSERT statements - the schema came back but no data" }

# An export that succeeds but returns far less than last time is the quiet
# failure this is really watching for: a partial dump reads as a valid file.
$previous = Get-ChildItem $BackupDir -Filter "*.sql" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($previous -and $size -lt ($previous.Length * 0.5)) {
    $problems += ("less than half the size of the previous backup ({0:N0} vs {1:N0} bytes)" -f $size, $previous.Length)
}

foreach ($p in $problems) { Log "WARNING: $p" }

# ---- Land it. The local copy first; the mirror is best-effort. -------------
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
# `wrangler d1 export` covers D1 and nothing else, so resumes and each track's
# baseline doc - the things that used to live in this folder and now live in the
# DOCS bucket - have no backup at all without this pass. That is a worse hole
# than the one this script was written for: a lead can be found again, a resume
# and eight weeks of accumulated fetch-reliability notes cannot.
#
# Fetched through the tracker API rather than from R2 directly, because
# `wrangler r2` has get/put/delete but no way to *list* a bucket - it can fetch
# an object whose key you already know, and nothing here knows the keys. The API
# does: GET /api/documents is the listing, and every session already scopes
# itself to one person.
#
# The consequence is that this backs up the accounts whose credentials are on
# this machine, which is not necessarily every account in the database. That
# gap is checked rather than assumed - see the count against $userCount below -
# because a backup that silently covers two people out of three is the failure
# mode this whole script exists to refuse.
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
        # Invoke-WebRequest renders a progress bar per call in PS 5.1 and it is
        # slow enough to dominate the runtime of a many-file pass.
        $oldProgress = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        $docTotal = 0; $docBytes = 0; $covered = 0

        foreach ($acct in $accounts) {
            $cfg = Get-Content (Join-Path $acct.FullName "tracker.json") -Raw | ConvertFrom-Json
            $headers = @{ Authorization = "Bearer $($cfg.token)" }
            try {
                $index = Invoke-RestMethod -Uri "$($cfg.url)/api/documents" -Headers $headers -ErrorAction Stop
            } catch {
                # 503 is this deployment saying documents are switched off (no
                # DOCS binding), which is a supported configuration and not a
                # backup failure. Anything else is.
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
                # The API's own path rule is <folder>/<filename>, one deep, with
                # no traversal (server/src/validate.js) - so joining it onto a
                # local directory is safe. Re-checked here anyway: this writes to
                # a real filesystem, and a backup script is a bad place to learn
                # that the server's validator regressed.
                if ($doc.path -notmatch '^(docs|resumes|reference)/[\w][\w .-]*$') {
                    Log "WARNING: skipping unexpected document path for $($acct.Name): $($doc.path)"
                    $problems += "unexpected document path from the API"
                    continue
                }
                $dest = Join-Path $docRoot (Join-Path $acct.Name ($doc.path -replace '/', '\'))

                # MAX_PATH, checked here so it reports itself. This layout adds
                # ~90 characters to -BackupDir (a timestamp, a 36-character user
                # id, a folder and a filename), and Windows still caps a path at
                # 260 unless LongPathsEnabled is set. Left to fail on its own it
                # surfaces as "Could not find a part of the path", which reads as
                # a missing directory and sends you looking in the wrong place.
                if ($dest.Length -ge 260) {
                    Log ("WARNING: path too long for Windows ({0} chars, limit 260): {1}" -f $dest.Length, $dest)
                    Log "         Use a shorter -BackupDir, or enable long paths (LongPathsEnabled)."
                    $problems += "path over MAX_PATH: $($acct.Name)\$($doc.path)"
                    continue
                }

                $destDir = Split-Path $dest -Parent
                if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
                try {
                    Invoke-WebRequest -Uri "$($cfg.url)/api/documents/$($doc.path)" `
                        -Headers $headers -OutFile $dest -ErrorAction Stop
                    $got = (Get-Item $dest).Length
                    # The index reports the size R2 holds. A short file here means
                    # a truncated download, which on disk looks like a real backup.
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

        # Logged even when the count is zero. An empty bucket and a pass that
        # never ran look identical in a log that only reports files, and this
        # script's whole purpose is refusing to let "no backup" resemble
        # "nothing to back up".
        if ($docTotal -gt 0) {
            Log ("documents: {0} file(s), {1:N0} bytes, from {2} account(s) -> {3}" -f $docTotal, $docBytes, $covered, $docRoot)
        } else {
            Log "documents: none - listed $covered account(s) and every one is empty."
        }

        # The completeness check. $userCount is every account in the database;
        # $covered is the ones this machine held a credential for. A shortfall is
        # not an error - the demo account has no folder by design, and a second
        # machine may hold the rest - but it has to be said out loud, because the
        # alternative is a backup folder that looks complete and isn't.
        if ($userCount -gt 0 -and $covered -lt $userCount) {
            Log "NOTE: backed up documents for $covered of the $userCount account(s) in the database."
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

$kept = (Get-ChildItem $BackupDir -Filter "*.sql" -ErrorAction SilentlyContinue).Count
Log "$kept backup file(s) now in $BackupDir"

if ($problems.Count -gt 0) {
    Log "===== done, WITH WARNINGS ====="
    exit 2
}
Log "===== done ====="
exit 0
