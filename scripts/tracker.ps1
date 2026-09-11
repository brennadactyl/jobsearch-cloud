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

function Say($msg) { [Console]::Out.WriteLine("tracker: $msg") }

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

# --------------------------------------------------------------- arguments --

# Parsed by hand rather than through param(): the prompt writes `--status ok`,
# and PowerShell binds only single-dash names, so `--status` would arrive as a
# positional value and silently take the place of something else.
$Command = ""
$File = ""
$Opts = @{}
$rest = @($args)
for ($i = 0; $i -lt $rest.Count; $i++) {
    $a = [string]$rest[$i]
    if ($a -match "^--?([A-Za-z][A-Za-z0-9-]*)$") {
        $name = $Matches[1].ToLowerInvariant()
        $value = ""
        if (($i + 1) -lt $rest.Count -and ([string]$rest[$i + 1]) -notmatch "^--[A-Za-z]") {
            $value = [string]$rest[$i + 1]
            $i++
        }
        $Opts[$name] = $value
    } elseif (-not $Command) {
        $Command = $a.ToLowerInvariant()
    } elseif (-not $File) {
        $File = $a
    } else {
        Fail "unexpected extra argument '$a' - usage: tracker <command> [file]"
    }
}
if ($Opts.ContainsKey("search") -and $Opts["search"]) { $Search = $Opts["search"] }

if (-not $Command) {
    Fail "no command given - one of: dedup, companies, leads, screened, verified, delist, swept, run"
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
function Squish($text) {
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
            Say "$method $path failed ($status) - transient, retrying in ${wait}s (attempt $attempt of $RetryAttempts): $(Squish $detail)"
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

function Field($row, $name) {
    if ($null -eq $row) { return "" }
    if ($row -is [string]) { return "" }
    if ($row.PSObject.Properties.Name -notcontains $name) { return "" }
    $v = $row.$name
    if ($null -eq $v) { return "" }
    return ([string]$v).Trim()
}

$script:Refused = 0
function Refuse($what, $why) {
    $script:Refused++
    Say "refused $what - $why"
}

function OutPath($fallback) {
    if ($Opts.ContainsKey("out") -and $Opts["out"]) { return $Opts["out"] }
    return $fallback
}

# ---------------------------------------------------------------- commands --

switch ($Command) {

  # The tabs this run fills, read from the config rather than named in an
  # argument. A branched search fills its own tab plus every track whose
  # `fed_by` points at it; asking the server which those are keeps the prompt
  # from listing them and keeps the list from going stale.
  "dedup" {
      $keys = @($Search)
      $config = Invoke-Tracker "GET" "/api/config" $null
      # `| Where-Object { $_ }` throughout, because @($null) in PowerShell is a
      # one-element array holding $null - a foreach over an absent property
      # runs once on nothing rather than not at all.
      foreach ($t in @($config.tracks | Where-Object { $_ })) {
          if ($t.fed_by -eq $Search -and $t.key -ne $Search) { $keys += $t.key }
      }

      $leads = @()
      $screened = @()
      $seen = @{}
      foreach ($k in $keys) {
          $d = Invoke-Tracker "GET" "/api/dedup/$k" $null
          foreach ($l in @($d.leads | Where-Object { $_ })) {
              # No `id`. Nothing a run posts back is keyed by one, and a lead id
              # in front of a model is an invitation to report by it.
              $leads += [pscustomobject]@{ url = $l.url; status = $l.status; search = $k }
          }
          foreach ($u in @($d.screened | Where-Object { $_ })) {
              if (-not $seen.ContainsKey($u)) { $seen[$u] = $true; $screened += $u }
          }
      }

      $out = OutPath "dedup.json"
      Write-Json $out ([pscustomobject]@{ leads = @($leads); screened = @($screened) })
      Say "dedup: $($leads.Count) tracked lead(s), $($screened.Count) screened url(s) across $($keys.Count) tab(s) -> $out"
      break
  }

  "companies" {
      $c = Invoke-Tracker "GET" "/api/coverage/$Search" $null
      $out = OutPath "companies.json"
      Write-Json $out $c
      Say "companies: $($c.batch) to cover tonight, $($c.cursor) of $($c.total) through the rotation -> $out"
      foreach ($co in @($c.companies | Where-Object { $_ })) {
          $line = "  $($co.company)"
          $board = Field $co "board"
          if ($board) { $line += " [$board]" }
          $note = Field $co "note"
          if ($note) { $line += " - $note" }
          Say $line
      }
      break
  }

  "leads" {
      $rows = Read-Rows $File "leads"
      $send = @()
      foreach ($r in $rows) {
          $url = Field $r "url"
          $company = Field $r "company"
          $title = Field $r "title"
          if (-not $url) { Refuse "a lead with no url" "there is nothing to track or dedup on"; continue }
          if (-not $company -or -not $title) { Refuse "$url" "a lead needs both a company and a title"; continue }
          $row = @{ search = $Search; company = $company; title = $title; url = $url }
          $rowSearch = Field $r "search"
          if ($rowSearch) { $row["search"] = $rowSearch }
          foreach ($f in @("location", "fit", "team", "setup", "comp")) {
              $v = Field $r $f
              if ($v) { $row[$f] = $v }
          }
          $send += $row
      }
      if ($send.Count -eq 0) { Say "leads: nothing to send (refused=$($script:Refused))"; exit 0 }
      $res = Invoke-Tracker "POST" "/api/leads" @{ on = $Today; leads = @($send) }
      Say "leads: added=$($res.added) duplicates=$($res.duplicates) excluded=$($res.excluded) refused=$($script:Refused) on=$Today"
      break
  }

  "screened" {
      $rows = Read-Rows $File "screened"
      $send = @()
      foreach ($r in $rows) {
          $url = Field $r "url"
          $reason = Field $r "reason"
          if (-not $url) { Refuse "a screened row with no url" "the url is what stops tomorrow re-verifying it"; continue }
          if (-not $reason) { Refuse "$url" "a screened row needs a reason - it is the whole value of the entry"; continue }
          $row = @{ search = $Search; url = $url; reason = $reason }
          foreach ($f in @("company", "title", "location")) {
              $v = Field $r $f
              if ($v) { $row[$f] = $v }
          }
          $send += $row
      }
      if ($send.Count -eq 0) { Say "screened: nothing to send (refused=$($script:Refused))"; exit 0 }
      $res = Invoke-Tracker "POST" "/api/screened" @{ search = $Search; on = $Today; screened = @($send) }
      Say "screened: added=$($res.added) duplicates=$($res.duplicates) excluded=$($res.excluded) refused=$($script:Refused) on=$Today"
      break
  }

  { $_ -eq "verified" -or $_ -eq "delist" } {
      $rows = Read-Rows $File "urls"
      $urls = @()
      $seen = @{}
      foreach ($r in $rows) {
          $u = ""
          if ($r -is [string]) { $u = ([string]$r).Trim() } else { $u = Field $r "url" }
          if (-not $u) { Refuse "an entry with no url" "both reports are by url - there are no ids here"; continue }
          if ($seen.ContainsKey($u)) { continue }
          $seen[$u] = $true
          $urls += $u
      }
      if ($urls.Count -eq 0) { Say "${Command}: nothing to report (refused=$($script:Refused))"; exit 0 }
      # `search` is this run's own key in both calls, including for a posting
      # tracked in another tab this run fills: the tracker matches a url against
      # every lead this person has, whatever tab holds it.
      $path = "/api/verified"
      if ($Command -eq "delist") { $path = "/api/delist" }
      $res = Invoke-Tracker "POST" $path @{ search = $Search; on = $Today; urls = @($urls) }
      if ($Command -eq "delist") {
          Say "delist: removed=$($res.removed) kept=$($res.kept) unmatched=$($res.unmatched) on=$Today"
      } else {
          Say "verified: stamped=$($res.stamped) unmatched=$($res.unmatched) on=$Today"
      }
            foreach ($u in @($res.unmatchedUrls | Where-Object { $_ })) { Say "  no lead matches $u" }
      break
  }

  "swept" {
      $rows = Read-Rows $File "swept"
      $send = @()
      foreach ($r in $rows) {
          $company = ""
          if ($r -is [string]) { $company = ([string]$r).Trim() } else { $company = Field $r "company" }
          if (-not $company) { Refuse "a sweep with no company" "there is nothing to stamp"; continue }
          $row = @{ company = $company }
          # `board`, `endpoint`, `url_shape` and `wall` go to the shared
          # company_fetch table used by every search on the deployment; `note`
          # stays in this search's own row (see routes/coverage.js). The server
          # reads fields by name and drops the rest, so a new field is added
          # here in the same change as its server column. `dead_signal` is
          # deliberately not sent - see prompt.js's step 9d.
          foreach ($f in @("board", "endpoint", "url_shape", "wall", "note")) {
              $v = Field $r $f
              if ($v) { $row[$f] = $v }
          }
          # A `wall` plus a `board` or `endpoint` contradicts itself: the wall
          # says no route to the listings worked, the board or endpoint says one
          # did. The row is sent exactly as written and the server, which
          # applies this rule for every caller, shares nothing from it; this
          # only warns. `url_shape` is not part of the contradiction - it
          # describes a posting page, not a route to the listings.
          if ($row.ContainsKey("wall") -and ($row.ContainsKey("board") -or $row.ContainsKey("endpoint"))) {
              Say "WARNING: $company reports a wall and a working board/endpoint in one row, which contradicts itself. If any route to its listings worked, re-send it without the wall; if none did, re-send it without the board/endpoint."
          }
          $send += $row
      }
      if ($send.Count -eq 0) { Say "swept: nothing to record (refused=$($script:Refused))"; exit 0 }
      $res = Invoke-Tracker "POST" "/api/coverage" @{ search = $Search; on = $Today; swept = @($send) }
      # `added`: companies this call put on the shared list, which every search
      # sweeps. `withheld`: rows the server shared nothing from because of the
      # wall contradiction. It should equal the WARNING count above - both apply
      # the same test, and a field is only in a row when non-empty - so a
      # mismatch means the rule has drifted between here and handleRecordSweeps.
      Say "swept: recorded=$($res.recorded) added=$($res.added) withheld=$($res.withheld) excluded=$($res.excluded) refused=$($script:Refused) cursor=$($res.cursor) on=$Today"
      break
  }

  "run" {
      # Status is taken from --status or a positional argument, so the one call
      # that must never be skipped cannot fail on how it is spelled.
      $status = "ok"
      if ($Opts.ContainsKey("status") -and $Opts["status"]) { $status = $Opts["status"].ToLowerInvariant() }
      elseif ($File) { $status = $File.ToLowerInvariant() }
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
      Say "run: recorded $Search as '$status' for $Today$fanout"
      break
  }

  default {
      Fail "unknown command '$Command' - one of: dedup, companies, leads, screened, verified, delist, swept, run"
  }
}

exit 0
