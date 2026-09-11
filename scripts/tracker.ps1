<#
.SYNOPSIS
  The tracker API's calling convention, as commands a nightly search run
  invokes - instead of composing every HTTP call itself from prose.

.DESCRIPTION
  Materialized into each run's working directory by run-search.ps1, alongside
  that person's documents, and invoked from the prompt as
  `./tracker <command> [file]`.

  ---- Why this exists.

  The composed prompt used to carry the whole calling convention as text: a
  curl invocation per endpoint, the JSON body's shape, what each field meant,
  and a warning for every way the body could come out wrong. That was about
  15,000 characters - half the prompt's fixed text - read by four scheduled
  runs a night to describe six HTTP calls that never change. See
  docs/prompt-size-plan.md.

  It was also prose asking for something only code can guarantee. "`search`
  must be this run's own key", "`on` is today's *local* date, not the server's
  UTC one", "report by url, never by id", "omit the key rather than sending an
  empty string" - each has exactly one right answer, and each was restated
  every night in the hope the model applied it. All of them are decided here
  now, from the run's own environment, and none of them can be got wrong by a
  run having a bad night.

  What is left for the prompt is what only the run knows: which postings are
  new, which it confirmed dead, which companies it managed to read.

  ---- What it deliberately does not do.

  It makes no judgement about the search. It will not invent a lead, drop one
  for looking wrong, or turn an unreadable page into a delisting. A row it
  refuses is refused loudly - named on stdout and counted in the summary line -
  never dropped quietly, because the run writes its own report from what this
  prints.

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

  Each <file> is a JSON array (an object carrying the array under the command's
  own name is accepted too, since that is the shape the old prompt's curl body
  had). An empty array is a no-op that says so and exits 0, so a step with
  nothing to send needs no conditional in the prompt.

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

# Today, in the timezone the run is actually happening in. This was the single
# most repeated instruction in the old prompt ("`on` is today's **local**
# date") and the one with the worst failure mode: an evening run that let the
# server fall back to UTC stamped its rows with tomorrow and then recorded
# having found nothing. Nothing asks a run for a date any more.
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
# Cloudflare answers a Worker *exception* with a 5xx whose body is
# `error code: 1101`. It is not a 429, not a 404, and it says nothing about the
# request: three consecutive GETs got one on 2026-09-10 during rapid sequential
# calls, and every one of them succeeded on the very next attempt. Unretried,
# that fails a sync step with nothing wrong with it, in the middle of an
# unattended run, with nobody awake to see that the failure was spurious.
#
# Which statuses are transient is decided here, once, by number - not by
# reading an error message and forming an opinion about it per call:
#
#   retry   no status at all (the connection never got an answer: reset, DNS,
#           timeout), 429, and any other 5xx - which is where 1101 lands.
#   stop    503, and every 4xx except 429. A 4xx is the server saying the
#           request itself is wrong, and it will be exactly as wrong in twelve
#           seconds; retrying only turns a clear error into a slow one. 503 is
#           excluded from the 5xx rule on this API's own terms - it is what a
#           handler returns when the deployment is missing a binding, where
#           "the fix is a config change rather than a retry" (see
#           ../server/src/routes/documents.js).
#
# Replaying a POST has to be safe, and it is for every endpoint reached from
# here. That is a precondition rather than a happy accident, because a retry
# cannot tell "the request never landed" from "it landed and the response was
# lost":
#
#   /api/leads, /api/screened    dedup by url and report the duplicates back
#   /api/verified, /api/delist   are keyed by url and idempotent
#   /api/coverage                upserts by company, and *sets* the sweep
#                                cursor from the positions reported rather
#                                than incrementing it (db.js setSweepCursor)
#   /api/runs                    upserts on (user, track)
#
# So the worst a replay costs is a duplicate counted in this command's own
# output line, never a duplicate row. An endpoint that is not idempotent does
# not belong on this path without an idempotency key of its own.
#
# Worst case is 19s of sleeping on one call, and a run makes eight of them.
# That is the right trade for a job that has all night and nobody watching.
$RetryAttempts = 4
$RetryBackoff = @(2, 5, 12)

function Test-Transient($status) {
    if ($status -eq 503) { return $false }
    return ($status -eq 0 -or $status -eq 429 -or $status -ge 500)
}

# One line's worth of an error body. A 1101 arrives as a whole HTML error page,
# and the retry lines are progress reporting rather than the diagnosis - the
# last attempt's Fail prints the body in full.
function Squish($text) {
    if (-not $text) { return "" }
    $one = ($text -replace "\s+", " ").Trim()
    if ($one.Length -gt 160) { return $one.Substring(0, 160) + "..." }
    return $one
}

function Invoke-Tracker($method, $path, $bodyObj) {
    $uri = "$Base$path"
    $headers = @{ Authorization = "Bearer $Token" }
    # Encoded once, outside the retry loop. It cannot change between attempts,
    # and re-encoding per attempt is one more way the request that replaces a
    # failed one could differ from it.
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
                # How many attempts it took is part of the error. A step that
                # failed four times over twenty seconds and one that failed
                # once are different problems, and this log line is all anyone
                # has the next morning.
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

# Rows as the run wrote them. A bare array is the documented shape; an object
# carrying the array under the command's own name is accepted too, because that
# is what the previous prompt's `-d '{"leads":[...]}'` body looked like and a
# run that writes one is not wrong about anything that matters.
function Read-Rows($path, $key) {
    if (-not $path) { Fail "'$Command' needs a file: tracker $Command <file>.json" }
    if (-not (Test-Path -LiteralPath $path)) {
        # Not treated as "nothing to send". A mistyped filename and a quiet
        # night look identical from here, and only one of them silently
        # discards the run's findings.
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

# A row that cannot be sent is named and counted, never dropped in silence.
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
          # Every rule the prompt used to state: this run's key unless the row
          # names one of the tabs the run fills, today's local date once for the
          # whole call, and an unstated optional field omitted rather than sent
          # as an empty string.
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
          # `endpoint` and `url_shape` travel to the shared company_fetch table
          # and benefit every search on the deployment; `board` does too; `note`
          # stays in this search's own row (see routes/coverage.js for which
          # fields cross that boundary and why prose does not).
          #
          # They were missing from this list until 2026-09-11, which is the
          # whole reason the shared table was broad and shallow: 58 of its 63
          # rows had a board kind and no endpoint, because the only two fields
          # a run could send were the two that were already duplicated
          # elsewhere. A field the API accepts and the helper drops is a field
          # that does not exist.
          #
          # `wall` travels too: what stops a fetch at this company, pooled and
          # expired by the server (docs/one-company-list-plan.md). It goes in
          # this list in the same change as the server column, never before.
          # handleRecordSweeps reads fields by name, so a `wall` sent to a
          # server without the column is dropped silently - and because the
          # prompt stops putting the obstacle in `note`, it would be lost
          # outright rather than merely left unpooled.
          #
          # `dead_signal` is deliberately still not passed - see prompt.js's
          # step 9d.
          foreach ($f in @("board", "endpoint", "url_shape", "wall", "note")) {
              $v = Field $r $f
              if ($v) { $row[$f] = $v }
          }
          # A row that records a wall is a fetch that failed; board, endpoint
          # and url_shape each assert one that worked. They cannot both be true
          # of tonight, so the worked-fields go and the wall stays.
          #
          # This is not stricter than the server - it is the only way the wall
          # survives at all. upsertCompanyFetch clears a company's wall whenever
          # a board or endpoint is reported (db.js, `works`), so a row carrying
          # both erases the wall it records in the same write. And the board on
          # such a row is almost always an echo: companies.json hands every run
          # the board it already knows, which is exactly the report that would
          # delete a true wall. The server cannot tell an echo from a
          # confirmation, and neither can this - but a row that also says the
          # fetch failed has answered the question itself.
          #
          # url_shape does not clear a wall, but it does move verified_on, so an
          # echoed one would claim a freshness nobody established.
          if ($row.ContainsKey("wall")) {
              $echoed = @("board", "endpoint", "url_shape") | Where-Object { $row.ContainsKey($_) }
              if ($echoed) {
                  foreach ($f in $echoed) { $row.Remove($f) }
                  Say "dropped $($echoed -join '/') from $company - that row also reports a wall, and a reported board or endpoint would clear the wall in the same write"
              }
          }
          $send += $row
      }
      if ($send.Count -eq 0) { Say "swept: nothing to record (refused=$($script:Refused))"; exit 0 }
      $res = Invoke-Tracker "POST" "/api/coverage" @{ search = $Search; on = $Today; swept = @($send) }
      Say "swept: recorded=$($res.recorded) excluded=$($res.excluded) refused=$($script:Refused) cursor=$($res.cursor) on=$Today"
      break
  }

  "run" {
      # Status and note are taken from flags or from the positional arguments,
      # so neither spelling of the one call that must never be skipped can fail
      # on its arguments.
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
