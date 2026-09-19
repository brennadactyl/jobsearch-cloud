<#
.SYNOPSIS
  Creates (or refreshes) the tracker's demonstration account and fills it with
  fabricated job-search data.

.DESCRIPTION
  Writes the invented data in demo-user.json through the public API only, so the
  account can only be in a state the API could have produced. The account is
  marked as a demo, and the server refuses to mint a search token for a demo
  account, so no scheduled search can ever run as it.

  Dates are stored as day offsets; re-run with -Force to move them to today.
  Re-seeding an account that holds data needs -Force, which deletes its
  application rows and purges its searches' leads and screened rows, only after
  checking that every lead is an example.com URL.

  See README.md, "The demo account".

.PARAMETER AdminToken
  The deployment's ADMIN_TOKEN worker secret, which creates accounts (see
  server/README.md). Defaults to the TRACKER_ADMIN_TOKEN environment variable,
  then to admin_token in <DataDir>\deployment.json. Not a session token; no
  search or browser holds it.

.PARAMETER TrackerUrl
  The API worker's base URL, e.g. https://job-search-tracker.<subdomain>.workers.dev.
  Defaults to the TRACKER_URL environment variable, then to url in
  <DataDir>\deployment.json.

.PARAMETER DataDir
  The private data folder whose deployment.json fills in whichever of the two
  above is still missing (see private.example/README.md). Defaults to
  JOB_SEARCH_DATA_DIR, then <repo>\private.

.PARAMETER Password
  The demo account's password, 12+ characters. Omitted, one is generated and
  printed at the end. A password that already signs in changes no credential;
  any other, including a generated one, resets the account's password.

.PARAMETER DataFile
  The invented data to load. Defaults to demo-user.json next to this script.

.PARAMETER Force
  Required to re-seed an account that already has data. Deletes its application
  rows and purges its searches before recreating them, after the example.com
  check above.

.EXAMPLE
  .\seed-demo-user.ps1 -Force

.EXAMPLE
  .\seed-demo-user.ps1 -AdminToken $env:TRACKER_ADMIN_TOKEN

.EXAMPLE
  .\seed-demo-user.ps1 -Password "show-and-tell-account" -Force
#>
param(
    [string]$AdminToken = $env:TRACKER_ADMIN_TOKEN,

    [string]$TrackerUrl = $env:TRACKER_URL,

    [string]$Password,

    [string]$DataFile,

    [string]$DataDir,

    [switch]$Force
)

$ErrorActionPreference = "Stop"

# A param default is evaluated before $PSScriptRoot is reliably set, so the
# script's own folder, which is where demo-user.json sits, is resolved here.
# The same three lines resolve the script folder in every scripts/*.ps1 that needs it; change them together.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
             else { "" }
if (-not $DataFile) {
    if (-not $scriptDir) {
        throw "Can't work out where this script lives, so it can't find demo-user.json. Pass -DataFile, or run it by its full path."
    }
    $DataFile = Join-Path $scriptDir "demo-user.json"
}

# --------------------------------------------------------------- preflight --

# The operator's machine already records the deployment in deployment.json, as
# new-invite.ps1 reads it, so the URL and token come from there unless passed
# in. Only a value still missing is read, and the token is never printed.
if (-not $TrackerUrl -or -not $AdminToken) {
    if (-not $DataDir) {
        $DataDir = if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR }
                   elseif ($scriptDir) { Join-Path $scriptDir "..\private" }
                   else { "" }
    }
    $deploymentFile = if ($DataDir) { Join-Path $DataDir "deployment.json" } else { "" }
    if ($deploymentFile -and (Test-Path $deploymentFile)) {
        $deployment = Get-Content -Raw -Path $deploymentFile | ConvertFrom-Json
        if (-not $TrackerUrl) { $TrackerUrl = $deployment.url }
        if (-not $AdminToken) { $AdminToken = $deployment.admin_token }
    }
}

if (-not $TrackerUrl) {
    Write-Error "No tracker URL. Pass -TrackerUrl, set TRACKER_URL, or put url in <DataDir>\deployment.json (see private.example/README.md)."
    exit 1
}
$TrackerUrl = $TrackerUrl.TrimEnd("/")

if (-not $AdminToken) {
    Write-Error "No admin token. Pass -AdminToken, set TRACKER_ADMIN_TOKEN, or put admin_token in <DataDir>\deployment.json.`nIt's the ADMIN_TOKEN worker secret from the API deployment - see server/README.md. Creating an account is the one thing a session token cannot do."
    exit 1
}

if (-not (Test-Path $DataFile)) {
    Write-Error "Data file not found: $DataFile"
    exit 1
}
$data = Get-Content -Raw -Path $DataFile -Encoding UTF8 | ConvertFrom-Json

if ($Password) {
    # The server's floor (PASSWORD_MIN_LENGTH in server/src/auth.js, which lists every copy).
    if ($Password.Length -lt 12) {
        Write-Error "The API requires a password of at least 12 characters."
        exit 1
    }
} else {
    # No look-alike characters (0/O, 1/l/I): the password is read off the screen.
    $alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Password = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

$demoName = $data.user.name

# ------------------------------------------------------------------ helpers --

# Invoke-RestMethod discards the body of a non-2xx response, and that body holds
# the API's error message, so it is read back off the stream.
function Invoke-Api {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Token,
        $Body,
        [string]$What,
        # For the speculative sign-in, where a 401 means the account doesn't
        # exist yet.
        [switch]$AllowFailure
    )

    $headers = @{}
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }

    $req = @{
        Uri     = "$TrackerUrl$Path"
        Method  = $Method
        Headers = $headers
    }
    if ($null -ne $Body) {
        # Sent as UTF-8 bytes: PowerShell 5.1 would encode a string body in the
        # console's codepage and mangle non-ASCII characters.
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        $req["Body"] = [System.Text.Encoding]::UTF8.GetBytes($json)
        $req["ContentType"] = "application/json; charset=utf-8"
    }

    try {
        return Invoke-RestMethod @req
    } catch {
        if ($AllowFailure) { return $null }
        $status = ""
        $detail = $_.Exception.Message
        if ($_.Exception.Response) {
            $status = $_.Exception.Response.StatusCode.value__
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $raw = $reader.ReadToEnd()
                if ($raw) { $detail = $raw }
            } catch { }
        }
        $label = $What
        if (-not $label) { $label = "$Method $Path" }
        Write-Error "$label failed ($status): $detail"
        exit 1
    }
}

# Local date, not UTC: every `on`/`found`/`date` field in this API is the
# caller's own day.
function DaysAgo([int]$n) { (Get-Date).AddDays(-$n).ToString("yyyy-MM-dd") }
function DaysAhead([int]$n) { (Get-Date).AddDays($n).ToString("yyyy-MM-dd") }

function Say($msg) { Write-Host $msg }

# ------------------------------------------------------- account + session --

Say "Tracker:   $TrackerUrl"
Say "Account:   $demoName"
Say "Data file: $DataFile"
Say ""

# Sign in first and provision only if that fails: POST /api/users is
# create-or-reset, so calling it unconditionally would reset the password of any
# existing account with this name, including a real person's.
$loginBody = @{ name = $demoName; password = $Password; label = "demo-seed" }
$session = Invoke-Api -Method POST -Path "/api/login" -Body $loginBody -AllowFailure
$passwordWasReset = $false

if ($session) {
    $userId = $session.user.id
    Say "Signed in to the existing account $demoName ($userId)."
} else {
    $account = Invoke-Api -Method POST -Path "/api/users" -Token $AdminToken -What "Creating the demo account" -Body @{
        name     = $demoName
        password = $Password
    }
    $userId = $account.id
    if ($account.created) {
        Say "Created account $demoName ($userId)."
    } else {
        # The name existed and the password didn't match, so this was a reset:
        # the one change already made if the safeguards below refuse the account.
        $passwordWasReset = $true
        Say "Account $demoName ($userId) already existed - its password has been reset to the one below."
    }
    $session = Invoke-Api -Method POST -Path "/api/login" -What "Signing in as $demoName" -Body $loginBody
}
$token = $session.token

# ------------------------------------------------- existing-data safeguards --

$existing = Invoke-Api -Method GET -Path "/api/data" -Token $token -What "Reading the account's current contents"
$existingLeads = @($existing.leads)
$existingApps = @($existing.applications)

if (($existingLeads.Count -gt 0 -or $existingApps.Count -gt 0) -and -not $Force) {
    Write-Error @"
$demoName already holds $($existingLeads.Count) leads and $($existingApps.Count) applications.

Re-run with -Force to refresh it. -Force deletes the account's rows and
recreates them: application rows because nothing dedups them, and leads and
screened rows because they dedup by URL, so re-posting them would keep the
dates they were first seeded with.
"@
    exit 1
}

if ($Force -and ($existingApps.Count -gt 0 -or $existingLeads.Count -gt 0)) {
    # This script only writes example.com postings, so a lead on any other host
    # means a real person's account. Refuse before deleting a single row.
    $real = @($existingLeads | Where-Object { $_.url -notmatch '(^|\.)example\.com/' })
    if ($real.Count -gt 0) {
        $resetWarning = ""
        if ($passwordWasReset) {
            $resetWarning = @"

One change did land before this check: the sign-in failed, so the account was
provisioned, and POST /api/users on an existing name is a password reset. That
account's password is now the one this run used. Set it back with the same
route and the ADMIN_TOKEN if you know what it was.
"@
        }
        Write-Error @"
Refusing to touch this account: it holds $($real.Count) lead(s) that this script did not write,
the first being "$($real[0].company) - $($real[0].title)" at $($real[0].url).

Every posting this script creates is an example.com URL. A real one means "$demoName"
is not the demo account on this deployment, and -Force would have deleted real
application records. No rows have been changed.$resetWarning
"@
        exit 1
    }

    Say "Removing $($existingApps.Count) existing application row(s) before reseeding..."
    foreach ($app in $existingApps) {
        Invoke-Api -Method POST -Path "/api/delete-application" -Token $token -What "Deleting application $($app.id)" -Body @{ id = $app.id } | Out-Null
    }

    # A purge refuses a key that is still a configured track, so the track list
    # is swapped for a placeholder first. The config post below replaces it.
    $placeholder = "reseeding"
    $keys = @(@($existing.tracks | ForEach-Object { $_.key }) + @($existingLeads | ForEach-Object { $_.search }) +
        @($existing.screened | ForEach-Object { $_.search }) | Where-Object { $_ -and $_ -ne $placeholder } | Sort-Object -Unique)
    if ($keys.Count -gt 0) {
        Invoke-Api -Method POST -Path "/api/config" -Token $token -What "Retiring the tracks to purge them" -Body @{
            tracks = @(@{ key = $placeholder; label = "Reseeding"; full_description = "Replaced when the seed finishes" })
        } | Out-Null
        foreach ($key in $keys) {
            Invoke-Api -Method POST -Path "/api/purge" -Token $AdminToken -What "Purging search $key" -Body @{ user = $demoName; search = $key } | Out-Null
        }
        Say "Purged $($keys.Count) search(es), so every lead and screened row is re-dated."
    }
}

# ------------------------------------------------------------- demo marker --

# The demo mark keeps this account off the company list every account shares,
# and the server never mints a demo account a search token, so nothing can run
# a search as it.
# It is set only after the example.com check, never on the create-or-reset call
# above, which can land on a real person named Demo. Resending the password this
# run signed in with changes no credential and keeps sessions.
$notOurs = @($existingLeads | Where-Object { $_.url -notmatch '(^|\.)example\.com/' })
if ($notOurs.Count -gt 0) {
    Write-Warning "Not marking $demoName as a demo account: it holds $($notOurs.Count) lead(s) on hosts other than example.com, so it may be a person's."
} else {
    Invoke-Api -Method POST -Path "/api/users" -Token $AdminToken -What "Marking the account as a demo" -Body @{
        name     = $demoName
        password = $Password
        demo     = $true
    } | Out-Null
    Say "Marked $demoName as a demo account - it cannot write to the shared company list."
}

# ------------------------------------------------------------------- config --

# `tracks` replaces the whole list (server/README.md), which suits a data file
# that is the account's complete definition.
$configBody = @{ tracks = @($data.tracks) }
foreach ($prop in $data.settings.PSObject.Properties) {
    $configBody[$prop.Name] = $prop.Value
}
Invoke-Api -Method POST -Path "/api/config" -Token $token -What "Posting the track and page config" -Body $configBody | Out-Null
Say "Configured $(@($data.tracks).Count) tracks and the page settings."

# --------------------------------------------------------------- coverage --

# Deliberately nothing: every account's searches draw from one company list, so
# invented companies on it would send real nightly runs looking for them. The
# server refuses a demo account's POST /api/coverage in any case.

# ------------------------------------------------------------------- leads --

$leadPayload = @()
foreach ($lead in $data.leads) {
    $row = @{
        search   = $lead.search
        company  = $lead.company
        title    = $lead.title
        location = $lead.location
        url      = $lead.url
        fit      = $lead.fit
        found    = DaysAgo $lead.foundDaysAgo
        verified = DaysAgo $lead.verifiedDaysAgo
    }
    # `area` is the ranked place the lead falls in, written down in the data file
    # rather than worked out from the location, and the page tiers by it. The
    # server keeps it only if it is one of settings.priority_locations' entries.
    foreach ($f in @("area", "team", "setup", "comp")) {
        if ($lead.PSObject.Properties[$f]) { $row[$f] = $lead.$f }
    }
    $leadPayload += $row
}
$added = Invoke-Api -Method POST -Path "/api/leads" -Token $token -What "Adding leads" -Body @{ leads = $leadPayload }
Say "Leads: $($added.added) added, $($added.duplicates) already present."

# ---------------------------------------------------------------- screened --

$screenedPayload = @()
foreach ($item in $data.screened) {
    $screenedPayload += @{
        search   = $item.search
        company  = $item.company
        title    = $item.title
        location = $item.location
        url      = $item.url
        reason   = $item.reason
        date     = DaysAgo $item.daysAgo
    }
}
$screenedResult = Invoke-Api -Method POST -Path "/api/screened" -Token $token -What "Adding screened postings" -Body @{ screened = $screenedPayload }
Say "Screened: $($screenedResult.added) added, $($screenedResult.duplicates) already present."

# ------------------------------------------------- lead notes and statuses --

# /api/leads inserts every lead as "New" with empty notes, so statuses and notes
# are a second pass through the routes the webpage uses.
$current = Invoke-Api -Method GET -Path "/api/data" -Token $token -What "Reading back the seeded leads"
$leadIdByUrl = @{}
foreach ($lead in $current.leads) { $leadIdByUrl[$lead.url] = $lead.id }

$statusCount = 0
foreach ($lead in $data.leads) {
    $id = $leadIdByUrl[$lead.url]
    if (-not $id) {
        Write-Warning "No lead id came back for $($lead.url) - skipping its status and notes."
        continue
    }

    # Notes first: moving a lead to "Applied" copies them onto the application
    # row it creates.
    $notes = ""
    if ($lead.PSObject.Properties["notes"]) { $notes = $lead.notes }
    if ($notes) {
        Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Setting notes on lead $id" -Body @{
            type  = "lead"
            id    = $id
            notes = $notes
        } | Out-Null
    }

    if ($lead.status -eq "New") { continue }

    if ($lead.status -eq "Applied") {
        # Not /api/update: only this route creates the application row with the
        # status change.
        Invoke-Api -Method POST -Path "/api/leads/$id/status" -Token $token -What "Marking lead $id applied" -Body @{ status = $lead.status } | Out-Null
    } else {
        Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Setting status on lead $id" -Body @{
            type   = "lead"
            id     = $id
            status = $lead.status
        } | Out-Null
    }
    $statusCount++
}
Say "Set the status on $statusCount leads."

# ------------------------------------------------------------ applications --

# Re-read for the ids of the application rows the "Applied" statuses created.
$current = Invoke-Api -Method GET -Path "/api/data" -Token $token -What "Reading back the created applications"
$appByLeadId = @{}
foreach ($app in $current.applications) {
    if ($app.leadId) { $appByLeadId[[string]$app.leadId] = $app.id }
}

$appCount = 0
foreach ($spec in $data.applications) {
    if ($spec.PSObject.Properties["leadUrl"]) {
        $leadId = $leadIdByUrl[$spec.leadUrl]
        if (-not $leadId) {
            Write-Warning "No lead for $($spec.leadUrl) - skipping its application."
            continue
        }
        $appId = $appByLeadId[[string]$leadId]
        if (-not $appId) {
            Write-Warning "Lead $leadId has no application row - skipping."
            continue
        }
    } else {
        # An application made from a lead copies the lead's area. One added by
        # hand can only be given its area here, when the row is created.
        $createBody = @{
            type    = "application"
            company = $spec.company
            title   = $spec.title
        }
        if ($spec.PSObject.Properties["area"]) { $createBody["area"] = $spec.area }
        $created = Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Adding the $($spec.company) application" -Body $createBody
        $appId = $created.application.id
    }

    # dateApplied is set here because the status walk below stamps only a blank
    # column, and the row was created with today's date.
    $patch = @{ type = "application"; id = $appId }
    foreach ($f in @("company", "title", "link", "source", "referral", "comp", "notes")) {
        if ($spec.PSObject.Properties[$f]) { $patch[$f] = $spec.$f }
    }
    if ($spec.PSObject.Properties["nextAction"]) {
        $patch["nextAction"] = $spec.nextAction
        $patch["nextActionDate"] = DaysAhead $spec.nextActionDaysAhead
    }
    $appliedStage = @($spec.stages | Where-Object { $_.status -eq "Applied" })
    if ($appliedStage.Count -gt 0) { $patch["dateApplied"] = DaysAgo $appliedStage[0].daysAgo }
    Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Filling in application $appId" -Body $patch | Out-Null

    # One status call per stage, in order: each call stamps that stage's date
    # column, so the history comes from the same route the page uses.
    foreach ($stage in $spec.stages) {
        $body = @{ status = $stage.status }
        if ($stage.PSObject.Properties["daysAgo"]) { $body["date"] = DaysAgo $stage.daysAgo }
        Invoke-Api -Method POST -Path "/api/applications/$appId/status" -Token $token -What "Advancing application $appId to $($stage.status)" -Body $body | Out-Null
    }
    $appCount++
}
Say "Built $appCount applications with their stage histories."

# -------------------------------------------------------------- run records --

# Without a run record every tab reads "No run recorded yet". One post per
# searching track; the server fans it out to the tabs that track feeds.
foreach ($run in $data.runs) {
    $result = Invoke-Api -Method POST -Path "/api/runs" -Token $token -What "Recording a run for $($run.search)" -Body @{
        search = $run.search
        status = $run.status
        note   = $run.note
        on     = (Get-Date).ToString("yyyy-MM-dd")
    }
    $tabs = 1 + @($result.also).Count
    Say "Recorded a run for $($run.search) across $tabs tab(s)."
}

# ------------------------------------------------------------------ summary --

Say ""
Say "Done. The demo account is ready."
Say ""
Say "  User id:  $userId"
Say "  Name:     $demoName"
Say "  Password: $Password"
Say ""
Say "Sign in at the tracker page with that name and password."
Say "The password is not stored anywhere - note it down now, or re-run this"
Say "script with -Password to set one of your own."
Say ""
if ($notOurs.Count -eq 0) {
    Say "This account is marked as a demo, so the server will never mint it a"
    Say "search token: no scheduled search can run as it, and it can't write to the"
    Say "shared company list."
} else {
    Say "This account was NOT marked as a demo (see the warning above), so nothing"
    Say "stops a search token being minted for it."
}
Say "Re-run this script with -Force to refresh the dates."
