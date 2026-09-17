---
name: live-e2e-test
description: Prove a deployed feature on the live tracker end to end with a throwaway account - checking each half is live, the invite and signup, inspecting the account through admin routes, invented test files whose details prove a run read them, checking the overnight onboarding run, and cleaning up in the order that leaves nothing running against a deleted account. Use when asked to test a shipped feature live, or to check a cross-team feature works end to end.
---

# Live end-to-end test

A live test runs against the real deployment, so it uses a throwaway account
and invented data only, never a real person's. The user signs in and signs up;
you never type a password or create an account.

## 1. Before starting

- **Check each owner's half is live:**
  - the server: `wrangler deployments status` in `server/`;
  - the page: fetch the client's `index.html`, then the `/assets/*.js` it
    names, and search the bundle for the feature's new strings;
  - scripts: the main checkout's `HEAD`, since the scheduled tasks run from it.
- **Put the test plan to the user** before doing anything.

## 2. The account

Read the admin token from `<DataDir>\deployment.json` into a header and never
print it. Send a `User-Agent` (`curl/8.0`).

1. `scripts\new-invite.ps1 -Note "<what this tests>" -Days 2`. The user opens
   the link, signs up, and tells you the account name.
2. `GET /api/invites` (admin): the used invite's `user.id` is the account id.
3. To inspect the account, `POST /api/tokens` with `{ "user": "<id>" }` (admin)
   mints a search token, **replacing the account's existing one** - only ever
   for a throwaway account. With it, read `GET /api/documents`,
   `GET /api/config` (tracks, `documents`, the written-up fields) and
   `GET /api/intake`.
4. `GET /api/intake/pending` (admin) lists setups waiting for the overnight run.
   An account missing from it never sent setup, or is done.

Production D1 is never queried by hand; use the API, or the local backup.

## 3. Test files that prove they were read

- Invent details that exist nowhere else: employer names, a product,
  certifications, languages. "The run read the file" is then a text search of
  its output.
- A valid `.docx` needs no Word: a zip (`System.IO.Compression`) holding
  `[Content_Types].xml`, `_rels/.rels` and `word/document.xml`, with one
  `<w:p><w:r><w:t>` per paragraph.
- A fake `.doc` is the OLE header bytes `D0 CF 11 E0 A1 B1 1A E1` plus padding.
- Keep folder paths short (for example `C:\ete`). Copy files into the scratchpad
  when a browser upload needs a readable path.

## 4. In the browser

- The in-app pane has no file-upload tool, so the user attaches files.
- Typing into a field with a default appends to it: select all first.
- Confirm a field's value with JavaScript (`input.value`); page text doesn't
  show input values.
- A later success can replace a refusal message on screen, so ask the user what
  a refusal said, or reproduce it through the API.

## 5. After the overnight onboarding run

- `private\logs\onboarding.log`: "built N of N", any failure note, and the
  `wrote up <track>` line listing the fields written.
- `Get-ScheduledTaskInfo JobSearch-Onboarding` for `LastTaskResult`.
- The new `JobSearch-<first 8 of id>-<track>` task is registered; its first
  search may already have run.
- The written track config and track doc, read through the API: search them for
  details that can only have come from the input under test.

## 6. Clean up, in this order

The order keeps anything from running or being backed up against a deleted
account.

1. `Unregister-ScheduledTask -TaskName JobSearch-<id8>-<track> -Confirm:$false`
   for each of the account's tasks.
2. The `private\<id>` folder. A hook guards deletions under `private\` and
   refuses a whole command that touches it, so give the user the command to
   run. Backups under `private\backups` are the user's to prune.
3. `DELETE /api/users/<id>` (admin) with `{ "name": "<account name>" }`. It is
   refused without the name, which must match the id. The reply counts every
   row and document removed.
4. The local test files and their scratchpad copies.

## 7. Report

Say what was confirmed and what wasn't, each with its evidence: the log line,
the counts, the matched details. Don't round up.
