---
name: add-d1-migration
description: Change this repo's D1 schema - writing a numbered migration under server/migrations/, updating db.js and its typedefs, verifying against a database that already has data, and applying it without ever writing to production D1 by hand. Use when adding or altering a table or column, writing a migration file, or when an API route needs a field the schema does not have yet.
---

# Changing the schema

A migration runs once, against real data, and cannot be undone. Every step
below follows from that.

## Before writing anything: is a migration what you need?

If a route couldn't set a field, report the missing route. **Never write to
production D1 by hand** - `.claude/hooks/block-remote-d1-writes.mjs` refuses
it. The HTTP API is the one supported write path: it scopes every statement to
the calling user and validates what it is given.

## 1. Write the file

`server/migrations/NNNN_short_name.sql`, next number in sequence, four digits,
lowercase-underscored name. Migrations apply in filename order and are
recorded, so the number is the identity: **never renumber or edit a migration
that has been applied anywhere.**

**The header comment is the permanent record of why** - it cannot be edited
once the migration is applied. Cover only:

- **What changed**, in one or two sentences.
- **Why**: the current problem it solves, stated as a present-tense reason.
  Numbers only where they define the requirement, never the story of finding
  it.
- **What each new column means**, value by value.
- **What not to do**, one directive line each, only where a later reader
  plausibly would.

Leave out paragraphs weighing alternatives, defences of the reasoning,
deploy-time instructions (stale once applied), run-behaviour warnings (they
belong in `server/src/prompt.js`), and history. Where `db.js` or a verifier
needs the same rationale, point at the migration instead of restating it.

Practical constraints:

- **SQLite cannot alter most constraints in place.** `ADD COLUMN` with a
  `NOT NULL DEFAULT` is cheap and safe; changing a constraint means dropping
  and recreating the table (as `0002_multi_user.sql` does), and that needs its
  own block in `verify-migration.mjs`.
- **A new column needs a default that is correct for every existing row.**
  `''` is the convention - columns are `TEXT NOT NULL DEFAULT ''` almost
  throughout, and "not set" is a value rather than NULL.
- **Backfill in the migration if the default is wrong for existing rows.**
  `0008` shuffles positions into an existing table in the same file. If the
  backfill creates rows, condition it on data in every table it depends on, so
  a partially populated database cannot migrate rows to an owner that was
  never created.
- **Per-user, unless the table is the shared one.** Anything computed across
  rows partitions by `user_id` (and usually `search`), so one person's data
  never orders or seeds another's. The exception is `company_fetch`, the one
  company list every search indexes into (`0011_one_company_list.sql`): its
  `position` is one shuffle across the whole list. Nothing else crosses users;
  a new column that seems to need to is a design decision to raise, not a
  migration to write.

## 2. Update `server/src/db.js`

All D1 access lives there. Add or change:

- the statements that read and write the column, filtered on `this.userId`
  like everything else;
- the `@typedef` for the row shape - there is no build step, so those JSDoc
  blocks are the whole type contract;
- a pointer to the migration for what the field is for, if a reader of
  `db.js` would not otherwise find it.

Anything that reads the new field through the API needs a route change too -
see the `add-api-route` skill. A column no route exposes can only ever be
written by a migration.

Update `docs/schema.md` in the same change - the column in the diagram, and a
line under its table if the name doesn't say what it holds. Describe what the
migrations produce, never what a plan proposes. `node verify-schema-doc.mjs`
checks the two agree, and CI runs it on every push to main.

## 3. Verify

Two checks, covering different things.

**Against a database the migrations built from empty** - the full API
verification, which shows whether the new field is scoped and exposed
correctly:

```bash
cd server && npx wrangler d1 migrations apply job-search-tracker-db --local
```

then `verify-local.mjs`, per the `verify-and-deploy` skill.

**Against a database that already has data** - which the first check cannot
see, because it always starts from empty. This is what catches a migration
losing a column, dropping rows, resetting AUTOINCREMENT or leaving data owned
by a user that does not exist:

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

Run it only from where the `verify-and-deploy` skill says: the main checkout,
on main, never a worktree.

## What the hook allows

`.claude/hooks/block-remote-d1-writes.mjs` permits `wrangler d1 migrations
apply` - the reviewed, versioned path for schema changes. It refuses
`--remote` INSERT/UPDATE/DELETE, `d1 delete`, `time-travel restore`, and
deleting the Worker.

A hook refusal means a supported path exists elsewhere; find it or report that
there isn't one.
