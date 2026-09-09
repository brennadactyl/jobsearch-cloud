---
name: add-api-route
description: Add or change an endpoint on this repo's tracker API (server/src/routes/) - which of the two route lists it belongs in, why handlers never build a Response or touch D1 themselves, where the contract gets documented, and the cross-user isolation checks the change owes verify-local.mjs. Use when adding, changing or removing an /api/ endpoint, a handler in server/src/routes/, or a Db method in server/src/db.js.
---

# Adding or changing an API route

The shape is deliberately small: **one line in the route table, one exported
function in the module beside it.** Everything that makes a route safe -
knowing who is calling, scoping to their rows, getting CORS onto the error
replies - has already happened by the time a handler runs, and happens by
default rather than by remembering to.

Read `server/README.md`'s "Code layout" section and the header comment on
`server/src/routes/index.js` before writing anything. Most of what follows is
there; this is the order to do it in and what is easy to get wrong.

## 1. Decide which list it goes in

`server/src/routes/index.js` holds two arrays, and the split is the whole
access-control story:

- `PUBLIC_ROUTES` runs before anyone is known. **Three entries, and it should
  stay three** - exchanging a password for a token, provisioning a user with
  the admin secret, and purging a retired search with the same secret. The
  last two name their subject in the body rather than being the caller, which
  is why a session would be the wrong credential. Adding a fourth is a
  decision to justify in the comment above the array, not a default.
- `SESSION_ROUTES` is everything else. By the time one of these runs,
  `ctx.user` is the person the bearer token resolved to and `ctx.db` is a `Db`
  that can only see their rows.

It is a list rather than a flag on each row precisely so a new route inherits
authentication by omission rather than losing it.

## 2. Write the handler

One exported function per endpoint, in the module for its resource
(`leads.js`, `applications.js`, `config.js`, ...). It takes one context object
and returns a `Response`.

Three rules, each of which exists because it was broken once:

- **Never construct a `Response`.** Use `json()`, `text()`, `unauthorized()`
  from `../http.js`. That is what keeps `CORS_HEADERS` on the error replies
  too - a 404 without them reaches the browser as an opaque network failure
  with no status to read.
- **Never touch `env.DB`.** Every read and write of a person's own data goes
  through a method on `Db` (`../db.js`). Add a method there if none fits.
- **Never check ownership.** You cannot: `ctx.db` was bound to one user id at
  construction, so another user's lead id does not resolve, their track key
  reads as unconfigured, their rows are not in the result set. The handler's
  ordinary "not found" path *is* the cross-user access check. Writing an
  explicit `if (row.user_id !== ...)` means you have reached around `Db`.

Open with the parse-or-400 preamble if it takes a body:

```js
const body = await readJson(request);
if (body instanceof Response) return body;
```

Reuse `../validate.js` rather than re-deriving a check: `isoDate` for a
caller-supplied date, `unknownTrack` / `unknownTrackResponse` for a track key,
`excluderFor` for any write path that can introduce a company. Each of those
lives there because the same rule had drifted into two slightly different
rules across handlers - a stricter date on one route than another, or a track
check on the routes that read by key and none on the two that wrote by it.
That second one is how 145 leads came to sit under a retired track key,
invisible on the page, with nothing erroring on either side.

**Document the contract on the handler itself**, in the house style: what it
takes, what it answers, and *why* it refuses what it refuses. The route table
carries only a line or two of orientation; `server/README.md` has the prose
version.

## 3. Add the route table line

Method, path, handler. A `RegExp` path captures its groups into `ctx.params`
in order.

- Numeric ids are matched strictly (`/^\/api\/leads\/(\d+)\/status$/`); track
  keys accept any single path segment (`([^/]+)`) and 404 through
  `unknownTrack` if it is not one of this caller's configured tracks. An id is
  a row this database assigned; a track key is an installer-chosen slug.
- **`matchRoute` takes the first match.** A literal path that could be
  swallowed by a pattern below it has to sit above it - the reason
  `/api/prompt/_applications` precedes `/api/prompt/([^/]+)`. If you add a
  literal segment under a path that already has a pattern route, check the
  order and say in a comment why it is where it is.
- Method is checked before path, so a GET to a POST-only path falls to the 404
  rather than being answered by the wrong handler.

## 4. Add a `Db` method if you need one

In `server/src/db.js`, following what is there: filter on `this.userId` in
every statement, add or extend the `@typedef` for any row shape you change,
and keep the "why" comment with it. If the route writes, ask whether a partial
write is possible - the convention here is to refuse the whole request rather
than drop the bad rows, because a partial insert leaves a nightly run
believing it filed rows it did not, and it treats those postings as ones it
never has to find again.

## 5. Add checks to `verify-local.mjs` - this is not optional

Every new route owes it at least:

- the happy path,
- **a second user trying the same thing and failing** - by id, by track key,
  by whatever handle the route takes,
- the refusals it defines (bad date, unknown track, missing field),
- and, if it writes, that the write is idempotent or deduped the way you
  claimed.

Write them in the existing voice: `check("B cannot fill A's row", ...)`. The
name is what someone reads when it fails at 3am. Follow the file's fixtures -
users Ada and Bo, `example.com` URLs, tolerating a re-run against the same
local database.

Then run it, per the `verify-and-deploy` skill. A route added without these
checks is a route that is only ever tested by the person whose data leaks.

## 6. Update the docs that describe the API

- `server/README.md`'s API reference section.
- `server/src/routes/index.js`'s header comment, if the shape of the table
  changed.
- The client, if it will call the route - `client/public/index.html`, see the
  `edit-tracker-page` skill.
- The prompts, if a nightly run is meant to call it - `server/src/prompt.js`
  *and* every track's doc, see `change-search-prompt`. A route no prompt
  mentions is a route no run will ever call.

## Removing or changing an existing route

The callers are not all in this repo. A route is potentially called by the
page, by `scripts/*.ps1`, by a composed prompt in `prompt.js`, and by prose in
each installer's `private/<user-id>/docs/tracked_<key>_postings.md` on some
machine you cannot see. Grep the first three; for the fourth, assume it says
something and check `change-search-prompt`. A scheduled run that confidently
published through a retired mechanism is a thing that has actually happened
here.
