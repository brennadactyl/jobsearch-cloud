# An operator's dashboard

Everything an operator does today is a script, an admin route called by hand, or
a question put to a teammate session. This puts the answers and the actions on a
page, signed in as a person whose account is marked an operator.

This changes `server/` (an operator flag, a handful of read routes, and the
existing admin routes reachable by session), `client/` (an Admin area beside
the tracker) and `docs/schema.md`. The routes today are in
[`server/README.md`](../server/README.md); the account panel is
[account-settings-plan.md](account-settings-plan.md).

Screens: [Operator area](https://claude.ai/artifact/HpPc5T8egLhjm8aghhXMeW),
approved - the operator's header and an ordinary one; invites at phone and
desktop width with their first-run and minted states; Overview at both widths,
with charts and on a night with nothing wrong; last night, accounts, a person's
own page and the company list, with a first look at an account that has no
history; adding a company; and the composed step in each of its three refusals.

**The area shows only what exists.** No navigation row until there is a second
panel to switch to, and each panel appears as it is built. A single chip is a
tab bar with one tab, and a chip for a panel that isn't there is a promise the
page can't keep.

## Who gets in

`users.operator`, a flag on the account, set by an operator through
`POST /api/users`. An operator signs in the way anyone does and the page offers
an Admin area; nothing new is typed into a browser.

- **It is its own route in the same app, reached from the header** beside My
  account, not a tab. The tab strip is built from a person's own tracks and
  means "my searches" throughout - the Overview counts them, the drills key off
  them - so an Admin tab would be its first entry that isn't a track, and that
  special case is where a trace leaks into the ordinary path. Sharing the app
  keeps sign-in, theming, the save indicator and the API layer; a separate app
  would copy all four and then drift.
- **Hiding it is presentation, not a boundary.** The operator check on the
  server is the gate. The panels' code ships to every browser and is readable
  there, which costs nothing because the sensitive part is in the responses -
  but it loads as its own chunk, so the page most people open carries none of
  it.
- **An ordinary account sees nothing there:** no disabled control and no
  explanation. A greyed entry tells everyone on the deployment that an operator
  area exists and they are not in it.

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
  distinguishable from ordinary ones. Deleting an account and purging a search
  stay out of this page altogether: they are the two that can't be undone, and
  an operator holding a phone is the worst place to offer them. They keep their
  scripts and the admin token.

## What it shows

Five tabs. Overview is where the area opens; Last night, Accounts and the
company list answer a question an operator asks today by reading logs or a
backup; Invites is the one tab that is an action rather than a reading, and it
is a tab of its own because it ships before any of the panels exist and is the
thing an operator reaches for most. Everything about one person is reached
through that person, not through a sixth tab.

**Overview.** Two questions, in this order: is the system running, and is it
serving anyone. Everything on it is a number an operator can act on, and each
one links to the rows behind it.

**Running** - is the system working:

| Number | What it counts | Opens |
|---|---|---|
| Ran last night | searches whose `last_run.on` is last night, over searches not paused and written up | Last night |
| Reported nothing | not paused, written up, and `last_run.on` older than last night: the one fault among the four kinds of nothing | Last night, those rows |
| Nights missed, 7 days | for each search, nights in the last seven with no run recorded, summed | Last night |
| Setups waiting | intakes `pending` past their retry window, and `failed` | Accounts |
| Searches with no task | written up, not paused, and never a run recorded | Accounts |

**Serving** - is it worth anyone's while:

| Number | What it counts | Opens |
|---|---|---|
| Leads found last night | `last_run.leads_added` summed | Last night |
| Leads found, 7 days | leads whose `found` is in the last seven days | the leads |
| Searches finding nothing, 7 days | running searches with no lead in seven days - the number that says a person's rules or their scope need a conversation, not that anything is broken | Accounts |
| Screened by someone's own rules, 7 days | screened rows in the settings-caused kinds | the Screened rows |
| Applications moved, 7 days | applications whose stage changed in the last seven days, against applications made: a search producing leads nobody applies to fails differently from one producing none | Accounts |

**Standing** - what there is:

| Number | What it counts | Opens |
|---|---|---|
| People | accounts, demo excluded | Accounts |
| Searches | running, and paused | Accounts |
| Invites outstanding | minted, not used, not revoked, not expired | Invites |
| Companies | rows on the shared list | Companies |
| Least covered search | the search whose `sweep_cursor` has moved least in seven days | Companies |

**Backup age isn't here**, though it belongs on a page like this: nothing
records a backup in the database. `backup-tracker.ps1` writes files to the run
machine's disk, so the page could only know what a backup reports to it, and no
route takes that report. Until one does, the number would be a guess dressed as
a fact.

- **Every number names its window**, because "leads added" over a night and over
  a week are different claims and a dashboard is where they get conflated.
- **A number that can't be acted on doesn't go on it.** Totals that only grow -
  leads ever found, nights ever run - measure the age of the deployment rather
  than its health.
- **It is built from what the runs recorded**, so it inherits the limit the Last
  night panel states: a run that died recorded nothing, and no count here can
  tell that from a search that never ran. The missing-nights number is what
  surfaces that, and it is the one an operator should look at first.
- **Running and serving are one screen, in that order**, and it scrolls. Two
  tabs would turn one question - is this fine - into two checks, and the second
  is the one nobody does.
- **Searches finding nothing sits last in serving, with no colour.** It isn't a
  fault: among the red things it reads as broken and gets chased like a bug,
  when what it needs is a conversation with the person whose search it is.
- **A number gets a picture only where a picture says more than the number.**
  Seven nights of leads is a column chart, so last night has a baseline and a
  night that found none is visible. A ratio of two parts stays a meter or a row:
  a two-slice pie asks the eye to compare angles while the label carries the
  number anyway.

**Last night.** One row per search across every account: what it added and
screened, and which of four states it is in. A search whose task has stopped
reads differently from one that ran and found nothing - that distinction is the
reason this panel exists.

**Four kinds of nothing, and only one is a fault.** A quiet night writes a row,
`status=ok` with zeros. A stopped task writes nothing, so it shows as
`last_run.at` unchanged from the night before - which means comparing against
the previous night rather than reading one row. A paused search writes nothing
either, and is told from a stopped one only by `paused_since` on the track. A
search with no scheduled task has never written one at all. So: paused on
purpose, ran and found nothing, reported nothing, and never ran. A search set up
today is a fifth case that reads as neither - its first night hasn't come.

**Silence is not a result, and must not look like one.** A night that found
nothing has a time, a screened count and a log; a night that reported nothing
has no time, and that absence is the whole of the evidence. So the second gets
colour, a sentence rather than a dash, and the name of the script that can see
what the page can't. Drawn as neighbours on a scale, the commonest row on the
page teaches an operator to stop noticing the one worth acting on.

**It shows recorded runs, and says so.** The server knows only what a run
reported. A run that died before recording - the CLI unauthenticated, a document
over the limit, the write-back refused, the machine asleep - reported nothing,
so from here it is indistinguishable from a search that never ran, which is the
distinction above. Queue wait, elapsed time and the runner's own problem tags
live in logs on the machine that ran them, and so do the helper's own counts: a
coerced kind, a cleared area, a tab filed at another group's root, a refused
row. So the panel names what it can't see and points at `run-report.ps1` for
the rest.

**A night links to its log.** The logs are already in R2 and already served -
`GET /api/logs/<track>` lists them, `GET /api/logs/<track>/<started>` serves
one - so this needs an operator-scoped equivalent rather than a new store. That
link is the difference between "it ran" and "it ran, and here is what it said",
and without it an operator reads a count and then asks a session what happened.

**"Never ran" needs a machine, not a button.** A search added through config has
no scheduled task until `setup-scheduler.ps1` runs on the PC that runs the
searches, and no browser reaches that. The panel says what is missing and where
to fix it rather than offering an action it can't perform.

**Accounts, and a page for each person.** The list gives every person, their
searches, whose resume is unreadable and which searches are paused; invites sent,
used and unused; intakes pending, failed, or waiting on a retry that will never
come. Opening a person gives the rest: their searches and what each one will
read, their resume, their setup, and the actions that name them: pause and
resume.

**Everything about one person comes from one place.** So the composed step is
not a panel of its own; it hangs off the person whose search it is. An operator
looking at someone reaches everything about them without going back to a tab
strip and choosing a different lens on the same person.

**The company list.** The list itself: what is on it, which companies are walled
or dead, what discovery added, and where each search's cursor sits. It is shared
across accounts, so it is the one panel that isn't per person.

**What a run will read.** For one search, the composed step a night actually
gets - the locations, the roles line, the fit rules, the pay floor - as
`GET /api/prompt/<key>` builds it. A person's answers can be right and their
composed step still wrong, and the step is the only place the two meet: the
location lists, the pay clause and the fit rules exist composed nowhere else,
so this renders the rule rather than repeating a stored copy of it.

The route is a pure read, and it refuses in three ways the page shows as states
rather than errors: paused, not written up, and a tab that has no prompt of its
own - where the answer is to offer the root that fills it. It takes a document
budget; the panel passes none and shows the default.

That route is a session route, composed from the caller's own config, so this
panel needs an operator route of its own rather than a credential change - and
it is the one that reaches furthest into someone else's data: their locations,
their roles line, their fit rules, in a form that can't be screenshotted into a
PR or a doc. **The panel says so on itself** - whose words these are, and not to
copy them out - because it is the one screen in the app whose contents are
someone else's and where the rule against putting real data in a public place
is easiest to break while trying to be helpful. It is built last for both
reasons. The same composed step shown to the person whose search it is, in their
own account panel, is the fix for the failure that prompted it; this view is the
operator's copy of that, not a substitute for it.

## What it does

The actions that are scripts today, each on a named account and each confirmed:

| Action | Today |
|---|---|
| Mint an invite, list and revoke one | `POST`/`GET`/`POST /api/invites`, by hand - the routes exist, so this panel is only the credential change |
| Retry a failed setup | nothing: `POST /api/intake/complete` takes `done` or `failed`, so no route puts an intake back to `pending`, and `RETRY_NIGHTS` expires it |
| Pause or resume a search | the person's own panel, or `POST /api/config` |
| Add a company to the shared list | `POST /api/coverage` with a session, or the `add-target-company` skill; the operator path is new |

- **An invite is minted and read back on the page**, with its link ready to
  copy. Minting is the action an operator takes most, and the one most likely to
  be wanted from a phone.
- **The minted link gets its own screen**, not a row appearing in the list: the
  code is readable once, and copying it is the only thing there that going back
  can't undo. The list below is cards at phone width and a table at desktop -
  the same four facts either way, not a second design. First run keeps the form
  and puts the empty state under it rather than replacing it.
- **The link is copied, not sent.** There is no email anywhere in this system -
  an invite row holds a note, not an address - so sending would mean a mail
  provider, its deliverability and a stored address for everyone invited, to
  save an operator pasting a link into the conversation they are already having.
  If it is ever wanted, the phone's own share sheet is the version that adds no
  service and stores nothing.
- **An action names what it will change before it runs.** The two that can't be
  undone - deleting an account, purging a search - aren't here, so nothing on
  this page needs a backup taken first.
- **Adding a company writes to the list every account shares**, so it is the one
  action here that reaches everyone at once. It says so, and it records the same
  facts the `add-target-company` skill does - the board, the endpoint, the URL
  shape - because a name with no way to fetch it is a company every search skips
  and nobody notices. A demo account can't write the list today, and that
  refusal stays whoever is signed in.
- **Every action says what it did and what it changed**, because an operator
  acting on someone else's account has no other way to check.

## What it doesn't do

Editing a person's searches, their locations or their documents. An operator
fixing someone's config by hand is the thing the account panel exists to end,
and a dashboard that can do it invites doing it. A bad answer someone typed is
fixed by telling them, or by a change to the form that asked badly.

**Deleting an account**, which stays a token-only route called deliberately.
Every other action here is recoverable or repeatable; that one takes a person's
whole record, and nothing about an operator's day is improved by being able to
do it from a phone.

**It replaces one script, `new-invite.ps1`.** The others stay, because they act
on the machine rather than on the data: `setup-scheduler.ps1` registers Windows
tasks there, `backup-tracker.ps1` writes files to its disk, `import-documents.ps1`
reads a folder on it, and no browser reaches any of that.

## Order of work

1. **The flag and the credential** (Backend Buddy): `users.operator`, its
   migration, `ADMIN_ROUTES` accepting an operator session while its handlers
   keep `user: null` and `db: null`, and `GET /api/me` saying whether the caller
   is one - it returns `{id, name}` today, so that field is real work.
2. **Invites** (Client Comrade): the whole tab, and the first thing worth
   having. Every route it needs exists, so step 1 is all that stands between
   here and minting an invite from a phone.
3. **The read routes** (Backend Buddy): Overview's counts, last night across
   accounts, accounts with their setup state, and company-list coverage. One
   route per panel rather than one that answers everything, reading through a
   cross-account class of its own. Overview's numbers are computed server-side,
   not summed by the page from rows it happens to hold - the page summing them
   is how a count starts meaning the window rather than the question.
4. **Those panels** (Client Comrade), Overview first, since it is where the area
   opens and the others are what its numbers link to. Overview is built with its
   charts: they cost little and the seven-night column is the one picture that
   says something the rows can't. The chartless version is the fallback if that
   turns out to be wrong, not a second design to maintain.
5. **The rest of the actions** (Fullstack Friend, with the area's owner): retry
   a setup, which needs a way to put an intake back to `pending`; pause or
   resume.
6. **What a run will read**, on a person's page, and only after the person whose
   search it is can see their own. Built the other way round, the operator's copy
   becomes the tool, and the page that would have let someone check their own
   composed step never gets built - which is the failure that prompted this view
   in the first place.

