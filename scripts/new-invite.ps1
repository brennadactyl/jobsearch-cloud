<#
.SYNOPSIS
  Makes an invite link to send someone, lists what became of the invites
  already made, or revokes one that hasn't been used.

.DESCRIPTION
  Adding a person is sending this link. They create their own account on the
  tracker page, describe their search and attach their resume, and the nightly
  run-onboarding.ps1 builds it (docs/onboarding.md).

  The code is shown once. The server stores only its hash, so a lost code is
  revoked and replaced, never looked up. An invite makes one account, can't
  touch an existing one, and expires after -Days.

  Reads the API URL, the ADMIN_TOKEN and the tracker page's URL from
  <DataDir>\deployment.json (see private.example/README.md). The token is sent
  to the API and never printed.

.PARAMETER Note
  Who the invite is for, in your own words, up to 200 characters. Shown in
  -List, never to them.

.PARAMETER Days
  How long the link stays good, from 1 to 30. Default 14.

.PARAMETER List
  Show every invite, newest first: its id, note, when it was made and expires,
  its state (open, used, expired or revoked), and the name and user id of the
  account a used one created. The user id names that person's folder in the
  data dir.

.PARAMETER Revoke
  The id of an invite, from -List, to stop working. A used invite can't be
  revoked, because its account already exists.

.EXAMPLE
  .\new-invite.ps1 -Note "Sam, from the climbing gym"

.EXAMPLE
  .\new-invite.ps1 -List

.EXAMPLE
  .\new-invite.ps1 -Revoke 7
#>
[CmdletBinding(DefaultParameterSetName = "Mint")]
param(
    [Parameter(ParameterSetName = "Mint", Mandatory = $true)][ValidateLength(0, 200)][string]$Note,
    [Parameter(ParameterSetName = "Mint")][ValidateRange(1, 30)][int]$Days = 14,
    [Parameter(ParameterSetName = "List", Mandatory = $true)][switch]$List,
    [Parameter(ParameterSetName = "Revoke", Mandatory = $true)][int]$Revoke,
    [string]$DataDir,
    [string]$DeploymentFile
)

$ErrorActionPreference = "Stop"

# A param default is evaluated before $PSScriptRoot is reliably set, so the
# script's own folder is resolved here instead. Otherwise running this by path
# from another directory fails inside Join-Path, naming a line rather than the
# folder it could not find.
# The same three lines resolve the script folder in every scripts/*.ps1 that needs it; change them together.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
             else { "" }
# A missing script folder is fine when -DataDir is given, so only a missing data folder is refused.
if (-not $DataDir) {
    $DataDir = if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR }
               elseif ($scriptDir) { Join-Path $scriptDir "..\private" }
               else { "" }
}
if (-not $DataDir) {
    throw "No data folder to read deployment.json from. Pass -DataDir, or set JOB_SEARCH_DATA_DIR. See private.example/README.md."
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# One file for the URL and the token together, so an operator credential can
# only ever go to the deployment it belongs to.
if (-not $DeploymentFile) { $DeploymentFile = Join-Path $DataDir "deployment.json" }
if (-not (Test-Path $DeploymentFile)) {
    throw "No deployment.json at $DeploymentFile - see private.example/README.md for what it holds."
}
$d = Get-Content $DeploymentFile -Raw | ConvertFrom-Json
if (-not $d.url) { throw "$DeploymentFile has no url." }
if (-not $d.admin_token) { throw "$DeploymentFile has no admin_token." }
$api = ([string]$d.url).TrimEnd("/")

# Cloudflare's browser-integrity check 403s some default user agents with
# "error code: 1010", which reads exactly like a rejected admin token.
$request = @{
    Headers   = @{ Authorization = "Bearer $($d.admin_token)" }
    UserAgent = "curl/8.0"
}

function Invoke-Api([string]$Method, [string]$Path, $Body) {
    $call = @{ Uri = "$api$Path"; Method = $Method } + $request
    if ($null -ne $Body) {
        # UTF-8 bytes: PowerShell 5.1 would send a string body in the console's
        # codepage and mangle a non-ASCII note.
        $call.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
        $call.ContentType = "application/json; charset=utf-8"
    }
    try {
        return Invoke-RestMethod @call
    } catch {
        $status = $null
        $message = $_.Exception.Message
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            # Invoke-RestMethod has usually drained the response stream by the
            # time it throws, and keeps the body in ErrorDetails instead.
            $raw = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else {
                try { (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch { "" }
            }
            if ($raw) {
                try {
                    $parsed = $raw | ConvertFrom-Json
                    $message = if ($parsed.error) { [string]$parsed.error } else { $raw }
                } catch { $message = $raw }
            }
        }
        if ($null -eq $status) {
            throw "Couldn't reach $api`: $message"
        }
        # The server resolves the caller before it matches a route, so a
        # deployment without the invite routes also answers 401.
        if ($status -eq 401) {
            throw ("The API refused the request (401). Check admin_token in $DeploymentFile matches the ADMIN_TOKEN secret on $api. " +
                   "If that server predates the invite routes, deploy server/ first.")
        }
        throw "The API answered $status`: $message"
    }
}

# Instants arrive as UTC; the operator reads them in their own time.
function Format-When([string]$iso) {
    if (-not $iso) { return "" }
    ([datetime]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime().ToString("yyyy-MM-dd HH:mm")
}

switch ($PSCmdlet.ParameterSetName) {
    "List" {
        $invites = @((Invoke-Api Get "/api/invites").invites)
        if ($invites.Count -eq 0) {
            Write-Host "No invites yet. Make one with: .\new-invite.ps1 -Note `"their name`""
            return
        }
        $invites | ForEach-Object {
            [pscustomobject]@{
                Id      = $_.id
                Note    = $_.note
                Created = Format-When $_.created_at
                Expires = Format-When $_.expires_at
                State   = $_.state
                Name    = $(if ($_.user) { $_.user.name })
                UserId  = $(if ($_.user) { $_.user.id })
            }
        } | Format-Table -AutoSize
    }

    "Revoke" {
        try {
            $res = Invoke-Api Post "/api/invites/revoke" @{ id = $Revoke }
        } catch {
            if ($_.Exception.Message -match "invite already used") {
                throw "Invite $Revoke has been used, so its account exists and revoking can't undo that. Find the account with -List."
            }
            throw
        }
        Write-Host "Invite $($res.id) is $($res.state). Its link no longer works."
    }

    "Mint" {
        $invite = Invoke-Api Post "/api/invites" @{ note = $Note; days = $Days }
        Write-Host ""
        if ($d.client_url) {
            Write-Host "Send them this link:" -ForegroundColor Green
            Write-Host ""
            Write-Host "  $(([string]$d.client_url).TrimEnd('/'))/?invite=$($invite.code)"
        } else {
            Write-Host "Invite code:" -ForegroundColor Green
            Write-Host ""
            Write-Host "  $($invite.code)"
            Write-Host ""
            Write-Host "Send them the tracker page's address with ?invite=<code> on the end."
            Write-Host "Add client_url to $DeploymentFile and this prints the whole link."
        }
        Write-Host ""
        Write-Host "Invite $($invite.id): one use, good until $(Format-When $invite.expires_at). This code can't be shown again." -ForegroundColor DarkGray
        Write-Host "Check on it with -List, or stop it with -Revoke $($invite.id)." -ForegroundColor DarkGray
    }
}
