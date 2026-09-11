<#
.SYNOPSIS
  Sets or resets a tracker account's password, interactively.

.DESCRIPTION
  Calls POST /api/users (create-or-reset, with the ADMIN_TOKEN) with a password
  typed at a prompt, because an argument would persist in shell history,
  scrollback and agent transcripts. Only password_hash changes, so existing
  sessions, including the scheduled-search token in tracker.json, keep working.

  This is the reset path only: for an account created with a random password or
  a forgotten one. A user who knows their password changes it on the tracker
  page (POST /api/password), which needs no admin token.

.PARAMETER Name
  The account name. Case does not matter but spelling does: a name matching no
  account creates a new, empty one, and the script warns when that happens.

.EXAMPLE
  .\set-password.ps1 -Name "Jordan Lee"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),
  [string]$DeploymentFile
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $DeploymentFile) { $DeploymentFile = Join-Path $DataDir "deployment.json" }
if (-not (Test-Path $DeploymentFile)) {
  throw "No deployment.json at $DeploymentFile - see server/README.md's Accounts section for what it holds."
}
$d = Get-Content $DeploymentFile -Raw | ConvertFrom-Json
if (-not $d.admin_token) { throw "$DeploymentFile has no admin_token." }

$s1 = Read-Host "New password for '$Name' (12+ characters)" -AsSecureString
$s2 = Read-Host "Confirm" -AsSecureString

$b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)
$b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2)
try {
  $p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b1)
  $p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b2)

  if ($p1 -cne $p2) { throw "The two entries did not match. Nothing was changed." }
  # Matches the server's rule; /api/login has no rate limiting, so length is the
  # defence.
  if ($p1.Length -lt 12) { throw "Too short: $($p1.Length) characters. The server requires 12+." }

  $body = @{ name = $Name; password = $p1 } | ConvertTo-Json -Compress
  # Cloudflare's browser-integrity check 403s some default user agents with
  # "error code: 1010", which reads exactly like a rejected admin token.
  $res = Invoke-RestMethod -Uri "$($d.url)/api/users" -Method Post `
    -Headers @{ Authorization = "Bearer $($d.admin_token)" } `
    -ContentType "application/json" -UserAgent "curl/8.0" -Body $body

  if ($res.created) {
    Write-Warning ("created = True: no account named '$Name' existed, so a NEW empty one was made " +
                   "(id $($res.id)). Check the spelling against the intended account, and clean this up - " +
                   "otherwise they will sign in to an empty tracker.")
  } else {
    Write-Host "Password updated for '$Name' (id $($res.id))." -ForegroundColor Green
    Write-Host "Existing sessions still work, including the scheduled-search token." -ForegroundColor DarkGray
  }
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
  Remove-Variable p1, p2 -ErrorAction SilentlyContinue
}
