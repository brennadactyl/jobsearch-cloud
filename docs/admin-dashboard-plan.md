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
- **Every admin route gains a second way in:** an operator's session token. The
  route list keeps its shape - `ADMIN_ROUTES` means "operator only" rather than
  "token only" - so a route is never reachable by an ordinary session because
  someone forgot which list it was in.
- **An operator sees other people's rows**, which no other part of this system
  allows: `ctx.db` is scoped to one user everywhere else. The operator reads go
  through their own routes rather than by widening that scope, so the guarantee
  the rest of the server rests on is untouched.

## What it shows

Four panels, each answering a question an operator asks today by reading logs or
a backup.

**Last night.** One row per search across every account: ran, paused, failed or
never ran, what it added and screened, and how long it took. A search whose task
has stopped reads differently from one that ran and found nothing - that
distinction is the reason this panel exists.

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

## What it does

The actions that are scripts today, each on a named account and each confirmed:

| Action | Today |
|---|---|
| Mint an invite, and revoke one | `POST /api/invites`, by hand |
| Retry a failed setup | nothing; the retry window expires |
| Pause or resume a search | the person's own panel, or config |
| Reset a password | `scripts/set-password.ps1` |
| Delete an account | `DELETE /api/users/<id>` |

- **An invite is minted and read back on the page**, with its link ready to
  copy. Minting is the action an operator takes most, and the one most likely to
  be wanted from a phone.
- **A password is never typed into this page.** Reset means minting a
  single-use link the person sets their own password with, not choosing one for
  them. If that link doesn't exist yet, the dashboard doesn't reset passwords.
- **Deleting an account asks for its name typed back**, as the search reset
  does, and says what will go.
- **Every action says what it did and what it changed**, because an operator
  acting on someone else's account has no other way to check.

## What it doesn't do

Editing a person's searches, their locations or their documents. An operator
fixing someone's config by hand is the thing the account panel exists to end,
and a dashboard that can do it invites doing it. A bad answer someone typed is
fixed by telling them, or by a change to the form that asked badly.

## Order of work

1. **The flag and the route change** (Backend Buddy): `users.operator`, its
   migration, admin routes accepting an operator session, and `GET /api/me`
   saying whether the caller is one.
2. **The read routes** (Backend Buddy): last night across accounts, accounts
   with their setup state, and company-list coverage. One route per panel
   rather than one that answers everything.
3. **The page** (Client Comrade): the Admin area, the four panels, and invites.
4. **The rest of the actions** (Fullstack Friend, with the area's owner): retry
   a setup, pause or resume, delete an account.
