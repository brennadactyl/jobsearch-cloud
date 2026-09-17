---
name: write-powershell-script
description: Write or change a script in scripts/*.ps1 the way this repo's scripts work under Windows PowerShell 5.1 - finding the script folder, the data folder, secrets, requests to the worker, reading refusals, native commands, exit codes, parse-checking, and how a script change ships. Use when creating or editing any scripts/*.ps1.
---

# Writing a PowerShell script

Every script in `scripts/` runs under **Windows PowerShell 5.1**, often from Task
Scheduler with nobody watching. These conventions exist because each one failed
silently at least once in that setting.

## Finding things

1. **The script folder.** Never use `$PSScriptRoot` in a `param` default: the
   scheduler can leave it empty. Use the three lines every script shares, and
   change them everywhere together:

   ```powershell
   $scriptDir = if ($PSScriptRoot) { $PSScriptRoot }
                elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
                else { "" }
   ```

   `Split-Path -Parent ""` throws, so a guard placed after it never runs. A
   script that needs a sibling throws at once, naming the sibling, and every
   sibling path is built from `$scriptDir`.
2. **The data folder:** `-DataDir`, then `JOB_SEARCH_DATA_DIR`, then
   `$scriptDir\..\private`. Refuse only when the folder is missing. Keep paths
   under it short: Windows' 260-character limit fails as "Could not find a part
   of the path".
3. **Secrets:** read `deployment.json` or `tracker.json` straight into request
   headers, and never print a token - including inside an error message.

## Talking to the worker

4. **`Invoke-WebRequest` needs `-UseBasicParsing`,** or it tries the Internet
   Explorer engine and hangs unattended.
5. **Send a `User-Agent`.** Cloudflare refuses some default agents with 403 and
   `error code: 1010` before the Worker sees the request, which looks exactly
   like a bad token. The operator scripts send `curl/8.0`.
6. **A refusal's body is in `$_.ErrorDetails.Message`.** PowerShell 5.1 has
   already consumed the response when it throws, so `$_.Exception.Message` is
   only "(400) Bad Request"; the server's `{ error }` is in `ErrorDetails`.
7. **Capture `$_` before a nested `try`.** Inside an inner `catch`, `$_` is the
   inner error, so copy `$_.ErrorDetails.Message` into a variable first.
8. **Send UTF-8 bytes.** PowerShell 5.1 sends a string body as ISO-8859-1; send
   `[Text.Encoding]::UTF8.GetBytes($json)` with `charset=utf-8` in the
   content type.
9. **`ConvertTo-Json` flattens arrays:** a one-item array becomes a scalar and
   an empty one disappears. Wrap an array under a property.

## Arguments and values

10. **Parse `--flag` arguments by hand** when callers pass them: PowerShell
    binds only single-dash names, so `--status` arrives as a positional value.
11. **`@($null)` is a one-element array.** Filter with `| Where-Object { $_ }`
    before a `foreach` over a property that may be absent.

## Running and exiting

12. **Native commands:** `2>&1` on git and similar turns progress written to
    stderr into `NativeCommandError` records, so success looks like failure.
    Check `$LASTEXITCODE`, not error output.
13. **Exit codes:** 0 when everything was done, 1 when nothing could be
    attempted, 2 when it finished with skips or failures. Say which in the help
    block.
14. **Write anything a model must read to stdout,** not stderr: a headless run
    reads one stream.
15. **Scheduled tasks** run as the logged-in user with User-scope environment
    variables. A variable set only in the current shell is invisible to them;
    use `setx`. Anything a task runs must not depend on the profile's execution
    policy: launch with `-NoProfile -ExecutionPolicy Bypass`, and call
    `npm.cmd` / `npx.cmd`.
16. **A `Global\` mutex needs a `Local\` fallback** (the privilege isn't there
    for an ordinary user), and an `AbandonedMutexException` means you now hold
    the lock.
17. **Variable names ignore case.** `$line` and `$LINE` are the same variable,
    so a constant named in capitals overwrites a loop variable of the same
    word. Give constants distinct names (`$LOG_LINE`).
18. **`Format-Table` shows at most 10 columns** for an object with more
    properties, and drops the rest silently. Pass `-Property *` (or list the
    columns), and `Out-String -Width` wide enough to keep a wide table from
    being cut.
19. **`Write-Error` under `$ErrorActionPreference = "Stop"` terminates the
    script,** so an `exit 1` after it never runs. The process still exits
    non-zero under `powershell -File`. To control the exit code, use
    `Write-Host` for the message, then `exit`.

## Before committing

20. **Parse-check it:**

    ```powershell
    $tok = $null; $err = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tok, [ref]$err) | Out-Null
    $err
    ```

    Declare `$tok` and `$err` first; `[ref]` to an undeclared variable throws.
21. **Test it with `$PSScriptRoot` empty,** the way the scheduler can run it:
    `Invoke-Expression (Get-Content -Raw script.ps1)`.
22. **Test from a short folder.** A scratchpad or session path plus a staged
    file passes 260 characters easily, and a file past it silently vanishes.
23. **Run it against the live worker before merging** when it depends on a
    server contract that is new.
24. **Edit scripts with the Edit tool, or a node script saved to a file.** A
    one-liner passed through the Bash tool eats `$var` and collapses
    backslashes, so a regex or a Windows path arrives mangled; a heredoc hides
    the same damage until the file is run. Use the PowerShell tool for anything
    with `$`. A stub `.cmd` for a test is written with node, not `printf`,
    which turns a `\r` in a path into a carriage return.

## Shipping

The scheduled tasks run `scripts\` from the checkout that registered them - the
main checkout. A script change is live once it is merged and that checkout is
pulled; deploying the Worker doesn't ship it.

Order matters when a script change depends on a new server contract: deploy the
server first, then pull the checkout, so a run never meets a script asking for
something the worker doesn't have yet.
