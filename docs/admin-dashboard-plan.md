# An operator's dashboard

Everything an operator does today is a script, an admin route called by hand, or
a question put to a teammate session. This puts the answers and the actions on a
page, signed in as a person whose account is marked an operator.

This changes `server/` (an operator flag, a handful of read routes, and the
existing admin routes reachable by session), `client/` (an Admin area beside
the tracker) and `docs/schema.md`. The routes today are in
[`server/README.md`](../server/README.md); the account panel is
[account-settings-plan.md](account-settings-plan.md).

## Who gets in

`users.operator`, a flag on the account, set by an operator through
`POST /api/users`. An operator signs in the way anyone does and the page shows
an Admin area; nobody else sees it, and nothing new is typed into a browser.

- **`ADMIN_TOKEN` stays what it is:** the machine key for scripts, and the way
  the first operator flag is set on a database that has none. A person's session
  never carries it.
- **Only the credential check changes.** `ADMIN_ROUTES` still means "operator
  only" rather than "token only", and its handlers still receive `user: null`
  and `db: null`. That absence is what protects them: with no `Db` to reach for,
  a handler must name its subject, and a handler handed one would act on the
  operator's own account while looking correct in review. The operator's identity
  arrives in a field of its own, for attribution, and is never used for scoping.
- **The principle, stated once:** a session route's `ctx.db` only ever sees its
  caller; an admin route names its subject and builds a `Db` for it. Reaching
  another account through a named subject is the existing pattern - `POST
  /api/purge` and `POST /api/companies/cleanup` already do it - so this design
  follows the rule rather than bending it.
- **Cross-account reads get a class of their own**, constructed without a user,
  never passed to a session route, as `CompanyList` already is. What must not
  exist is a `Db` with an absent user id: depending on the statement it matches
  nothing or everything, and which one shows up first in production.
- **A browser can now reach admin routes, which today it cannot at all.** The
  weaker credential defines the route, so operator sessions are minted
  distinguishable from ordinary ones, and the destructive actions - deleting an
  account, purging a search - need more than a resumed session.

## What it shows

Four panels, each answering a question an operator asks today by reading logs or
a backup.

**Last night.** One row per search across every account: ran, paused, failed or
never ran, and what it added and screened. A search whose task has stopped reads
differently from one that ran and found nothing - that distinction is the reason
this panel exists.

**It shows recorded runs, and says so.** The server knows only what a run
reported. A run that died before recording - the CLI unauthenticated, a document
over the limit, the write-back refused, the machine asleep - reported nothing,
so from here it is indistinguishable from a search that never ran, which is the
distinction above. Queue wait, elapsed time and the runner's own problem tags
live in logs on the machine that ran them. So the panel names what it can't see
and points at `run-report.ps1` for the rest, until a route serves a run's log -
which is its own change, not a detail of this one.

**"Never ran" needs a machine, not a button.** A search added through config has
no scheduled task until `setup-scheduler.ps1` runs on the PC that runs the
searches, and no browser reaches that. The panel says what is missing and where
to fix it rather than offering an action it can't perform.

**Accounts.** Each person, their searches, whose resume is unreadable, and which
searches are paused. Invites sent, used and unused. Intakes pending, failed, or
waiting on a retry that will never come.

**The company list.** How much of it each search has covered, where its cursor
is, and which companies are walled, dead or newly discovered. The list is shared
across accounts, so this is the one panel that isn't per person.

**What a run will read.** For one search, the composed step a night actually
gets - the locations, the roles line, the fit rules, the pay floor - as
`GET /api/prompt/<key>` builds it. A person's answers can be right and their
composed step still wrong; today that is only visible to whoever reads the
prompt.

That route is a session route, composed from the caller's own config, so this
panel needs an operator route of its own rather than a credential change - and
it is the one that reaches furthest into someone else's data: their locations,
their roles line, their fit rules, in a form that can't be screenshotted into a
PR or a doc. It comes last of the panels for both reasons. The same composed
step shown to the person whose search it is, in their own account panel, is the
fix for the failure that prompted it; this panel is the operator's copy of that,
not a substitute for it.

## What it does

The actions that are scripts today, each on a named account and each confirmed:

| Action | Today |
|---|---|
| Mint an invite, list and revoke one | `POST`/`GET`/`POST /api/invites`, by hand - the routes exist, so this panel is only the credential change |
| Retry a failed setup | nothing: `POST /api/intake/complete` takes `done` or `failed`, so no route puts an intake back to `pending`, and `RETRY_NIGHTS` expires it |
| Pause or resume a search | the person's own panel, or `POST /api/config` |
| Send a password-reset link | not built. `POST /api/users` resets by choosing a password, which this page won't do, so this row needs a new mechanism rather than a new caller |
| Delete an account | `DELETE /api/users/<id>`, which already requires the name in the body |

- **An invite is minted and read back on the page**, with its link ready to
  copy. Minting is the action an operator takes most, and the one most likely to
  be wanted from a phone.
- **A password is never typed into this page.** Reset means minting a
  single-use link the person sets their own password with, not choosing one for
  them. If that link doesn't exist yet, the dashboard doesn't reset passwords.
  Whether that link revokes their sessions is the link's decision to state, not
  to inherit: `set-password.ps1` deliberately leaves them alive, because one of
  them is the search token in `tracker.json`, and revoking it stops that
  person's nightly runs until someone mints a new one and edits a file on the
  run machine.
- **A destructive action shows how old the last backup is.** Deleting an account
  from a phone without knowing whether there is a recent backup is the one way
  this page can cost something that can't be got back.
- **Deleting an account asks for its name typed back**, as the search reset
  does, and says what will go.
- **Every action says what it did and what it changed**, because an operator
  acting on someone else's account has no other way to check.

## What it doesn't do

Editing a person's searches, their locations or their documents. An operator
fixing someone's config by hand is the thing the account panel exists to end,
and a dashboard that can do it invites doing it. A bad answer someone typed is
fixed by telling them, or by a change to the form that asked badly.

**It replaces one script, `new-invite.ps1`.** The others stay, because they act
on the machine rather than on the data: `setup-scheduler.ps1` registers Windows
tasks there, `backup-tracker.ps1` writes files to its disk, `import-documents.ps1`
reads a folder on it, and no browser reaches any of that.

## Order of work

1. **The flag and the credential** (Backend Buddy): `users.operator`, its
   migration, `ADMIN_ROUTES` accepting an operator session while its handlers
   keep `user: null` and `db: null`, and `GET /api/me` saying whether the caller
   is one - it returns `{id, name}` today, so that field is real work.
2. **Invites** (Client Comrade): the whole panel, and the first thing worth
   having. Every route it needs exists, so step 1 is all that stands between
   here and minting an invite from a phone.
3. **The read routes** (Backend Buddy): last night across accounts, accounts
   with their setup state, and company-list coverage. One route per panel rather
   than one that answers everything, reading through a cross-account class of
   its own.
4. **Those three panels** (Client Comrade).
5. **The rest of the actions** (Fullstack Friend, with the area's owner): retry
   a setup, which needs a way to put an intake back to `pending`; pause or
   resume; delete an account.
6. **What a run will read** (Backend Buddy, then Client Comrade): its own
   operator route, last because it reaches furthest into someone else's data.

A password-reset link is its own change, whenever it is wanted: nothing in this
plan depends on it, and the dashboard resets no passwords until it exists.
