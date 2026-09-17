# Proves every changed .ps1 changed only in comments, using PowerShell's own
# parser. Usage, from the repo root:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/proof/check-ps1-tokens.ps1 [-Base <ref>]
# Compares the working copy against <ref>: the default HEAD checks uncommitted
# edits; -Base origin/main checks a committed branch.
# Fails on: a parse error the base version didn't have, any difference in the
# sequence of non-comment tokens, working-copy line endings that aren't what a
# checkout of the base blob would produce (core.autocrlf), or a changed BOM.
param([string]$Base = 'HEAD')
$ErrorActionPreference = 'Stop'
$files = @(git diff --name-only $Base -- '*.ps1')
$autocrlf = ((git config --get core.autocrlf) -eq 'true')
$pass = 0; $fail = 0

function Get-CodeTokens([string]$text) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    $code = @($tokens | Where-Object { $_.Kind -ne 'Comment' -and $_.Kind -ne 'NewLine' -and $_.Kind -ne 'LineContinuation' -and $_.Kind -ne 'EndOfInput' } |
        ForEach-Object { "$($_.Kind)`t$($_.Text -replace "`r`n", "`n")" })
    return [pscustomobject]@{ Code = $code; Errors = @($errors) }
}
function Get-EolStyle([byte[]]$bytes) {
    $s = [System.Text.Encoding]::UTF8.GetString($bytes)
    $crlf = ([regex]::Matches($s, "`r`n")).Count
    $lf = ([regex]::Matches($s, "(?<!`r)`n")).Count
    if ($crlf -and $lf) { 'mixed' } elseif ($crlf) { 'crlf' } elseif ($lf) { 'lf' } else { 'none' }
}
function Test-Bom([byte[]]$b) { $b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF }

$tmp = Join-Path $env:TEMP ("ps1-base-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    foreach ($f in $files) {
        if (-not $f) { continue }
        cmd /c "git cat-file -e `"${Base}:$f`" 2>nul"
        if ($LASTEXITCODE -ne 0) { $fail++; "  FAIL  $f -- not in $Base (new file?)"; continue }
        if (-not (Test-Path $f)) { $fail++; "  FAIL  $f -- deleted in working copy"; continue }
        $baseFile = Join-Path $tmp ([IO.Path]::GetFileName($f))
        # cmd redirection keeps git's bytes as-is (PowerShell 5.1 > would re-encode).
        cmd /c "git show `"${Base}:$f`" > `"$baseFile`""
        $before = [IO.File]::ReadAllBytes($baseFile)
        $after = [IO.File]::ReadAllBytes((Resolve-Path $f))
        $problems = @()
        $beforeEol = Get-EolStyle $before
        $expectedEol = if ($autocrlf -and $beforeEol -eq 'lf') { 'crlf' } else { $beforeEol }
        $afterEol = Get-EolStyle $after
        if ($afterEol -ne $expectedEol) {
            # With core.autocrlf=true git normalizes endings on commit, so note it, don't fail on it.
            if ($autocrlf) { "  note  $f -- working-copy endings $afterEol (normalized on commit)" }
            else { $problems += "line endings: expected $expectedEol, found $afterEol" }
        }
        if ((Test-Bom $before) -ne (Test-Bom $after)) { $problems += "BOM $(Test-Bom $before) -> $(Test-Bom $after)" }
        $tb = Get-CodeTokens ([System.Text.Encoding]::UTF8.GetString($before))
        $ta = Get-CodeTokens ([System.Text.Encoding]::UTF8.GetString($after))
        if ($ta.Errors.Count -gt $tb.Errors.Count) { $problems += "new parse error: $($ta.Errors[0].Message)" }
        if (($tb.Code -join "`n") -ne ($ta.Code -join "`n")) {
            $i = 0; while ($i -lt [Math]::Min($tb.Code.Count, $ta.Code.Count) -and $tb.Code[$i] -eq $ta.Code[$i]) { $i++ }
            $problems += "code tokens differ at token $i : [$($tb.Code[$i])] vs [$($ta.Code[$i])]"
        }
        if ($problems.Count) { $fail++; "  FAIL  $f -- $($problems -join '; ')" } else { $pass++; "  PASS  $f" }
    }
} finally { Remove-Item -Recurse -Force $tmp }
""
"$pass passed, $fail failed  (core.autocrlf=$autocrlf)"
if ($fail) { exit 1 }
