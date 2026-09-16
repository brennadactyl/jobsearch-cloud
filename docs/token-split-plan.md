# A machine's token can't act as the person

A session token is either a person's or a machine's, and the route table says
which kind each route accepts. A nightly search's token, which sits in plaintext
on a Windows machine, can report what it found and can no longer change the
search, delete a lead, or read the account's password-protected surface.

This changes `server/` (one migration, the route table, the router) and the
scripts only where a call moves. The route table is described in
`server/src/routes/index.js`; the tables are in [schema.md](schema.md).

## Context

`ADMIN_ROUTES` already proves the shape works: a list, checked once by the
router, that a handler cannot forget. Everything else is one list,
`SESSION_ROUTES`, and a token that reaches one of them reaches all of them.

Two kinds of holder present a session token today, and they are already
distinguishable - `sessions.label` is `browser` for a sign-in and
`scheduled-search` for a token minted for a machine:

- **A person**, signed in on the tracker page, whose token lives in that
  browser.
- **A machine**, running the nightly searches and the application fill, whose
  token lives in `private\<user-id>\tracker.json` in plaintext, on a PC that
  also fetches web pages all night.

The machine's token can rewrite config, delete every lead, change the page
title, or read the intake. Nothing in the product needs it to.

## The split

`sessions` gains `kind`: `person` or `machine`. `POST /api/tokens` (admin) mints
`machine`; signing in mints `person`. The migration backfills from `label`:
`scheduled-search` becomes `machine`, everything else `person`.

`SESSION_ROUTES` becomes three lists, checked by the router the way
`ADMIN_ROUTES` already is:

- **`PERSON_ROUTES`** - the page's own calls: sign out, me, password, intake,
  data, `POST /api/config`, status changes, deleting a lead or an application,
  requeueing a fill.
- **`MACHINE_ROUTES`** - what a nightly run reports: leads, screened, runs,
  verified, delist, coverage, dedup, prompt, the autofill queue and its report,
  and `POST /api/writeup`.
- **`SHARED_ROUTES`** - what both genuinely need: `GET /api/config`, and the
  document routes, which a person uses for their resume and a run uses for the
  track doc.

**The lists are derived, not judged.** A route the page calls belongs to
`PERSON_ROUTES` or `SHARED_ROUTES`; a route `scripts/tracker.ps1` or the run
scripts call belongs to `MACHINE_ROUTES` or `SHARED_ROUTES`. `verify-local`
reads the callers - `client/src/api/client.ts` and the PowerShell scripts - and
fails if any route either side calls is not in a list that admits it, and if any
route is in no list at all. A new route added to the wrong list is caught by the
test that already knows who calls it.

## What a refusal looks like

- A machine token on a person route, or the reverse, is `403` naming the kind
  the route wants, not `401`. The credential is valid; it is the wrong kind, and
  a run that gets `401` will otherwise report "not logged in" and look like an
  expired token.
- The refusal is the router's, so it is the same sentence everywhere and no
  handler writes its own.

## What this does not do

It does not make the machine's token safe to lose. It bounds what a leaked one
can do - report postings into one account - which is the difference between a
nuisance and losing a search. Expiry, rotation and per-track tokens are separate
items on the [backlog](backlog.md).

## Verification

- `verify-local` gains: a machine token refused on each person route, a person
  token refused on each machine route, both accepted on the shared ones, and the
  caller-derived check above.
- The migration is checked against a copy holding real sessions: every existing
  `scheduled-search` row comes out `machine`, every other row `person`, and no
  session is dropped.
- A live check after deploy: the tracker page still loads and saves, and one
  search runs end to end reporting leads, screened rows and its run record.

## Rollout

The scripts keep working: every call they make lands in `MACHINE_ROUTES` or
`SHARED_ROUTES`, and their tokens are already `scheduled-search`. Deploy is
therefore server-only, with no client change - but run it when no search is
running, and re-run one search by hand afterwards rather than waiting for
01:00.
