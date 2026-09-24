<#
.SYNOPSIS
  The tracker API's calling convention, as commands a nightly search run
  invokes instead of composing HTTP calls itself.

.DESCRIPTION
  Copied into each run's working directory by run-search.ps1 and invoked from
  the prompt as `./tracker <command> [file]`.

  Rules with one right answer - `search` is this run's key, `on` is today's
  local date, reports go by url, an unset field is omitted - are applied here
  from the run's environment. The prompt carries only what the run alone knows.

  It makes no judgement about the search: it never invents or drops a lead, or
  turns an unreadable page into a delisting. A row it refuses is named on
  stdout and counted in the summary line, because the run writes its report
  from what this prints.

  ---- Commands.

  All of them read TRACKER_URL, TRACKER_API_TOKEN and TRACKER_SEARCH from the
  environment; run-search.ps1 sets all three.

    tracker dedup                 GET  /api/dedup/<key>     -> dedup.json
    tracker companies             GET  /api/coverage/<key>  -> companies.json
    tracker known     "<company>" GET  /api/coverage/<key>?all=1
    tracker leads     <file>      POST /api/leads
    tracker screened  <file>      POST /api/screened
    tracker verified  <file>      POST /api/verified
    tracker delist    <file>      POST /api/delist
    tracker swept     <file>      POST /api/coverage
    tracker run --status ok --note "..."   POST /api/runs

  Each <file> is a JSON array; an object carrying the array under its field
  name (`leads`, `screened`, `urls`, `swept`) is accepted too. An empty array
  is a no-op that says so and exits 0, so a step with nothing to send needs no
  conditional in the prompt.

.EXAMPLE
  ./tracker dedup
  ./tracker leads leads.json
  ./tracker run --status ok --note "8 new, 34 screened out"
#>

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- plumbing --

function Write-TrackerLine($msg) { [Console]::Out.WriteLine("tracker: $msg") }

function Fail($msg) {
    # stdout, not stderr: the run reads this command's output as one stream and
    # writes its own report from it, and an error it cannot see is an error it
    # reports as a success.
    [Console]::Out.WriteLine("tracker: ERROR: $msg")
    exit 1
}

# Local date, sent on every call: the server's UTC default stamps an evening
# run's rows with tomorrow.
$Today = (Get-Date).ToString("yyyy-MM-dd")

$Base = $env:TRACKER_URL
if ($Base) { $Base = $Base.TrimEnd("/") }
$Token = $env:TRACKER_API_TOKEN
$Search = $env:TRACKER_SEARCH

# The shared list's names, read once by the first `known` of a stretch of the
# run. `companies` and `swept` delete it, because those are the two points where
# the list a run knows about can change; tying the cache to them rather than to
# a fresh directory keeps it correct for a -UseLocalFiles run, whose working
# directory persists between nights.
$KnownCache = [System.IO.Path]::Combine((Get-Location).Path, "known-list.json")

# --------------------------------------------------------------- arguments --

# Parsed by hand rather than through param(): the prompt writes `--status ok`,
# and PowerShell binds only single-dash names, so `--status` would arrive as a
# positional value and silently take the place of something else.
$Command = ""
$PositionalArg = ""
$Opts = @{}
$rest = @($args)
for ($i = 0; $i -lt $rest.Count; $i++) {
    $argument = [string]$rest[$i]
    if ($argument -match "^--?([A-Za-z][A-Za-z0-9-]*)$") {
        $name = $Matches[1].ToLowerInvariant()
        $value = ""
        if (($i + 1) -lt $rest.Count -and ([string]$rest[$i + 1]) -notmatch "^--[A-Za-z]") {
            $value = [string]$rest[$i + 1]
            $i++
        }
        $Opts[$name] = $value
    } elseif (-not $Command) {
        $Command = $argument.ToLowerInvariant()
    } elseif (-not $PositionalArg) {
        $PositionalArg = $argument
    } else {
        Fail "unexpected extra argument '$argument' - usage: tracker <command> [file]"
    }
}
if ($Opts.ContainsKey("search") -and $Opts["search"]) { $Search = $Opts["search"] }

if (-not $Command) {
    Fail "no command given - one of: dedup, companies, known, leads, screened, verified, delist, swept, run"
}
if (-not $Base -or -not $Token) {
    Fail "TRACKER_URL and TRACKER_API_TOKEN are not both set in this environment - nothing can be synced"
}
if (-not $Search) {
    Fail "TRACKER_SEARCH is not set - this run doesn't know which track it is"
}

# ------------------------------------------------------------------- http ---

# ---- What is worth retrying, and why replaying a call is safe here at all.
#
# Transient statuses are decided by number. run-search.ps1 uses the same rule
# and numbers for its own calls; change both together.
#
#   retry   no status at all (the connection never got an answer: reset, DNS,
#           timeout), 429, and any other 5xx. That includes Cloudflare's
#           `error code: 1101` - its answer to a Worker exception, which says
#           nothing about the request and usually succeeds on the next attempt.
#   stop    503, and every 4xx except 429. A 4xx means the request itself is
#           wrong, and it will be as wrong in twelve seconds. 503 is what a
#           handler returns when the deployment is missing a binding, where
#           "the fix is a config change rather than a retry" (see
#           ../server/src/routes/documents.js).
#
# A retry cannot tell "the request never landed" from "it landed and the
# response was lost", so every POST reached from here must be idempotent:
#
#   /api/leads, /api/screened    dedup by url and report the duplicates back
#   /api/verified, /api/delist   are keyed by url and idempotent
#   /api/coverage                upserts by company, and *sets* the sweep
#                                cursor from the positions reported rather
#                                than incrementing it (db.js setSweepCursor)
#   /api/runs                    upserts on (user, track)
#
# So a replay costs at most a duplicate counted in the output line, never a
# duplicate row. An endpoint that is not idempotent needs an idempotency key
# of its own before it is called from here.
#
# Worst case is 19s of sleeping per call, which an unattended overnight run can
# afford.
$RetryAttempts = 4
$RetryBackoff = @(2, 5, 12)

function Test-Transient($status) {
    if ($status -eq 503) { return $false }
    return ($status -eq 0 -or $status -eq 429 -or $status -ge 500)
}

# One line of an error body for the retry progress lines: a 1101 arrives as a
# whole HTML page, and the final attempt's Fail prints the body in full.
function Format-OneLine($text) {
    if (-not $text) { return "" }
    $one = ($text -replace "\s+", " ").Trim()
    if ($one.Length -gt 160) { return $one.Substring(0, 160) + "..." }
    return $one
}

function Invoke-Tracker($method, $path, $bodyObj) {
    $uri = "$Base$path"
    $headers = @{ Authorization = "Bearer $Token" }
    # Encoded once, outside the retry loop, so every attempt sends identical
    # bytes.
    $bytes = $null
    if ($null -ne $bodyObj) {
        $jsonText = $bodyObj | ConvertTo-Json -Depth 10 -Compress
        # Sent as UTF-8 bytes rather than as a string: PS 5.1 encodes a string
        # body as ISO-8859-1, which mangles an accented company name or an
        # em-dash in a `note` on the way out.
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonText)
    }

    for ($attempt = 1; ; $attempt++) {
        try {
            if ($null -ne $bytes) {
                return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers `
                    -Body $bytes -ContentType "application/json; charset=utf-8" -ErrorAction Stop
            }
            return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -ErrorAction Stop
        } catch {
            $resp = $_.Exception.Response
            $status = 0
            if ($resp) { try { $status = [int]$resp.StatusCode } catch { } }
            $detail = ""
            if ($resp) {
                try {
                    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
                    $detail = $reader.ReadToEnd()
                } catch { }
            }
            if (-not $detail) { $detail = $_.Exception.Message }

            if (-not (Test-Transient $status) -or $attempt -ge $RetryAttempts) {
                # The attempt count is part of the error: four failures over
                # twenty seconds and a single failure are different problems.
                $tries = ""
                if ($attempt -gt 1) { $tries = " after $attempt attempts" }
                Fail "$method $path failed ($status)$tries`: $detail"
            }
            $wait = $RetryBackoff[[Math]::Min($attempt - 1, $RetryBackoff.Count - 1)]
            Write-TrackerLine "$method $path failed ($status) - transient, retrying in ${wait}s (attempt $attempt of $RetryAttempts): $(Format-OneLine $detail)"
            Start-Sleep -Seconds $wait
        }
    }
}

function Write-Json($path, $obj) {
    $text = $obj | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText(
        [System.IO.Path]::Combine((Get-Location).Path, $path),
        $text,
        (New-Object System.Text.UTF8Encoding($false)))
}

# ------------------------------------------------------------------ input ---

# A bare array is the documented shape; an object carrying the array under
# $key is accepted too, since a run that writes one means the same rows.
function Read-Rows($path, $key) {
    if (-not $path) { Fail "'$Command' needs a file: tracker $Command <file>.json" }
    if (-not (Test-Path -LiteralPath $path)) {
        # Not "nothing to send": a mistyped filename would silently discard the
        # run's findings.
        Fail "'$path' does not exist. Write the rows to it first - an empty array [] if there are none."
    }
    $raw = Get-Content -Raw -LiteralPath $path -Encoding UTF8
    if (-not $raw -or -not $raw.Trim()) { return @() }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json } catch { Fail "'$path' is not valid JSON: $($_.Exception.Message)" }
    if ($null -eq $parsed) { return @() }
    if ($parsed -is [System.Array]) { return @($parsed) }
    if ($parsed.PSObject -and ($parsed.PSObject.Properties.Name -contains $key)) { return @($parsed.$key) }
    return @($parsed)
}

function Get-TrimmedField($row, $name) {
    if ($null -eq $row) { return "" }
    if ($row -is [string]) { return "" }
    if ($row.PSObject.Properties.Name -notcontains $name) { return "" }
    $value = $row.$name
    if ($null -eq $value) { return "" }
    return ([string]$value).Trim()
}

$script:Refused = 0
function Refuse($what, $why) {
    $script:Refused++
    Write-TrackerLine "refused $what - $why"
}

function Get-OutputPath($fallback) {
    if ($Opts.ContainsKey("out") -and $Opts["out"]) { return $Opts["out"] }
    return $fallback
}

# ---------------------------------------------------------------- commands --

# Each command is one function, named for what it runs, and the switch below
# only dispatches. Kept in this file because run-search.ps1 copies it alone
# into the run directory.

# The tabs this run fills, read from the config rather than named in an
# argument. A branched search fills its own tab plus every track whose
# `fed_by` points at it; asking the server which those are keeps the prompt
# from listing them and keeps the list from going stale.
function Invoke-DedupCommand {
    $keys = @($Search)
    $config = Invoke-Tracker "GET" "/api/config" $null
    # `| Where-Object { $_ }` throughout, because @($null) in PowerShell is a
    # one-element array holding $null - a foreach over an absent property
    # runs once on nothing rather than not at all.
    foreach ($track in @($config.tracks | Where-Object { $_ })) {
        if ($track.fed_by -eq $Search -and $track.key -ne $Search) { $keys += $track.key }
    }

    $leads = @()
    $screened = @()
    $seen = @{}
    # Screened history scoped to what this run can reach: the companies around its
    # cursor, plus anything rejected in the last few days wherever it was. A run
    # only meets the rest by chance, and reporting one again costs a check, not a
    # row - the tracker refuses the duplicate. Leads always come back whole.
    $scopedTabs = 0
    $flagged = 0
    $recheckBudget = $null
    $recheckOpen = $null
    $keptScreened = 0
    $totalScreened = 0
    $companies = $null
    $since = $null
    foreach ($tabKey in $keys) {
        $dedupResponse = Invoke-Tracker "GET" "/api/dedup/${tabKey}?scope=batch" $null
        if ($dedupResponse.scope) {
            $scopedTabs++
            $keptScreened += [int]$dedupResponse.scope.kept
            $totalScreened += [int]$dedupResponse.scope.of
            $companies = $dedupResponse.scope.companies
            $since = $dedupResponse.scope.since
            if ($dedupResponse.scope.recheck) {
                $recheckBudget = $dedupResponse.scope.recheck.budget
                $recheckOpen = $dedupResponse.scope.recheck.eligible
            }
        }
        foreach ($lead in @($dedupResponse.leads | Where-Object { $_ })) {
            # No `id`. Nothing a run posts back is keyed by one, and a lead id
            # in front of a model is an invitation to report by it.
            $row = [ordered]@{ url = $lead.url; status = $lead.status; search = $tabKey }
            # The tracker picks tonight's re-checks across the whole search, longest-
            # unconfirmed first, so the flag is carried through as it came.
            if ($lead.recheck -eq $true) { $row["recheck"] = $true; $flagged++ }
            $leads += [pscustomobject]$row
        }
        foreach ($screenedUrl in @($dedupResponse.screened | Where-Object { $_ })) {
            if (-not $seen.ContainsKey($screenedUrl)) { $seen[$screenedUrl] = $true; $screened += $screenedUrl }
        }
    }

    $out = Get-OutputPath "dedup.json"
    Write-Json $out ([pscustomobject]@{ leads = @($leads); screened = @($screened) })
    # A server that doesn't know `scope` sends every row and no `scope` key.
    if ($scopedTabs -eq $keys.Count) {
        $scopeNote = "screened scoped to $companies companies from the cursor plus since $since ($keptScreened of $totalScreened kept)"
    } elseif ($scopedTabs -eq 0) {
        $scopeNote = "unscoped - the tracker sent full history"
    } else {
        $scopeNote = "scoped on $scopedTabs of $($keys.Count) tab(s)"
    }
    if ($null -ne $recheckBudget) {
        $recheckNote = "$flagged to re-check tonight (budget $recheckBudget of $recheckOpen open)"
    } else {
        $recheckNote = "no re-check selection from the tracker"
    }
    Write-TrackerLine "dedup: $($leads.Count) tracked lead(s), $($screened.Count) screened url(s) across $($keys.Count) tab(s), $scopeNote, $recheckNote -> $out"
}

function Invoke-CompaniesCommand {
    if (Test-Path $KnownCache) { Remove-Item $KnownCache -Force }
    $coverage = Invoke-Tracker "GET" "/api/coverage/$Search" $null
    $out = Get-OutputPath "companies.json"
    Write-Json $out $coverage
    Write-TrackerLine "companies: $($coverage.batch) to cover tonight, $($coverage.cursor) of $($coverage.total) through the rotation -> $out"
    foreach ($listed in @($coverage.companies | Where-Object { $_ })) {
        $line = "  $($listed.company)"
        $board = Get-TrimmedField $listed "board"
        if ($board) { $line += " [$board]" }
        $note = Get-TrimmedField $listed "note"
        if ($note) { $line += " - $note" }
        Write-TrackerLine $line
    }
}

function Invoke-KnownCommand {
    # Whether a company is already on the shared list, decided here rather than
    # by the run reading names. A run only sees tonight's slice, so on its own it
    # cannot tell that another search added a company earlier the same night.
    # The match is normalize() in server/src/exclude.js - lowercase, every run of
    # characters outside a-z and 0-9 collapsed to one space, trimmed - so it
    # agrees with how the list itself tells two names apart. Change both together.
    if (-not $PositionalArg) { Fail "known needs a company name - usage: tracker known ""<company>""" }
    $norm = { param($companyName) (([string]$companyName).ToLowerInvariant() -creplace "[^a-z0-9]+", " ").Trim() }
    $want = & $norm $PositionalArg
    if (-not $want) { Fail "'$PositionalArg' has no letters or digits to match on" }
    # Every name a company answers to, each paired with the name it is kept
    # under: its own, and any alias a merge or rename left it (the server maps a
    # reported alias to the kept company the same way, so "Marriott" is
    # "Marriott International" to both).
    $names = $null
    if (Test-Path $KnownCache) {
        $names = (Get-Content -Raw -Encoding UTF8 $KnownCache | ConvertFrom-Json).names
    }
    # A cache without `names` predates aliases; read the list again.
    if ($null -eq $names) {
        $fullList = Invoke-Tracker "GET" "/api/coverage/${Search}?all=1" $null
        $names = @(foreach ($listed in @($fullList.companies | Where-Object { $_ })) {
            $kept = [string]$listed.company
            [pscustomobject]@{ name = $kept; company = $kept }
            foreach ($alias in @($listed.aliases | Where-Object { $_ })) {
                [pscustomobject]@{ name = [string]$alias; company = $kept }
            }
        })
        # Under a property, not as a bare array: piped through ConvertTo-Json, a
        # one-name list is written as a single object and an empty one as nothing.
        Write-Json "known-list.json" @{ names = $names }
    }
    $hit = @($names | Where-Object { $_ -and ((& $norm $_.name) -eq $want) } | ForEach-Object { $_.company }) | Select-Object -First 1
    if ($hit) {
        Write-TrackerLine "known: $PositionalArg is on the list as '$hit' - skip it, its turn comes in the rotation"
    } else {
        # The list hides this account's excluded companies, so absence is one of
        # two things, and the run has to hear both.
        Write-TrackerLine "known: $PositionalArg is not on the list, or is excluded for this account"
    }
}

# The places this person ranked first, as entries an `area` has to equal:
# `priority_locations` split on commas, each trimmed, empties dropped. The
# leads route applies the same rule (docs/location-settings-plan.md, "Each lead
# carries its area"); change both together. Read once, and only when a row
# carries an area.
$script:RankedEntries = $null
function Get-RankedEntries {
    if ($null -eq $script:RankedEntries) {
        $config = Invoke-Tracker "GET" "/api/config" $null
        $ranked = $config.settings.priority_locations
        # Wrapped in @(): an `if` that yields an empty array assigns $null,
        # which would read the config again for every row.
        $script:RankedEntries = @(if ($ranked -is [string]) {
            $ranked -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        })
    }
    return , $script:RankedEntries
}

# Whether a lead's link plainly goes nowhere: the posting answers 404 or 410,
# or the site redirects it to its own error page (Workable sends an unknown
# code to /oops). A run can copy a job id wrongly out of a board's JSON after
# verifying the real posting, and the lead then links to nothing; this opens
# the link that will actually be saved. Returns why it's gone, or "" - and ""
# for anything unclear too (a timeout, a 403, a site that refuses scripts),
# because refusing a live lead on a fetch hiccup would lose it for good.
#
# curl.exe (in System32 on Windows 10 and 11) rather than .NET's web client,
# which drops the connection on the 404s GitHub and Lever send and reports
# them as "connection closed" rather than the status. Without curl.exe the
# check says nothing, and every lead is sent as before.
$DeadPagePaths = @("oops", "404", "not-found", "notfound", "page-not-found", "job-not-found")
$Curl = Join-Path $env:SystemRoot "System32\curl.exe"
function Get-DeadLinkReason([string]$link) {
    if (-not (Test-Path $Curl)) { return "" }
    try {
        $out = & $Curl -s -o NUL -L --max-redirs 8 -m 10 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) job-search-tracker" `
            -w "%{http_code} %{url_effective}" $link 2>$null
    } catch { return "" }
    if ($LASTEXITCODE -ne 0 -or -not $out) { return "" }
    $status, $landed = ([string]$out).Split(" ", 2)
    if ($status -eq "404" -or $status -eq "410") { return "it answers $status" }
    try { $path = ([Uri]$landed).AbsolutePath } catch { return "" }
    $last = ($path.Trim("/") -split "/")[-1].ToLowerInvariant()
    if ($landed -ne $link -and $DeadPagePaths -contains $last) {
        return "it redirects to the site's error page ($landed)"
    }
    return ""
}

$script:AreaCleared = 0
function Invoke-LeadsCommand {
    $rows = Read-Rows $PositionalArg "leads"
    $send = @()
    foreach ($inputRow in $rows) {
        $url = Get-TrimmedField $inputRow "url"
        $company = Get-TrimmedField $inputRow "company"
        $title = Get-TrimmedField $inputRow "title"
        if (-not $url) { Refuse "a lead with no url" "there is nothing to track or dedup on"; continue }
        if (-not $company -or -not $title) { Refuse "$url" "a lead needs both a company and a title"; continue }
        $dead = Get-DeadLinkReason $url
        if ($dead) { Refuse "$url" "the link goes nowhere - $dead. Open the posting again and send the url its page is actually at"; continue }
        $row = @{ search = $Search; company = $company; title = $title; url = $url }
        $rowSearch = Get-TrimmedField $inputRow "search"
        if ($rowSearch) { $row["search"] = $rowSearch }
        foreach ($fieldName in @("location", "fit", "team", "setup", "comp")) {
            $fieldValue = Get-TrimmedField $inputRow $fieldName
            if ($fieldValue) { $row[$fieldName] = $fieldValue }
        }
        # An area is one of the ranked places or nothing: a near-miss like
        # "Seattle" for "Seattle area" would give the lead no tier while
        # looking filed. Case doesn't matter, and what is sent is the entry as
        # the person typed it, so every lead in one place carries one spelling.
        # The lead itself is always sent.
        $area = Get-TrimmedField $inputRow "area"
        if ($area) {
            $entries = Get-RankedEntries
            $match = @($entries | Where-Object { $_ -ieq $area }) | Select-Object -First 1
            if ($match) {
                $row["area"] = $match
            } else {
                $script:AreaCleared++
                $known = if ($entries.Count) { $entries -join " | " } else { "none are set" }
                Write-TrackerLine "area '$area' on $url is not one of the ranked places ($known) - sent without an area"
            }
        }
        $send += $row
    }
    if ($send.Count -eq 0) { Write-TrackerLine "leads: nothing to send (refused=$($script:Refused))"; exit 0 }
    $res = Invoke-Tracker "POST" "/api/leads" @{ on = $Today; leads = @($send) }
    Write-TrackerLine "leads: added=$($res.added) duplicates=$($res.duplicates) excluded=$($res.excluded) refused=$($script:Refused) area_cleared=$($script:AreaCleared) on=$Today"
    # Every area sent was checked above, so the route clearing one means the
    # two copies of the split rule disagree.
    if ([int]$res.area_cleared -gt 0) {
        Write-TrackerLine "WARNING: the tracker cleared $($res.area_cleared) area(s) this helper accepted - its ranked-place rule and this one have drifted apart"
    }
}

# What a screened row was rejected for, as one of a closed set, beside the
# sentence that says it in full. The page groups by it, so an invented word
# would make its own group of one; the route stores an unknown kind as `other`
# and names it back, and this does the same before sending, so a run hears
# about it on the night rather than in a reply nobody reads. First that applies
# wins, which is the order the prompt's step 9b states.
#
# `delisted` is the tenth kind and deliberately not here: that row is written
# when a lead this person had is confirmed gone (/api/delist), and a run
# calling this command is recording a candidate it rejected, which is a
# different thing. Sent here it becomes `other`, so a month of rejections can't
# fill up with rows claiming to be lost leads.
$ScreenedKinds = @(
    "dead", "duplicate", "out-of-scope", "wrong-level",
    "wrong-role", "contract", "pay-below-floor", "other"
)
$script:KindsCoerced = 0
function Invoke-ScreenedCommand {
    $rows = Read-Rows $PositionalArg "screened"
    $send = @()
    foreach ($inputRow in $rows) {
        $url = Get-TrimmedField $inputRow "url"
        $reason = Get-TrimmedField $inputRow "reason"
        if (-not $url) { Refuse "a screened row with no url" "the url is what stops tomorrow re-verifying it"; continue }
        if (-not $reason) { Refuse "$url" "a screened row needs a reason - it is the whole value of the entry"; continue }
        $row = @{ search = $Search; url = $url; reason = $reason }
        # The tab the posting would have been filed under, for a run that fills
        # several: a rejection reads per tab like a lead does, rather than all
        # of them under the tab that owns the search. A row that names none is
        # filed under this search, which is what it was before.
        $rowSearch = Get-TrimmedField $inputRow "search"
        if ($rowSearch) { $row["search"] = $rowSearch }
        foreach ($fieldName in @("company", "title", "location")) {
            $fieldValue = Get-TrimmedField $inputRow $fieldName
            if ($fieldValue) { $row[$fieldName] = $fieldValue }
        }
        $kind = (Get-TrimmedField $inputRow "kind").ToLowerInvariant()
        if ($kind) {
            if ($ScreenedKinds -contains $kind) {
                $row["kind"] = $kind
            } else {
                $script:KindsCoerced++
                $row["kind"] = "other"
                Write-TrackerLine "kind '$kind' on $url is not one of $($ScreenedKinds -join ', ') - sent as 'other'"
            }
        }
        $send += $row
    }
    if ($send.Count -eq 0) { Write-TrackerLine "screened: nothing to send (refused=$($script:Refused))"; exit 0 }
    $res = Invoke-Tracker "POST" "/api/screened" @{ search = $Search; on = $Today; screened = @($send) }
    Write-TrackerLine "screened: added=$($res.added) duplicates=$($res.duplicates) excluded=$($res.excluded) refused=$($script:Refused) kinds_coerced=$($script:KindsCoerced) on=$Today"
    # Every kind sent was checked above, so the route coercing one means the
    # two copies of the list have drifted apart.
    foreach ($sent in @($res.kinds_coerced.PSObject.Properties | Where-Object { $_ })) {
        Write-TrackerLine "WARNING: the tracker stored '$($sent.Name)' as 'other' $($sent.Value) time(s) - its list of kinds and this one have drifted apart"
    }
}

function Invoke-UrlReportCommand {
    $rows = Read-Rows $PositionalArg "urls"
    $urls = @()
    $seen = @{}
    foreach ($inputRow in $rows) {
        $url = ""
        if ($inputRow -is [string]) { $url = ([string]$inputRow).Trim() } else { $url = Get-TrimmedField $inputRow "url" }
        if (-not $url) { Refuse "an entry with no url" "both reports are by url - there are no ids here"; continue }
        if ($seen.ContainsKey($url)) { continue }
        $seen[$url] = $true
        $urls += $url
    }
    if ($urls.Count -eq 0) { Write-TrackerLine "${Command}: nothing to report (refused=$($script:Refused))"; exit 0 }
    # `search` is this run's own key in both calls, including for a posting
    # tracked in another tab this run fills: the tracker matches a url against
    # every lead this person has, whatever tab holds it.
    $path = "/api/verified"
    if ($Command -eq "delist") { $path = "/api/delist" }
    $res = Invoke-Tracker "POST" $path @{ search = $Search; on = $Today; urls = @($urls) }
    if ($Command -eq "delist") {
        Write-TrackerLine "delist: removed=$($res.removed) kept=$($res.kept) unmatched=$($res.unmatched) on=$Today"
    } else {
        Write-TrackerLine "verified: stamped=$($res.stamped) unmatched=$($res.unmatched) on=$Today"
    }
    foreach ($unmatchedUrl in @($res.unmatchedUrls | Where-Object { $_ })) { Write-TrackerLine "  no lead matches $unmatchedUrl" }
}

function Invoke-SweptCommand {
    $rows = Read-Rows $PositionalArg "swept"
    $send = @()
    foreach ($inputRow in $rows) {
        $company = ""
        if ($inputRow -is [string]) { $company = ([string]$inputRow).Trim() } else { $company = Get-TrimmedField $inputRow "company" }
        if (-not $company) { Refuse "a sweep with no company" "there is nothing to stamp"; continue }
        $row = @{ company = $company }
        # `board`, `endpoint`, `url_shape` and `wall` go to the shared
        # company_fetch table used by every search on the deployment; `note`
        # stays in this search's own row (see routes/coverage.js). The server
        # reads fields by name and drops the rest, so a new field is added
        # here in the same change as its server column. `dead_signal` is
        # deliberately not sent - see prompt.js's step 9d, "RECORD WHAT YOU
        # COVERED".
        foreach ($fieldName in @("board", "endpoint", "url_shape", "wall", "note")) {
            $fieldValue = Get-TrimmedField $inputRow $fieldName
            if ($fieldValue) { $row[$fieldName] = $fieldValue }
        }
        # A `wall` plus a `board` or `endpoint` contradicts itself: the wall
        # says no route to the listings worked, the board or endpoint says one
        # did. The row is sent exactly as written and the server, which
        # applies this rule for every caller, shares nothing from it; this
        # only warns. `url_shape` is not part of the contradiction - it
        # describes a posting page, not a route to the listings.
        if ($row.ContainsKey("wall") -and ($row.ContainsKey("board") -or $row.ContainsKey("endpoint"))) {
            Write-TrackerLine "WARNING: $company reports a wall and a working board/endpoint in one row, which contradicts itself. If any route to its listings worked, re-send it without the wall; if none did, re-send it without the board/endpoint."
        }
        $send += $row
    }
    if ($send.Count -eq 0) { Write-TrackerLine "swept: nothing to record (refused=$($script:Refused))"; exit 0 }
    $res = Invoke-Tracker "POST" "/api/coverage" @{ search = $Search; on = $Today; swept = @($send) }
    if (Test-Path $KnownCache) { Remove-Item $KnownCache -Force }
    # `added`: companies this call put on the shared list, which every search
    # sweeps. `withheld`: rows the server shared nothing from because of the
    # wall contradiction. It should equal the WARNING count above - both apply
    # the same test, and a field is only in a row when non-empty - so a
    # mismatch means the rule has drifted between here and handleRecordSweeps.
    Write-TrackerLine "swept: recorded=$($res.recorded) added=$($res.added) withheld=$($res.withheld) excluded=$($res.excluded) refused=$($script:Refused) cursor=$($res.cursor) on=$Today"
}

function Invoke-RunCommand {
    # Status is taken from --status or a positional argument, so the one call
    # that must never be skipped cannot fail on how it is spelled.
    $status = "ok"
    if ($Opts.ContainsKey("status") -and $Opts["status"]) { $status = $Opts["status"].ToLowerInvariant() }
    elseif ($PositionalArg) { $status = $PositionalArg.ToLowerInvariant() }
    if ($status -ne "ok" -and $status -ne "error") {
        Fail "--status must be 'ok' or 'error', not '$status'"
    }
    $note = ""
    if ($Opts.ContainsKey("note")) { $note = $Opts["note"] }
    # No counts. The server derives leadsAdded/screenedAdded/delisted from the
    # rows that actually landed, per tab, so there is nothing here to add up
    # and nothing that can be added up wrong.
    $res = Invoke-Tracker "POST" "/api/runs" @{ search = $Search; status = $status; on = $Today; note = $note }
    $also = @($res.also | Where-Object { $_ }).Count
    $fanout = ""
    if ($also -gt 0) { $fanout = " (+$also fed tab(s) recorded)" }
    Write-TrackerLine "run: recorded $Search as '$status' for $Today$fanout"
}

# ---------------------------------------------------------------- dispatch --

switch ($Command) {
  "dedup" { Invoke-DedupCommand; break }
  "companies" { Invoke-CompaniesCommand; break }
  "known" { Invoke-KnownCommand; break }
  "leads" { Invoke-LeadsCommand; break }
  "screened" { Invoke-ScreenedCommand; break }
  { $_ -eq "verified" -or $_ -eq "delist" } { Invoke-UrlReportCommand; break }
  "swept" { Invoke-SweptCommand; break }
  "run" { Invoke-RunCommand; break }
  default {
      Fail "unknown command '$Command' - one of: dedup, companies, known, leads, screened, verified, delist, swept, run"
  }
}

exit 0
