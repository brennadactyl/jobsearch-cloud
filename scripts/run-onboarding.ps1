<#
.SYNOPSIS
  Builds a search for everyone who asked for one on the tracker page - one run
  for the whole machine, nightly, before the night's searches.

.DESCRIPTION
  The last step of self-service onboarding, and the one nobody watches. Someone
  opens an invite link, creates their own account and fills in the setup form
  (docs/onboarding.md). This turns their answers into a working daily
  search: their folder, their credential, their config, their track docs and
  their scheduled tasks.

  ---- What is mechanical, and what is not.

  Everything that either works or throws happens here: minting each person's
  search token, writing tracker.json, downloading their resume, picking a
  schedule slot nothing else on this machine uses, posting the config, and
  registering the tasks.

  What goes to a model is the part that needs judgement - reading a resume,
  turning "senior backend, Seattle or remote" into the prose the daily prompt
  reads verbatim, writing the track doc. That turn runs confined: a staged
  folder holding the person's answers, their readable resume and the doc
  template, with tools that can only read and write inside it. It gets no
  token, no shell and no network, and what it writes is data this script
  validates before any of it reaches the tracker. A model that writes nonsense
  costs the person a night; it cannot write to their account.

  ---- Done and failed are read from the tracker, not from the model.

  A person is done when the tracker says their tracks and their docs exist and
  this machine has their tasks. Anyone still pending when their turn ends is
  marked failed with a note written for them, so their own page stops saying
  their tracker is being built and says what happened instead. A failed setup
  stays in the queue, so the next night tries again - and when it needs a
  person (a resume nothing headless can read), the note says who to ask.

  Logs to <DataDir>\logs\onboarding.log - the machine's log, like the
  applications fill, because this run is nobody's in particular either.

.PARAMETER DataDir
  The private data folder, one folder per person. Defaults to
  JOB_SEARCH_DATA_DIR, then a "private" folder beside this repo.

.PARAMETER User
  Build only this account id, of those waiting. For running it by hand; the
  scheduled task passes none.

.PARAMETER WhatIfOnly
  Print who is waiting and the slots they would get, then stop. Nothing is
  minted, written or posted. Not -WhatIf: that name is PowerShell's own and
  behaves differently.

.EXAMPLE
  .\run-onboarding.ps1
  .\run-onboarding.ps1 -WhatIfOnly
  .\run-onboarding.ps1 -User f6d1e62d-e325-4c52-908a-91bb5850c776
#>
param(
    [string]$DataDir,

    [string]$User,

    [switch]$WhatIfOnly
)

$ErrorActionPreference = "Stop"

# A param default is evaluated before $PSScriptRoot is reliably set, so the
# script's own folder is resolved here instead. It also names the scheduler this
# run calls, which becomes a registered task's command line, so an empty path
# would schedule nothing runnable.
# The same three lines resolve the script folder in every scripts/*.ps1 that needs it; change them together.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
             else { "" }
if (-not $scriptDir) {
    throw "Can't work out where this script lives, so it can't find setup-scheduler.ps1. Run it by its full path."
}
if (-not $DataDir) {
    $DataDir = if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $scriptDir "..\private" }
}

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir, or the JOB_SEARCH_DATA_DIR environment variable, to your private job-search data folder."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

# This run stages a folder per person at
# <DataDir>\<36-char id>\.onboarding\out\docs\tracked_<key>_postings.md, which
# is about 125 characters past the data dir. Past Windows' 260-character limit
# the model turn still writes the file - Node is long-path aware - and
# PowerShell then cannot see it, so the run reports a doc the model wrote as
# missing. Refused up front, where the fix is one short path.
if ($DataDir.Length -gt 120) {
    Write-Error "Data dir path is too long ($($DataDir.Length) characters): $DataDir`nA setup stages files about 125 characters deeper, past Windows' 260-character limit. Use a shorter folder."
    exit 1
}

$logDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "onboarding.log"

# -Encoding utf8 on every writer to this log, for the reason run-search.ps1
# gives: 5.1's Out-File defaults to UTF-16LE, and a log written in two encodings
# reads as binary and decodes to a stale tail.
function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

function Write-Utf8($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

Log "===== starting onboarding run ====="
Log "data dir:         $DataDir"

# ---- Credentials. ----------------------------------------------------------
#
# The URL and the admin token are read from one file, together. Taking them from
# different places is how an operator credential gets aimed at the wrong
# deployment, and the error that produces ("check it matches ADMIN_TOKEN")
# describes neither of them.
$deployFile = Join-Path $DataDir "deployment.json"
if (-not (Test-Path $deployFile)) {
    Log "ERROR: no $deployFile - this run reads the setup queue, which is admin-only"
    Write-Error @"
No $deployFile. This run reads the setup queue, which spans every account and so
needs the deployment's ADMIN_TOKEN:

  { "url": "https://<your worker>", "admin_token": "<the ADMIN_TOKEN secret>" }

That file lives in your private data folder, which is never committed.
"@
    exit 1
}
try {
    $deployment = Get-Content -Raw -Path $deployFile | ConvertFrom-Json
} catch {
    Log "ERROR: $deployFile is not valid JSON"
    Write-Error "$deployFile is not valid JSON."
    exit 1
}
$TrackerUrl = [string]$deployment.url
$AdminToken = [string]$deployment.admin_token
if (-not $TrackerUrl -or -not $AdminToken) {
    Log "ERROR: $deployFile needs both a url and an admin_token"
    Write-Error "$deployFile needs both a `"url`" and an `"admin_token`"."
    exit 1
}
$TrackerUrl = $TrackerUrl.TrimEnd("/")
Log "tracker:          $TrackerUrl"

# Cloudflare refuses some default agents with a 403 whose body is
# `error code: 1010`, which looks exactly like a refused token. Unattended,
# that is a misdiagnosis nobody is there to correct.
$API_USER_AGENT = "job-search-onboarding"

$RetryAttempts = 4
$RetryBackoff = @(2, 5, 12)

function Get-HttpStatus($err) {
    $resp = $err.Exception.Response
    if (-not $resp) { return 0 }
    try { return [int]$resp.StatusCode } catch { return 0 }
}

function Test-Transient($status) {
    if ($status -eq 503) { return $false }
    return ($status -eq 0 -or $status -eq 429 -or $status -ge 500)
}

function Invoke-WithRetry($what, $action) {
    for ($attempt = 1; ; $attempt++) {
        try {
            return & $action
        } catch {
            $status = Get-HttpStatus $_
            if ($attempt -ge $RetryAttempts -or -not (Test-Transient $status)) { throw }
            $wait = $RetryBackoff[[Math]::Min($attempt - 1, $RetryBackoff.Count - 1)]
            Log "transient failure on $what ($status) - retrying in ${wait}s (attempt $attempt of $RetryAttempts)"
            Start-Sleep -Seconds $wait
        }
    }
}

# $Token is who the call is: the admin token for the queue, the tokens route and
# the completion; the person's own for everything that writes their data.
function Api($Method, $Path, $Token, $Body) {
    Invoke-WithRetry "$Method $Path" {
        $req = @{ Uri = "$TrackerUrl$Path"; Method = $Method; TimeoutSec = 60
                  Headers = @{ Authorization = "Bearer $Token" }
                  UserAgent = $API_USER_AGENT; ErrorAction = "Stop" }
        if ($null -ne $Body) {
            $req.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
            $req.ContentType = "application/json; charset=utf-8"
        }
        Invoke-RestMethod @req
    }
}

# ---- The queue. ------------------------------------------------------------
try {
    $queue = @((Api GET "/api/intake/pending" $AdminToken $null).intakes)
} catch {
    $status = Get-HttpStatus $_
    $hint = if ($status -eq 401) { "the admin token was refused - check it matches the ADMIN_TOKEN secret on the worker" }
            elseif ($status -eq 404) { "this deployment has no setup routes yet - deploy server/ first" }
            else { $_.Exception.Message }
    Log "ERROR: couldn't read the setup queue ($status): $hint"
    Write-Error "Couldn't read the setup queue ($status): $hint"
    exit 1
}

if ($User) { $queue = @($queue | Where-Object { $_.user.id -eq $User }) }

if ($queue.Count -eq 0) {
    # The ordinary result on almost every night: a machine where nobody new
    # signed up is not a machine with a problem.
    Log "nobody waiting - nothing to do"
    Log "===== done ====="
    exit 0
}
Log "waiting:          $($queue.Count) ($(($queue | ForEach-Object { $_.user.name }) -join ', '))"

# ---- A slot in the night. --------------------------------------------------
#
# Every search on this machine shares one CLI and one Claude account, so two at
# once is two fighting. The rule is arithmetic, and it lives here rather than in
# the model's turn: a model asked to pick a free time has to be told every time
# already taken anyway.
#
# The night is bounded by this run (00:00, up to two hours) and the application
# fill (06:30). Inside it a new search goes 45 minutes after the latest one
# already scheduled, on the quarter hour, and never within 45 minutes of the
# 03:15 backup or of anyone else's run. Past 05:45 there is no room, and the
# person is told that rather than given a slot that collides.
$NIGHT_FIRST = 60      # 01:00, after this run's own two-hour window
$NIGHT_LAST = 345      # 05:45, clear of the fill
$SPACING = 45
$GRID = 15
$BACKUP_AT = 195       # 03:15, scripts/backup-tracker.ps1
$FILL_AT = 390         # 06:30, scripts/run-fill.ps1

function ConvertTo-Minutes([string]$t) {
    if ($t -match '^(\d{1,2}):(\d{2})$') { return [int]$Matches[1] * 60 + [int]$Matches[2] }
    return -1
}

function ConvertTo-Clock([int]$m) {
    "{0:00}:{1:00}" -f [math]::Floor($m / 60), ($m % 60)
}

function Get-NightSlot([int[]]$taken) {
    $night = @($taken | Where-Object { $_ -ge 0 -and $_ -lt $FILL_AT })
    $candidate = $NIGHT_FIRST
    foreach ($t in $night) { if ($t + $SPACING -gt $candidate) { $candidate = $t + $SPACING } }
    if ($candidate % $GRID) { $candidate += $GRID - ($candidate % $GRID) }
    while ($candidate -le $NIGHT_LAST) {
        $clear = $true
        if ([Math]::Abs($candidate - $BACKUP_AT) -lt $SPACING) { $clear = $false }
        foreach ($t in $night) { if ([Math]::Abs($candidate - $t) -lt $SPACING) { $clear = $false } }
        if ($clear) { return $candidate }
        $candidate += $GRID
    }
    return -1
}

# What is already scheduled, asked of each account rather than of Task
# Scheduler: the config is what setup-scheduler.ps1 registers from, so it is the
# list that decides collisions. Anyone in tonight's queue is left out - a retry
# re-picks their slots from scratch.
$waiting = @($queue | ForEach-Object { $_.user.id })
$taken = @()
foreach ($dir in (Get-ChildItem $DataDir -Directory | Sort-Object Name)) {
    if ($waiting -contains $dir.Name) { continue }
    $trackerFile = Join-Path $dir.FullName "tracker.json"
    if (-not (Test-Path $trackerFile)) { continue }
    try {
        $t = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
        $cfg = Api GET "/api/config" $t.token $null
        foreach ($track in $cfg.tracks) {
            $m = ConvertTo-Minutes ([string]$track.schedule_time)
            if ($m -ge 0) { $taken += $m }
        }
    } catch {
        # Nothing here can proceed on a guess: an unreadable config is a set of
        # run times this run cannot see, and a slot handed out on top of one of
        # them breaks a search that already works.
        Log "ERROR: couldn't read $($dir.Name)'s schedule - $($_.Exception.Message)"
        Write-Error "Couldn't read $($dir.Name)'s schedule, so a free slot can't be worked out. Nothing was built."
        exit 1
    }
}
$taken = @($taken | Sort-Object -Unique)
Log "slots in use:     $(if ($taken.Count) { ($taken | ForEach-Object { ConvertTo-Clock $_ }) -join ', ' } else { '(none)' })"

if ($WhatIfOnly) {
    $preview = @($taken)
    foreach ($item in $queue) {
        $roles = @($item.answers.roles)
        $slots = @()
        foreach ($role in $roles) {
            $slot = Get-NightSlot $preview
            if ($slot -lt 0) { $slots += "(no room left)"; continue }
            $preview += $slot
            $slots += (ConvertTo-Clock $slot)
        }
        Log "--- $($item.user.name) ($($item.user.id)) - $($item.status), sent $($item.sent_at)"
        Log "      roles: $(($roles | ForEach-Object { $_.name }) -join ', ')"
        Log "      slots: $($slots -join ', ')"
    }
    Log "-WhatIfOnly: nothing was minted, written or posted"
    Log "===== done ====="
    Write-Host "Would build $($queue.Count) setup(s). See $logFile."
    exit 0
}

# ---- What the model turn needs. --------------------------------------------
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    $fallback = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $fallback) { $claude = $fallback } else {
        Log "ERROR: the claude CLI is not on PATH or at $fallback - nothing was built"
        Write-Error "claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
        exit 1
    }
}
$claudePath = if ($claude -is [System.Management.Automation.CommandInfo]) { $claude.Source } else { $claude }

# Pointed at rather than copied: a second copy of the setup procedure in a
# here-string would drift from the skill, and the run would build configs in a
# shape the code has moved on from.
$skillDir = if ($env:CLAUDE_PLUGIN_ROOT) {
    Join-Path $env:CLAUDE_PLUGIN_ROOT ".claude\skills\job-search-setup"
} else {
    Join-Path (Split-Path -Parent $scriptDir) ".claude\skills\job-search-setup"
}
$skillFile = Join-Path $skillDir "SKILL.md"
$templateFile = Join-Path $skillDir "templates\tracked-postings.template.md"
foreach ($f in @($skillFile, $templateFile)) {
    if (-not (Test-Path $f)) {
        Log "ERROR: setup instructions not found at $f"
        Write-Error "Couldn't find $f. This run reads the job-search-setup skill from the checkout it lives in."
        exit 1
    }
}
Log "skill:            $skillDir"
Log "claude CLI:       $claudePath"
Log "CLAUDE_CODE_OAUTH_TOKEN set: $([bool]$env:CLAUDE_CODE_OAUTH_TOKEN)"

# One person's turn. Long enough for several roles and a resume; short enough
# that one stuck turn doesn't eat the night's other setups or the 2-hour task
# limit.
$MODEL_TIMEOUT_MINUTES = 25

# Every note below is read by the person on their own page, so each says what
# they can do, and never what a run was doing when it broke.
$NOTE_GENERIC = "Setting your search up didn't finish tonight. It will be tried again tomorrow night, and there's nothing you need to do unless this message is still here after that."
$NOTE_RESUME = "Your resume couldn't be read overnight, so your search wasn't built yet. A Word, RTF or Pages file, or a picture of a resume, can't be opened with nobody there - a PDF or a .txt can. Ask whoever invited you to help get a readable copy in."
$NOTE_NO_SCOPE = "Your setup doesn't say where you can work, so there was nowhere for your search to look and it wasn't built yet. Ask whoever invited you to help fill that in."
$NOTE_NO_SLOT = "There's no room left in the nightly schedule on the machine that runs these searches, so yours couldn't be added. Let whoever invited you know - this one needs their attention, not yours."

# "Jordan O'Neil" -> "Jordan-O-Neil". The documents route takes word characters,
# spaces, dots and hyphens, and refuses a name that doesn't start and end with
# one of them (server/src/validate.js).
function Get-SafeName([string]$name) {
    $safe = ($name -replace '[^A-Za-z0-9]+', '-').Trim('-')
    if (-not $safe) { $safe = "Resume" }
    return $safe
}

function Get-DocumentPaths($token) {
    $listing = Api GET "/api/documents" $token $null
    return @($listing.documents | ForEach-Object { [string]$_.path })
}

$KEY_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$'
# Only these reach the config. A model that invents a field, or fills in one
# this script owns (schedule_time, target_companies, fed_by), has it dropped
# rather than posted.
$MODEL_TRACK_FIELDS = @(
    "full_description", "role_search_line", "search_note", "resume_line",
    "fit_clause", "fit_disqualifier", "fit_filter_step", "intro_note", "doc_summary"
)
$MODEL_SETTING_FIELDS = @("geo_scope_line", "scope_clause", "scope_disqualifier")

# The distinctive words of a free-text answer about places, for checking that
# what came back was written from the answer it was supposed to be written from.
# Four letters and up: "US", "or" and "to" are in every sentence, and "WA" is in
# none of the prose that matters.
function Get-PlaceWords([string]$text) {
    return @(($text -split '[^A-Za-z]+') | Where-Object { $_.Length -ge 4 } | ForEach-Object { $_.ToLower() } | Sort-Object -Unique)
}

function Test-MentionsAny([string]$haystack, [string[]]$words) {
    $lower = $haystack.ToLower()
    foreach ($w in $words) { if ($lower.Contains($w)) { return $true } }
    return $false
}

# ---- Build each person. ----------------------------------------------------
$built = @()
$exitCode = 0

foreach ($item in $queue) {
    $id = [string]$item.user.id
    $name = [string]$item.user.name
    $answers = $item.answers
    $roles = @($answers.roles)
    $personNote = $NOTE_GENERIC
    $done = $false

    Log "--- $name ($id) - $($item.status), sent $($item.sent_at), $($roles.Count) role(s)"

    # Sets the note this person sees before giving up on them. A note is only
    # worth writing where it tells them something they can act on; everything
    # else keeps the generic one.
    function Stop-Person($reason, $note) {
        if ($note) { $script:personNote = $note }
        throw $reason
    }

    try {
        $userDir = Join-Path $DataDir $id
        New-Item -ItemType Directory -Force -Path $userDir | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $userDir "logs") | Out-Null

        # ---- Their credential.
        #
        # POST /api/tokens kills the account's previous search token, so
        # tracker.json is written from the response before anything else runs.
        # A crash between the two leaves a folder whose credential is dead, and
        # nothing on the tracker says so.
        $trackerFile = Join-Path $userDir "tracker.json"
        $personToken = ""
        if (Test-Path $trackerFile) {
            try {
                $stored = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
                if ([string]$stored.url -eq $TrackerUrl -and $stored.token) {
                    $me = Api GET "/api/me" ([string]$stored.token) $null
                    if ([string]$me.id -eq $id) {
                        $personToken = [string]$stored.token
                        Log "      tracker.json already holds a working token - reusing it"
                    }
                }
            } catch {
                Log "      the token in tracker.json doesn't work any more - minting a new one"
            }
        }
        if (-not $personToken) {
            $minted = Api POST "/api/tokens" $AdminToken @{ user = $id }
            Write-Utf8 $trackerFile ((@{ url = $TrackerUrl; token = $minted.token } | ConvertTo-Json))
            $personToken = [string]$minted.token
            Log "      minted a search token (replaced $($minted.replaced)) and wrote tracker.json"
        }

        # ---- The tracks, which already exist.
        #
        # Sending the form built them - their keys, labels and order - and this
        # run writes the prose into them and nothing else
        # (docs/onboarding.md#why-it-is-split-this-way). The keys are the account's, never the
        # model's to invent: a key this run made up would leave the tab the
        # person is looking at empty forever.
        $liveTracks = @((Api GET "/api/config" $personToken $null).tracks |
            Where-Object { -not $_.fed_by } | Sort-Object sort_order)
        if ($liveTracks.Count -eq 0) {
            Stop-Person "their account has no tracks to write up" $null
        }
        Log "      tracks to write up: $(($liveTracks | ForEach-Object { $_.key }) -join ', ')"

        # ---- Their slots.
        #
        # One per track, and a refusal here costs nothing: the tracker they can
        # already see keeps working, it just has no run behind it yet.
        $slots = @()
        foreach ($track in $liveTracks) {
            $slot = Get-NightSlot $taken
            if ($slot -lt 0) { Stop-Person "no free schedule slot left on this machine" $NOTE_NO_SLOT }
            $taken += $slot
            $slots += $slot
        }
        Log "      slots: $(($slots | ForEach-Object { ConvertTo-Clock $_ }) -join ', ')"

        # ---- The staged folder the model turn sees, and nothing else.
        $stage = Join-Path $userDir ".onboarding"
        if (Test-Path $stage) { Remove-Item -Recurse -Force -Path $stage }
        New-Item -ItemType Directory -Force -Path (Join-Path $stage "resumes") | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $stage "out\docs") | Out-Null

        # Only the formats the model turn can read are staged. A PDF is one of
        # them: the confined turn's Read tool opens a staged PDF and reads the
        # text out of it. A .docx, .rtf,
        # .pages or an image is left in the tracker, because staging one puts a
        # file in front of the model it cannot read, and the search it then
        # writes comes from the answers alone, silently.
        $readable = @()
        foreach ($path in @($answers.resume_files)) {
            $path = [string]$path
            if ($path -notmatch '\.(txt|md|pdf)$') { continue }
            $dest = Join-Path $stage ("resumes\" + [System.IO.Path]::GetFileName($path))
            Invoke-WithRetry "GET /api/documents/$path" {
                Invoke-WebRequest -Uri "$TrackerUrl/api/documents/$path" -OutFile $dest `
                    -Headers @{ Authorization = "Bearer $personToken" } -UserAgent $API_USER_AGENT `
                    -TimeoutSec 60 -UseBasicParsing -ErrorAction Stop
            } | Out-Null
            $readable += $path
        }

        $resumeText = [string]$answers.resume_text
        if ($resumeText.Trim()) {
            # Uploaded as well as staged: the nightly run reads the resume from
            # the tracker, like every other document, and `resume_line` names
            # this path.
            $resumeName = (Get-SafeName $name) + "_Resume.txt"
            $resumePath = "resumes/$resumeName"
            Write-Utf8 (Join-Path $stage "resumes\$resumeName") $resumeText
            Invoke-WithRetry "PUT /api/documents/$resumePath" {
                Invoke-WebRequest -Uri "$TrackerUrl/api/documents/$resumePath" -Method Put `
                    -Headers @{ Authorization = "Bearer $personToken" } -UserAgent $API_USER_AGENT `
                    -ContentType "text/plain; charset=utf-8" `
                    -Body ([System.Text.Encoding]::UTF8.GetBytes($resumeText)) `
                    -TimeoutSec 60 -UseBasicParsing -ErrorAction Stop
            } | Out-Null
            Log "      wrote their pasted resume to $resumePath"
        } elseif ($readable.Count -gt 0) {
            $resumePath = $readable[0]
            Log "      resume: $resumePath"
        } else {
            Stop-Person "no readable resume - only unreadable attachments and no pasted text" $NOTE_RESUME
        }

        # Where they can work is the one answer a search cannot be built
        # without: with no scope there is nothing to look inside, and every
        # other answer only narrows or ranks.
        $scopeAnswer = [string]$answers.work_scope
        $limitsAnswer = [string]$answers.location_limits
        if (-not $scopeAnswer.Trim()) { Stop-Person "no work_scope answer - nothing says where this search may look" $NOTE_NO_SCOPE }

        Write-Utf8 (Join-Path $stage "answers.json") ($answers | ConvertTo-Json -Depth 12)
        Copy-Item -Path $templateFile -Destination (Join-Path $stage "template.md") -Force
        Copy-Item -Path $skillFile -Destination (Join-Path $stage "setup-skill.md") -Force

        # The tabs as they already exist on their tracker, named by the key
        # the write-up has to use.
        $roleLines = @()
        for ($i = 0; $i -lt $liveTracks.Count; $i++) {
            $role = if ($i -lt $roles.Count) { $roles[$i] } else { $null }
            $roleLines += "  key " + $liveTracks[$i].key + " - tab " + $liveTracks[$i].label +
                $(if ($role) { " - they asked for: " + $role.titles } else { "" })
        }

        # The turn's whole world is this folder: answers.json, the staged
        # resume, template.md and setup-skill.md, with out\ to write into.
        $prompt = @"
IMPORTANT: this is one single non-interactive headless run. The process exits as
soon as your turn ends and nobody reads anything after that. There is no
follow-up turn and nobody to ask, so make every call yourself, from what this
person wrote on the form, and don't end your turn with work outstanding.

You are writing the search config and track docs for one person who filled in
the setup form on a job tracker. Everything you need is in this folder, and you
can only read and write inside it - there is no network, no shell and no
tracker access. A script takes what you write here, checks it and posts it.

Read first:
  answers.json     - what they typed, verbatim
  resumes\         - their resume. A PDF here is readable: open it and read it
                     like any other file
  setup-skill.md   - how this deployment's search config is written. Its
                     "Intake mode" section is written for this run and maps
                     each answer onto a field; step 4 has the field-by-field
                     detail of how each one reads.
  template.md      - the track doc template. Every {{PLACEHOLDER}} must be
                     replaced; anything left reaches the live doc.

Write exactly these files:
  out\config.json
  out\docs\tracked_<key>_postings.md   - one per role, filled from template.md

out\config.json:
{
  "tracks": [
    {
      "key": "<one of the keys listed below, exactly>",
      "full_description": "<what belongs in this tab>",
      "role_search_line": "<the titles to search for, as it reads mid-sentence>",
      "search_note": "<optional: how those companies are searched>",
      "resume_line": "<the whole read-the-resume instruction, naming $resumePath>",
      "fit_clause": "<optional>",
      "fit_disqualifier": "<optional>",
      "fit_filter_step": "<optional: only for a real pivot>",
      "intro_note": "<optional>",
      "doc_summary": "<what this track's doc holds>"
    }
  ],
  "settings": {
    "geo_scope_line": "<a paragraph with worked examples, written from work_scope: where the search MAY look>",
    "scope_clause": "<the same scope, short, as it reads mid-sentence>",
    "scope_disqualifier": "<written from location_limits: what puts a posting out, for the disqualified list>"
  },
  "named_companies": ["<companies they named as ones they want searched>"]
}

Their tracker already exists: sending the form made these tabs, and the
person can see them now. Write one entry per key below, using that exact
key - prose filed under a key they don't have leaves the tab they are
looking at empty while reading as a success:
$($roleLines -join "`n")

Rules for this run:
- **Two different answers, two different fields.** `work_scope` ("Where can you
  work?") is the ONLY thing that sets the scope: it becomes geo_scope_line and
  scope_clause, and they say where the search may look. `location_limits`
  ("Anywhere you can't take a job?") is an exclusion and becomes
  scope_disqualifier alone. Never scope a search to a place someone ruled out,
  and never let an exclusion narrow the scope to itself - a search scoped to
  the one state they can't work in screens out everything it finds, all night,
  and reports a quiet night.
- No search keeps a company list. The kinds of employer they like go in the
  track doc's candidate profile, as guidance for discovery; a company they
  named goes in named_companies, which the script puts on the shared list
  every search already reads. Never write companies into the config prose or
  into a doc as a list to sweep.
- Don't set schedule_time or doc_file - the script writes those - and don't
  set anything the form owns: the tab label, its order, the page title,
  pronouns, the ranked locations, or the companies they won't work for. The
  route this goes through refuses them outright.
- Their pay floor, if they gave one, screens on a *stated* range only: a range
  topping out below it disqualifies, and no published range does not.
- Their rule-outs become fit_clause / fit_disqualifier, and only a genuine
  pivot needs fit_filter_step. Keep a caveat at the level of the gap they
  described: an over-literal one silently hides work they asked for, and
  nobody is watching to catch it.
- Write every field as the finished sentence the search should read. The daily
  prompt uses them verbatim.
- If their answers don't say enough for a role, still write the track from what
  they did say. A thin search they can see and correct beats no search at all.
"@

        Log "      prompt: $($prompt.Length) chars; running the model turn (timeout ${MODEL_TIMEOUT_MINUTES}m)"

        # --tools narrows the turn to file tools, --allowedTools confines those
        # to this folder, and --strict-mcp-config keeps any configured MCP
        # server out of it. With these flags the turn's tool list is exactly
        # Edit, Glob, Grep, Read, Write, and a read outside the
        # working directory is refused. `Edit(./**)` is what permits writes;
        # `Write(./**)` is not a valid rule.
        $job = Start-Job -ScriptBlock {
            param($claudePath, $prompt, $cwd)
            Set-Location $cwd
            # The CLI writes UTF-8; without this PowerShell decodes its stdout
            # with the console's OEM codepage and mangles it before the log.
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            # On stdin, not as an argument: Windows caps a command line at ~32k
            # characters, and over it the shim fails while the job still
            # completes.
            $prompt | & $claudePath -p --tools Read Edit Write Glob Grep `
                --allowedTools "Read(./**)" "Edit(./**)" --strict-mcp-config 2>&1
        } -ArgumentList $claudePath, $prompt, $stage

        $turnStart = Get-Date
        $finished = Wait-Job $job -Timeout ($MODEL_TIMEOUT_MINUTES * 60)
        if (-not $finished) {
            Stop-Job $job
            $output = Receive-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force
            if ($output) { $output | Out-String | Out-File -Append -Encoding utf8 -FilePath $logFile }
            Stop-Person "the model turn was still running after $MODEL_TIMEOUT_MINUTES minutes - stopped" $null
        }
        $output = Receive-Job $job -ErrorAction SilentlyContinue
        $jobState = $job.State
        Remove-Job $job -Force
        Log "      ----- claude output -----"
        if ($output) { $output | Out-String | Out-File -Append -Encoding utf8 -FilePath $logFile }
        Log "      ----- end output ----- ($([int]((Get-Date) - $turnStart).TotalSeconds)s, job $jobState)"

        # A clean exit is not the same as having done anything: an
        # unauthenticated CLI prints "Not logged in" and exits 0.
        $outputText = if ($output) { ($output | Out-String).Trim() } else { "" }
        if (-not $outputText) {
            Stop-Person "the CLI produced no output at all - nothing was written" $null
        } elseif ($outputText -match "Not logged in|Please run /login|Invalid API key|authentication_error|Failed to authenticate|Invalid bearer token") {
            Log "      ERROR: the CLI is not authenticated. Run ``claude setup-token``, then: setx CLAUDE_CODE_OAUTH_TOKEN ""<token>"""
            Stop-Person "the CLI is not authenticated - nothing was written" $null
        } elseif ($outputText -match "failed to run|ApplicationFailedException|NativeCommandFailed|is too long") {
            Stop-Person "the CLI failed to start - nothing was written" $null
        }

        # ---- What it wrote, checked before any of it is posted.
        $configFile = Join-Path $stage "out\config.json"
        if (-not (Test-Path $configFile)) { Stop-Person "the model turn wrote no out\config.json" $null }
        try {
            $draft = Get-Content -Raw -Path $configFile | ConvertFrom-Json
        } catch {
            Stop-Person "out\config.json is not valid JSON" $null
        }

        # ---- Is the scope the scope they asked for?
        #
        # A search scoped to a place someone ruled out finds nothing, every
        # night, and reports a quiet night rather than a broken one - so the
        # scope prose is checked against the answer it was supposed to come
        # from, before any of it is posted.
        $scopeWords = Get-PlaceWords $scopeAnswer
        $limitWords = Get-PlaceWords $limitsAnswer
        $scopeProse = "$([string]$draft.settings.geo_scope_line) $([string]$draft.settings.scope_clause)"
        if ($scopeWords.Count -gt 0 -and -not (Test-MentionsAny $scopeProse $scopeWords)) {
            Stop-Person "the scope came back naming none of the places in their work_scope answer" $null
        }
        # An exclusion that reached neither the disqualifier nor the scope has
        # been dropped; one that reached the scope has been inverted into it.
        if ($limitWords.Count -gt 0) {
            $disqProse = [string]$draft.settings.scope_disqualifier
            if (-not (Test-MentionsAny $disqProse $limitWords)) {
                Stop-Person "what they can't take didn't reach scope_disqualifier" $null
            }
            $onlyLimits = @($limitWords | Where-Object { $scopeWords -notcontains $_ })
            if ($onlyLimits.Count -gt 0 -and (Test-MentionsAny ([string]$draft.settings.scope_clause) $onlyLimits)) {
                Stop-Person "the scope clause is built from what they ruled out, not from where they can work" $null
            }
        }
        $draftTracks = @($draft.tracks)
        $liveKeys = @($liveTracks | ForEach-Object { [string]$_.key })
        if ($draftTracks.Count -ne $liveKeys.Count) {
            Stop-Person "the model turn wrote $($draftTracks.Count) track(s) for $($liveKeys.Count) on the account" $null
        }

        $tracks = @()
        $seen = @()
        for ($i = 0; $i -lt $draftTracks.Count; $i++) {
            $d = $draftTracks[$i]
            $key = [string]$d.key
            # The account's key or nothing: the person is already looking at
            # these tabs, and prose written under a key they don't have would
            # leave the tab they can see empty while reading as a success.
            if ($liveKeys -notcontains $key) { Stop-Person "the model turn wrote a track keyed '$key', which isn't one of theirs ($($liveKeys -join ', '))" $null }
            if ($seen -contains $key) { Stop-Person "two tracks share the key '$key'" $null }
            $seen += $key
            foreach ($required in @("role_search_line", "resume_line")) {
                if (-not ([string]$d.$required).Trim()) { Stop-Person "track '$key' has no $required" $null }
            }
            if (([string]$d.resume_line) -notlike "*$resumePath*") {
                Stop-Person "track '$key' has a resume_line that doesn't name $resumePath" $null
            }

            $writeup = @{
                search = $key
                schedule_time = (ConvertTo-Clock $slots[$i])
                doc_file = "docs/tracked_${key}_postings.md"
            }
            foreach ($field in $MODEL_TRACK_FIELDS) { $writeup[$field] = [string]$d.$field }

            $docFile = Join-Path $stage "out\docs\tracked_${key}_postings.md"
            if (-not (Test-Path $docFile)) { Stop-Person "track '$key' has no doc at out\docs\tracked_${key}_postings.md" $null }
            $docText = Get-Content -Raw -Path $docFile
            if (-not $docText -or $docText.Length -lt 500) { Stop-Person "track '$key' has a doc too short to be the filled template" $null }
            if ($docText -match '\{\{') { Stop-Person "track '$key' has a doc with an unfilled {{PLACEHOLDER}}" $null }

            $tracks += , @{ Key = $key; Body = $writeup; DocPath = $writeup.doc_file; DocText = $docText; Slot = (ConvertTo-Clock $slots[$i]) }
        }

        # ---- Post it, as them.
        foreach ($t in $tracks) {
            Invoke-WithRetry "PUT /api/documents/$($t.DocPath)" {
                Invoke-WebRequest -Uri "$TrackerUrl/api/documents/$($t.DocPath)" -Method Put `
                    -Headers @{ Authorization = "Bearer $personToken" } -UserAgent $API_USER_AGENT `
                    -ContentType "text/markdown; charset=utf-8" `
                    -Body ([System.Text.Encoding]::UTF8.GetBytes($t.DocText)) `
                    -TimeoutSec 60 -UseBasicParsing -ErrorAction Stop
            } | Out-Null
            Log "      wrote $($t.DocPath) ($($t.DocText.Length) chars)"
        }

        # Their scope wording travels with the first write-up call: it is
        # per-account rather than per-track, and sending it beside a track's
        # prose keeps a search from being half described if a later call fails.
        $scopeBody = @{}
        foreach ($field in $MODEL_SETTING_FIELDS) { $scopeBody[$field] = [string]$draft.settings.$field }

        $first = $true
        foreach ($t in $tracks) {
            $body = $t.Body.Clone()
            if ($first) { foreach ($k in $scopeBody.Keys) { $body[$k] = $scopeBody[$k] } }
            # The documents the search reads besides its tracking doc: the one
            # resume this run chose, which resume_line was checked to name. A
            # track with no list is refused its documents at run time.
            $body["documents"] = @($resumePath)
            $written = Api POST "/api/writeup" $personToken $body
            Log "      wrote up $($t.Key) at $($t.Slot): $(($written.written) -join ', ')"
            $first = $false
        }

        # The companies they named, onto the one shared list every search reads.
        # Undated, so nothing is marked swept tonight.
        #
        # `start_here` puts this track's cursor at the first company this call
        # added, so their own names are what night one covers rather than
        # whatever the rotation happened to be pointing at. Only the server
        # knows those positions - new companies are appended in shuffled order
        # within the call - which is why it rides on this call instead of
        # being computed here. Nothing added (every name was already on the
        # list) leaves the cursor alone, and comes back as `added: 0`.
        $named = @($draft.named_companies | Where-Object { ([string]$_).Trim() } | Select-Object -First 30)
        if ($named.Count -gt 0) {
            try {
                $recorded = Api POST "/api/coverage" $personToken @{
                    search = $seen[0]; on = ""; start_here = $true
                    swept = @($named | ForEach-Object { @{ company = [string]$_ } })
                }
                Log "      shared list: $($recorded.added) added of $($named.Count) named; cursor $($recorded.cursor)"
            } catch {
                # Their search works without this; the names are in their answers
                # and their doc, and the next run's discovery step finds them.
                Log "      WARNING: couldn't add the companies they named - $($_.Exception.Message)"
            }
        }

        # ---- Their scheduled tasks.
        #
        # A separate process: setup-scheduler.ps1 ends with `exit`, which would
        # end this run too if it were dot-sourced or called in-process.
        $scheduler = Join-Path $scriptDir "setup-scheduler.ps1"
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scheduler `
            -DataDir $DataDir -User $id *>&1 | Out-File -Append -Encoding utf8 -FilePath $logFile
        if ($LASTEXITCODE -ne 0) { Stop-Person "setup-scheduler.ps1 exited $LASTEXITCODE" $null }

        # ---- Done is what the tracker and this machine say, not what the
        # model reported.
        $after = Api GET "/api/config" $personToken $null
        foreach ($t in $tracks) {
            $live = @($after.tracks | Where-Object { $_.key -eq $t.Key })
            if ($live.Count -eq 0) { Stop-Person "track '$($t.Key)' isn't in the config after writing it up" $null }
            if ([string]$live[0].schedule_time -ne $t.Slot) {
                Stop-Person "track '$($t.Key)' came back scheduled at $($live[0].schedule_time), not $($t.Slot)" $null
            }
            # The tab is only usable once it has a role line: GET /api/prompt
            # refuses a track without one, so a run that wrote everything else
            # and skipped this would leave a task that fails every morning.
            if (-not ([string]$live[0].role_search_line).Trim()) {
                Stop-Person "track '$($t.Key)' still has no role_search_line after the write-up" $null
            }
        }
        $docPaths = Get-DocumentPaths $personToken
        foreach ($t in $tracks) {
            if ($docPaths -notcontains $t.DocPath) { Stop-Person "$($t.DocPath) isn't in their documents after writing it" $null }
        }
        if ($docPaths -notcontains $resumePath) { Stop-Person "$resumePath isn't in their documents" $null }

        $prefix = "JobSearch-" + $(if ($id.Length -ge 8) { $id.Substring(0, 8) } else { $id }) + "-"
        $tasks = @(Get-ScheduledTask -TaskName "$prefix*" -ErrorAction SilentlyContinue)
        if ($tasks.Count -lt $tracks.Count) {
            Stop-Person "only $($tasks.Count) of $($tracks.Count) scheduled task(s) are registered" $null
        }
        Log "      tasks: $(($tasks | ForEach-Object { $_.TaskName }) -join ', ')"

        $done = $true
    } catch {
        Log "      ERROR: $($_.Exception.Message)"
        $exitCode = 1
    }

    # ---- Tell them, either way.
    #
    # Left alone, a pending setup keeps promising a tracker in the morning
    # forever. 'failed' both says what happened and keeps them in tomorrow
    # night's queue.
    try {
        $fresh = @((Api GET "/api/intake/pending" $AdminToken $null).intakes | Where-Object { $_.user.id -eq $id })
        if ($fresh.Count -gt 0 -and [string]$fresh[0].updated_at -ne [string]$item.updated_at) {
            # They sent new answers while this was running. What was just built
            # is from the old ones, so it stays pending and tomorrow night
            # builds what they actually asked for.
            Log "      their answers changed while this ran - left pending, so tomorrow builds the new ones"
            continue
        }
        if ($done) {
            Api POST "/api/intake/complete" $AdminToken @{ user = $id; status = "done" } | Out-Null
            Log "      $name is set up"
            $built += $name
        } else {
            Api POST "/api/intake/complete" $AdminToken @{ user = $id; status = "failed"; note = $personNote } | Out-Null
            Log "      marked failed, and they were told: $personNote"
        }
    } catch {
        Log "      WARNING: couldn't record the outcome for $name - $($_.Exception.Message)"
        $exitCode = 1
    }
}

Log "finished - built $($built.Count) of $($queue.Count)$(if ($built.Count) { ": $($built -join ', ')" })"
Log "===== done ====="
exit $exitCode
