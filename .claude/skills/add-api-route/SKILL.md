---
name: add-api-route
description: Add or change an endpoint on this repo's tracker API (server/src/routes/) - which of the two route lists it belongs in, why handlers never build a Response or touch D1 themselves, where the contract gets documented, and the cross-user isolation checks the change owes verify-local.mjs. Use when adding, changing or removing an /api/ endpoint, a handler in server/src/routes/, or a Db method in server/src/db.js.
---

# Adding or changing an API route

A route is **one line in the route table and one exported function in the
module beside it.** Authentication, row scoping and CORS on error replies have
already happened by the time a handler runs.

Read `server/README.md`'s "Code layout" section and the header comment on
`server/src/routes/index.js` before writing anything.

## 1. Decide which list it goes in

`server/src/routes/index.js` holds two arrays, and the split is the whole
access-control story:

- `PUBLIC_ROUTES` runs before anyone is known. **Three entries; keep it
  three** - exchanging a password for a token, provisioning a user with the
  admin secret, and purging a retired search with the same secret. The last
  two name their subject in the body rather than being the caller, so a
  session is the wrong credential for them. A fourth needs its justification
  in the comment above the array.
- `SESSION_ROUTES` is everything else. By the time one of these runs,
  `ctx.user` is the person the bearer token resolved to and `ctx.db` is a `Db`
  that can only see their rows.

A route not in `PUBLIC_ROUTES` is authenticated by default; never add a
per-route auth flag.

## 2. Write the handler

One exported function per endpoint, in the module for its resource
(`leads.js`, `applications.js`, `config.js`, ...). It takes one context object
and returns a `Response`.

Three rules:

- **Never construct a `Response`.** Use `json()`, `text()`, `unauthorized()`
  from `../http.js`. That keeps `CORS_HEADERS` on error replies - a 404
  without them reaches the browser as an opaque network failure.
- **Never touch `env.DB`.** Every read and write of a person's own data goes
  through a method on `Db` (`../db.js`). Add a method there if none fits.
- **Never check ownership.** `ctx.db` is bound to one user id at
  construction, so another user's lead id does not resolve, their track key
  reads as unconfigured, their rows are not in the result set. The handler's
  ordinary "not found" path *is* the cross-user check; an explicit
  `if (row.user_id !== ...)` means you have reached around `Db`.

  `ctx.docs` (`src/r2.js`) works the same way for documents: every key is
  prefixed with the owner's id in a private method, so a handler cannot name
  an object outside its caller's space. A new store must get the same
  property.

Open with the parse-or-400 preamble if it takes a body:

```js
const body = await readJson(request);
if (body instanceof Response) return body;
```

Reuse `../validate.js`; don't hand-copy a check: `isoDate` for a
caller-supplied date, `unknownTrack` / `unknownTrackResponse` for a track key,
`excluderFor` for any write path that can introduce a company. A copied check
drifts into a second, slightly different rule.

**Document the contract on the handler itself**, in the house style: what it
takes, what it answers, and *why* it refuses what it refuses. The route table
carries only a line or two of orientation; `server/README.md` has the prose
version.

`routes/documents.js` is the one module that does not return `json()` or
`text()` (raw bytes in both directions) and the only place with `PUT` and
`DELETE`; both are commented in place. If a new route needs to diverge the
same way, say why at the call site.

## 3. Add the route table line

Method, path, handler. A `RegExp` path captures its groups into `ctx.params`
in order.

- Numeric ids are matched strictly (`/^\/api\/leads\/(\d+)\/status$/`); track
  keys accept any single path segment (`([^/]+)`) and 404 through
  `unknownTrack` if it is not one of this caller's configured tracks.
- **`matchRoute` takes the first match.** A literal path that a pattern below
  it could swallow has to sit above it - which is why
  `/api/prompt/_applications` precedes `/api/prompt/([^/]+)`. If you add a
  literal segment under a path that already has a pattern route, check the
  order and say in a comment why it is where it is.
- Method is checked before path, so a GET to a POST-only path falls to the 404
  rather than being answered by the wrong handler.

## 4. Add a `Db` method if you need one

In `server/src/db.js`, following what is there: filter on `this.userId` in
every statement, add or extend the `@typedef` for any row shape you change,
and keep the "why" comment with it. If the route writes, refuse the whole
request rather than drop bad rows - a partial insert makes a nightly run
believe it filed rows it did not, and it never looks for those postings again.

## 5. Add checks to `verify-local.mjs` - this is not optional

Every new route owes it at least:

- the happy path,
- **a second user trying the same thing and failing** - by id, by track key,
  by whatever handle the route takes,
- the refusals it defines (bad date, unknown track, missing field),
- and, if it writes, that the write is idempotent or deduped the way you
  claimed.

Write them in the existing voice: `check("B cannot fill A's row", ...)`.
Follow the file's fixtures - users Ada and Bo, `example.com` URLs, tolerating a
re-run against the same local database.

Then run it, per the `verify-and-deploy` skill.

## 6. Update the docs that describe the API

- `server/README.md`'s API section.
- `server/src/routes/index.js`'s header comment, if the shape of the table
  changed.
- The client, if it will call the route - `client/public/index.html`, see the
  `edit-tracker-page` skill.
- The prompts, if a nightly run is meant to call it - `server/src/prompt.js`
  *and* every track's doc, see `change-search-prompt`. A route no prompt
  mentions is a route no run will ever call.

## Removing or changing an existing route

Check every caller before changing a route: the pages
(`client/public/index.html`, `client-react/src/`), `scripts/*.ps1`,
`server/src/prompt.js`, and every track doc. Grep the code; read the docs
through the tracker - `GET /api/documents` per account, then each `docs/`
entry. `change-search-prompt` has the procedure for updating the docs.
