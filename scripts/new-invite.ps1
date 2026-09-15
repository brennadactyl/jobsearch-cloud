<#
.SYNOPSIS
  Makes an invite link to send someone, or lists what became of the invites
  already made.

.DESCRIPTION
  Adding a person is sending this link. They create their own account on the
  tracker page, describe their search and attach their resume, and the nightly
  run-onboarding.ps1 builds it (docs/onboarding-plan.md).

  The code is shown once. The server stores only its hash, so a lost code is
  replaced with a new invite, never looked up. An invite makes one account,
  can't touch an existing one, and expires after -Days.

  Reads the API URL, the ADMIN_TOKEN and the tracker page's URL from
  <DataDir>\deployment.json (see private.example/README.md). The token is sent
  to the API and never printed.

.PARAMETER Note
  Who the invite is for, in your own words. Shown in -List, never to them.

.PARAMETER Days
  How long the link stays good. Default 14; the API allows at most 30.

.PARAMETER List
  Show every invite: when it was made, whether it is waiting, used or expired,
  and the name and user id of the account a used one created. The user id names
  that person's folder in the data dir.

.EXAMPLE
  .\new-invite.ps1 -Note "Sam, from the climbing gym"

.EXAMPLE
  .\new-invite.ps1 -List
#>
[CmdletBinding(DefaultParameterSetName = "Mint")]
param(
    [Parameter(ParameterSetName = "Mint", Mandatory = $true)][string]$Note,
    [Parameter(ParameterSetName = "Mint")][ValidateRange(1, 30)][int]$Days = 14,
    [Parameter(ParameterSetName = "List", Mandatory = $true)][switch]$List,
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),
    [string]$DeploymentFile
)

$ErrorActionPreference = "Stop"
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

function Get-ApiError($err) {
    $status = $null
    $detail = $err.Exception.Message
    if ($err.Exception.Response) {
        $status = [int]$err.Exception.Response.StatusCode
        try {
            $reader = New-Object System.IO.StreamReader($err.Exception.Response.GetResponseStream())
            $raw = $reader.ReadToEnd()
            if ($raw) { $detail = $raw }
        } catch { }
    }
    switch ($status) {
        401 { "The API refused the admin token (401). Check admin_token in $DeploymentFile matches the ADMIN_TOKEN secret on $api." }
        404 { "$api has no invite routes (404). Deploy server/ first." }
        default { "The API answered $status`: $detail" }
    }
}

if ($List) {
    try {
        $res = Invoke-RestMethod @request -Uri "$api/api/invites" -Method Get
    } catch {
        throw (Get-ApiError $_)
    }
    $invites = @($res.invites)
    if ($invites.Count -eq 0) {
        Write-Host "No invites yet. Make one with: .\new-invite.ps1 -Note `"their name`""
        return
    }
    # ISO 8601 UTC instants compare correctly as strings.
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss")
    $invites | ForEach-Object {
        $state = if ($_.used_at) { "used" } elseif ([string]$_.expires_at -lt $now) { "expired" } else { "waiting" }
        [pscustomobject]@{
            Note    = $_.note
            Created = ([string]$_.created_at).Substring(0, 10)
            Expires = ([string]$_.expires_at).Substring(0, 10)
            State   = $state
            Name    = $_.user_name
            UserId  = $_.user_id
        }
    } | Format-Table -AutoSize
    return
}

try {
    $body = @{ note = $Note; days = $Days } | ConvertTo-Json -Compress
    $invite = Invoke-RestMethod @request -Uri "$api/api/invites" -Method Post `
        -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
} catch {
    throw (Get-ApiError $_)
}

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
Write-Host "One use, good until $(([string]$invite.expires_at).Substring(0, 10)). This code can't be shown again." -ForegroundColor DarkGray
Write-Host "Check on it later with: .\new-invite.ps1 -List" -ForegroundColor DarkGray
