<#
.SYNOPSIS
  Uploads a private data folder's documents - baseline docs, resumes, reference
  files - into the tracker, where the nightly runs read them from.

.DESCRIPTION
  Use it to load a data folder's documents on a new machine or after restoring a
  backup. Safe to re-run: a PUT to a fixed path overwrites rather than
  duplicates. A file the API would refuse, or whose extension has no known
  content type, is reported and skipped. Nothing is deleted, locally or in the
  tracker.

  Exit codes: 0 everything uploaded; 1 nothing could be attempted (no accounts,
  or the deployment has no document store); 2 finished with files skipped or
  failed - read the summary.

.PARAMETER DataDir
  The private data folder, one subfolder per account holding a tracker.json.
  Defaults to JOB_SEARCH_DATA_DIR, then <repo>\private.

.PARAMETER User
  Import only this account (a user id / folder name). Default is every account
  under -DataDir that has a tracker.json.

.PARAMETER WhatIf
  Print what would be uploaded, and upload nothing.

.EXAMPLE
  .\import-documents.ps1 -WhatIf
  .\import-documents.ps1 -DataDir C:\VibeCoding\job-search-tracker\private
  .\import-documents.ps1 -User ab266b6c-00cc-45d1-92ac-cdad412c1558
#>
param(
    [string]$DataDir = $(
        if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR }
        else { Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "private" }
    ),
    [string]$User,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # PS 5.1 renders a progress bar per request

# Kept in step with server/src/validate.js by hand; a mismatch surfaces as the
# API refusing a path.
$FOLDERS = @("docs", "resumes", "reference")

# A closed list: an unknown extension is refused rather than sent as
# application/octet-stream, which a browser downloads instead of displaying.
$CONTENT_TYPES = @{
    ".md"   = "text/markdown"
    ".txt"  = "text/plain"
    ".pdf"  = "application/pdf"
    ".docx" = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ".xlsx" = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

# Mirrors server/src/validate.js so a bad name is reported before a request is
# spent. A name must end in a word character because Windows drops a trailing
# space or dot, and DOS device names (CON, PRN.md) resolve to devices.
$NAME_OK     = "^\w([\w .-]*\w)?$"
$DOS_DEVICE  = "^(con|prn|aux|nul|com[0-9]|lpt[0-9])$"
$MAX_BYTES   = 8 * 1024 * 1024

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir or JOB_SEARCH_DATA_DIR. See private.example/README.md."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

$accounts = Get-ChildItem $DataDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName "tracker.json") }
if ($User) { $accounts = $accounts | Where-Object { $_.Name -eq $User } }

if (-not $accounts -or $accounts.Count -eq 0) {
    Write-Error "No account folders with a tracker.json under $DataDir$(if ($User) { " matching -User $User" }).`nSee private.example/README.md for the expected layout."
    exit 1
}

Write-Host "Importing from $DataDir"
Write-Host "$($accounts.Count) account(s)$(if ($WhatIf) { '  [WhatIf - nothing will be uploaded]' })"

$uploaded = 0; $skipped = 0; $failed = 0; $bytesSent = 0

foreach ($acct in $accounts) {
    $cfg = Get-Content (Join-Path $acct.FullName "tracker.json") -Raw | ConvertFrom-Json
    $url = $cfg.url.TrimEnd("/")
    $headers = @{ Authorization = "Bearer $($cfg.token)" }
    Write-Host ""
    Write-Host "== $($acct.Name) -> $url"

    # Checked once up front: a missing document store is one condition with one
    # fix, and a failure per file would bury it.
    try {
        $null = Invoke-RestMethod -Uri "$url/api/documents" -Headers $headers -ErrorAction Stop
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 503) {
            Write-Error "$url has no document store configured - enable R2 and redeploy. See server/README.md."
            exit 1
        }
        Write-Host "  ERROR: couldn't reach the document API (HTTP $status) - $($_.Exception.Message)"
        $failed++
        continue
    }

    foreach ($folder in $FOLDERS) {
        $dir = Join-Path $acct.FullName $folder
        if (-not (Test-Path $dir)) { continue }

        # The API stores one folder deep; nested folders are skipped rather than
        # flattened into colliding keys.
        foreach ($nested in (Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue)) {
            Write-Host "  SKIP  $folder/$($nested.Name)/ - nested folders are not stored (one level only)"
            $skipped++
        }

        foreach ($file in (Get-ChildItem $dir -File -ErrorAction SilentlyContinue)) {
            $rel  = "$folder/$($file.Name)"
            $ext  = $file.Extension.ToLowerInvariant()
            $stem = $file.BaseName.Split(".")[0]

            if (-not ($file.Name -match $NAME_OK)) {
                Write-Host "  SKIP  $rel - the API will not store this name (must start and end with a letter or digit)"
                $skipped++; continue
            }
            if ($stem -match $DOS_DEVICE) {
                Write-Host "  SKIP  $rel - reserved Windows device name"
                $skipped++; continue
            }
            if (-not $CONTENT_TYPES.ContainsKey($ext)) {
                Write-Host "  SKIP  $rel - no content type for '$ext' (known: $($CONTENT_TYPES.Keys -join ', '))"
                $skipped++; continue
            }
            if ($file.Length -gt $MAX_BYTES) {
                Write-Host ("  SKIP  {0} - {1:N0} bytes, over the {2:N0} limit" -f $rel, $file.Length, $MAX_BYTES)
                $skipped++; continue
            }
            if ($file.Length -eq 0) {
                # Uploaded, since the folder is the source of truth, but warned
                # about because an empty resume looks like a present one.
                Write-Host "  WARN  $rel is empty (0 bytes)"
            }

            if ($WhatIf) {
                Write-Host ("  would upload {0,-46} {1,9:N0} bytes  {2}" -f $rel, $file.Length, $CONTENT_TYPES[$ext])
                $uploaded++; $bytesSent += $file.Length
                continue
            }

            try {
                $body = [System.IO.File]::ReadAllBytes($file.FullName)
                # -UseBasicParsing: PS 5.1 otherwise parses with the IE engine,
                # which prompts and throws when nobody is there to answer.
                $r = Invoke-WebRequest -Uri "$url/api/documents/$rel" -Method Put `
                        -Headers $headers -Body $body -ContentType $CONTENT_TYPES[$ext] `
                        -UseBasicParsing -ErrorAction Stop
                $reported = ($r.Content | ConvertFrom-Json).bytes
                if ($reported -ne $file.Length) {
                    Write-Host ("  WARN  {0} - stored {1:N0} bytes, sent {2:N0}" -f $rel, $reported, $file.Length)
                }
                Write-Host ("  ok    {0,-46} {1,9:N0} bytes" -f $rel, $file.Length)
                $uploaded++; $bytesSent += $file.Length
            } catch {
                $status = $null
                if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
                Write-Host "  FAIL  $rel (HTTP $status) - $($_.Exception.Message)"
                $failed++
            }
        }
    }

    # Notes documents a track names that aren't uploaded. `doc_file` and
    # `resume_line` are prose, so only backticked paths are checked.
    if (-not $WhatIf) {
        try {
            $cfgNow  = Invoke-RestMethod -Uri "$url/api/config" -Headers $headers -ErrorAction Stop
            $present = @((Invoke-RestMethod -Uri "$url/api/documents" -Headers $headers).documents | ForEach-Object { $_.path })
            foreach ($t in $cfgNow.tracks) {
                if ($t.fed_by) { continue }   # a tab, not a search - it opens nothing itself
                $named = ([regex]::Matches("$($t.doc_file) $($t.resume_line)", '`([^`]+)`') |
                          ForEach-Object { $_.Groups[1].Value }) |
                         Where-Object { $_ -match "^($($FOLDERS -join '|'))/" }
                $missing = @($named | Where-Object { $present -notcontains $_ })
                if ($missing.Count -gt 0) {
                    Write-Host "  NOTE  track '$($t.key)' names $($missing -join ', '), which is not in the tracker"
                }
            }
        } catch {
            Write-Host "  NOTE  couldn't cross-check track config against what was uploaded - $($_.Exception.Message)"
        }
    }
}

Write-Host ""
Write-Host ("{0} uploaded ({1:N0} bytes), {2} skipped, {3} failed" -f $uploaded, $bytesSent, $skipped, $failed)
if ($WhatIf) { Write-Host "(WhatIf - nothing was actually uploaded)" }

if ($failed -gt 0 -or $skipped -gt 0) { exit 2 }
exit 0
