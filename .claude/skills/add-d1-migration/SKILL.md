---
name: add-d1-migration
description: Change this repo's D1 schema - writing a numbered migration under server/migrations/, updating db.js and its typedefs, verifying against a database that already has data, and applying it without ever writing to production D1 by hand. Use when adding or altering a table or column, writing a migration file, or when an API route needs a field the schema does not have yet.
---

# Changing the schema

A migration is **the one thing in this repo that runs once, against real
data, and cannot be undone.** Everything below follows from that.

## Before writing anything: is a migration what you need?

If you got here because a route could not set a field, the fix is the route,
not a hand-written UPDATE. On 2026-08-31 a headless backfill found
`/api/update` could not set `fit` and wrote 131 UPDATE statements straight to
production instead of stopping to report it. The result was fine; the habit is
not, and `.claude/hooks/block-remote-d1-writes.mjs` now refuses it. **Report
the missing route.** The tracker's data has exactly one supported write path -
its HTTP API, which scopes every statement to the calling user and validates
what it is given.

## 1. Write the file

`server/migrations/NNNN_short_name.sql`, next number in sequence, four digits,
lowercase-underscored name. Applied in filename order and recorded, so the
number is the identity - never renumber or edit a migration that has been
applied anywhere.

**The comment at the top is the substantive part of the file.** Read
`0008_sweep_cursor.sql` and `0009_application_autofill.sql` before writing
yours - both are dozens of lines of prose over two or three lines of DDL, and
that is the ratio the house style expects. Say what changed, what problem it
came out of (with the real numbers if there were any), what the new column
means value by value, and what you deliberately did *not* do. The DDL says
what; nothing else says why, and a year from now the why is the part nobody
can reconstruct.

Practical constraints:

- **SQLite cannot alter most constraints in place.** `ADD COLUMN` with a
  `NOT NULL DEFAULT` is cheap and safe; changing a constraint means dropping
  and recreating the table, which is what `0002_multi_user.sql` does to five
  of them and why it gets its own verifier.
- **A new column needs a default that is correct for every existing row.**
  `''` is the convention here - the existing columns are `TEXT NOT NULL
  DEFAULT ''` almost throughout, and the "not set" case is a value rather than
  NULL.
- **Backfill in the migration if the default is not the right answer for
  existing rows.** `0008` shuffles positions into an existing table in the
  same file. Make it conditional on there being data if it creates anything -
  an early version of `0002`'s backfill checked only four of six tables, and a
  database in an unusual state migrated its rows to an owner that was never
  created.
- **Per-user, not global.** Anything you compute across rows partitions by
  `user_id` (and usually `search` too), so one person's data never orders or
  seeds another's.

## 2. Update `server/src/db.js`

All D1 access lives there. Add or change:

- the statements that read and write the column, filtered on `this.userId`
  like everything else;
- the `@typedef` for the row shape - there is no build step, so those JSDoc
  blocks are the whole of the type contract;
- the comment explaining what the field is for, if the migration's prose does
  not already sit somewhere a reader of `db.js` will find it.

Anything that reads the new field through the API needs a route change too -
see the `add-api-route` skill. A column no route exposes is a column only a
migration can ever have written.

Update `docs/schema.md` in the same change - the column in the diagram, and a
line under its table if the name doesn't say what it holds. That doc describes
what the migrations produce, not what a plan proposes. `node
verify-schema-doc.mjs` checks the two agree, and CI runs it on every push to
main.

## 3. Verify

Two checks, and they cover different things.

**Against a database the migrations built from empty** - the full API
verification, which is where you find out whether the new field is scoped and
exposed correctly:

```bash
cd server && npx wrangler d1 migrations apply job-search-tracker-db --local
```

then `verify-local.mjs`, per the `verify-and-deploy` skill.

**Against a database that already has data** - which is the case the first
check structurally cannot see, because it always starts from empty. It would
not notice a migration losing a column, dropping rows, resetting AUTOINCREMENT
or leaving data owned by a user that does not exist:

```bash
cd server && node verify-migration.mjs
```

It runs in-process against a throwaway `node:sqlite` database - no wrangler,
no dev worker, nothing to clean up, and it never touches D1. If your migration
does anything more than add a defaulted column, **add a block to it**: seed
the pre-migration rows, apply the migration files, and check what came out.
Follow the existing shape - one `console.log("== ... ==")` section per
scenario, including the awkward ones (a database holding only one table's
rows, an empty database).

## 4. Apply it

Never by hand, never against `--remote` outside the deploy script.

**Take a backup first:**

```powershell
.\scripts\backup-tracker.ps1
```

Then deploy the server, which applies the migration and only deploys if it
succeeded:

```bash
cd server && npm run deploy
```

Read the `verify-and-deploy` skill for where that must be run from - main
checkout, main branch, clean tree. A migration published from a branch is a
schema change nobody reviewed.

## What the hook allows, and what that means

`.claude/hooks/block-remote-d1-writes.mjs` permits `wrangler d1 migrations
apply` deliberately: schema changes have their own reviewed, versioned path,
and that is this. It refuses `--remote` INSERT/UPDATE/DELETE, `d1 delete`,
`time-travel restore`, and deleting the Worker.

Take the refusal as information rather than an obstacle. It is a config file,
not a boundary - something determined could call the Cloudflare API directly -
so it only works as a signal that the thing being attempted has a supported
path somewhere else. Find that path or report that there isn't one.
