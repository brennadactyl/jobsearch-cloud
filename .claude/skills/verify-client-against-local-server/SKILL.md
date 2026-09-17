---
name: verify-client-against-local-server
description: Run the tracker page against a local server built from a branch - a short-path server worktree, local D1 and wrangler dev, an account made over the API, Vite pointed at it, and the flow driven and screenshotted in headless Edge with tools/client/edge-driver.mjs - then tear it all down. Use before shipping a client change that depends on a server branch not yet deployed, or when a change needs a real browser (layout, scrolling, file upload, screenshots against a design) with real data rather than jsdom.
---

# Checking the page against a local server

jsdom tests prove the page's logic; they can't prove it against a server that
isn't deployed yet, or prove layout, scrolling and uploads. This runs the real
page against a local server built from the branch, with real data, in a real
browser - and leaves nothing behind.

Commands are for Windows. `<main checkout>` is the repo's main checkout;
`C:\VibeCoding\_srv` stands for any short path.

## 1. The server

1. **A server worktree at a short path.** Local D1 under a long path (the temp
   folder, a nested worktree) fails with "internal error".

   ```bash
   git worktree add --detach C:\VibeCoding\_srv <server branch, or origin/main>
   ```

2. **Link the main checkout's `node_modules`** with a junction, from PowerShell
   (`cmd /c mklink /J` from Git Bash breaks on quoting):

   ```powershell
   New-Item -ItemType Junction -Path C:\VibeCoding\_srv\server\node_modules -Target <main checkout>\server\node_modules
   ```

3. **A local-only admin token:**

   ```powershell
   Set-Content -Encoding ascii C:\VibeCoding\_srv\server\.dev.vars "ADMIN_TOKEN=local-admin-token-for-testing"
   ```

4. **Migrations**, from `C:\VibeCoding\_srv\server`:

   ```powershell
   npx.cmd wrangler d1 migrations apply DB --local
   ```

5. **Start the worker** as a background command on a port you've confirmed free
   (see `verify-and-deploy`), and wait for it to answer:

   ```powershell
   npx.cmd wrangler dev --local --port 8791
   ```

   ```bash
   curl -s -o /dev/null --retry 60 --retry-delay 1 --retry-connrefused http://127.0.0.1:8791/
   ```

## 2. An account, over the API only

Never type a password into the page.

- **Invented demo data:**
  `powershell -File scripts/seed-demo-user.ps1 -TrackerUrl http://127.0.0.1:8791 -AdminToken local-admin-token-for-testing -Password <throwaway>`,
  then `POST /api/login` with `{ "name": "demo", "password": ..., "label": "browser" }`
  and keep the token.
- **A fresh account** (the setup form, or a shaped scenario):
  `POST /api/invites` with `Authorization: Bearer <admin token>` and
  `{ "note": ... }`, then `POST /api/signup` with `{ code, name, password }`.
  The reply's token is the session. Shape the account with `POST /api/config`
  and `PUT /api/documents/<path>`.

## 3. The page

1. **Point Vite at the local server:** write `client/.env.development.local` with
   `VITE_API_BASE=http://127.0.0.1:8791`. `client/.env.local` points at a
   different API, and Vite reads env only at start, so restart the dev server
   after writing it.
2. **Drive it with `tools/client/edge-driver.mjs`** (Node 22+, no dependencies;
   usage at the top of the file): `openEdge`, `signIn` with the token, then
   `goto`, `clickText`, `setValue` (React-safe), `attach` for uploads, `wheel`,
   and `screenshot`.
3. **Screenshot each state** at desktop width, phone width (390) and the light
   theme; compare against the approved design when there is one.
4. **Read the server's state back over the API** while the flow runs (for
   example `GET /api/documents`) and compare it with what the page shows.

Gotchas:

- The in-app browser pane reads the page as hidden - TanStack Query pauses and
  `requestAnimationFrame` never fires - so use headless Edge for anything
  layout- or timing-sensitive.
- A file input's `accept` filters a test upload, but a real person can pick
  "All files", so test refusals with `accept` removed.

## 4. Tear down, in this order

1. Stop the Vite dev server.
2. Stop the local worker: kill the process tree of the `wrangler` node process
   whose command line names your port, which takes its `workerd` child with it.
   Don't stop every `workerd` - the main checkout may be running its own.

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'wrangler.*--port 8791' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }
   ```
3. Remove the junction only:
   `cmd /c rmdir C:\VibeCoding\_srv\server\node_modules`. Never
   `Remove-Item -Recurse` on it, which follows the junction into the main
   checkout's `node_modules`.
4. `git worktree remove --force C:\VibeCoding\_srv`, then `git worktree prune`.
5. Delete `client/.env.development.local`.

The background `wrangler` command then reports exit 127; that is expected after
the kill.

## Report

Say which parts of the flow the local run exercised, and which only the tests
cover. Never report a flow as verified against the server unless this run
drove it.
