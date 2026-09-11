# Job Search Tracker client (Cloudflare Workers, static assets)

The tracker webpage: a real, standalone HTML file
([`public/index.html`](public/index.html) - open it directly in a browser to
preview/edit it) with its CSS and client-side JS inline - no build step, no
framework, no bundler. It's a separate deployable from the API (see
[`../server/`](../server/)), served from its own origin and talking to the
API cross-origin over `fetch` with a Bearer token. It holds no data of its own;
it renders and edits whatever the API returns.

**Only `public/` is served**, and a static-assets deploy publishes everything
in it. Keep anything that shouldn't be a public file on the live URL outside
`public/`.

## How it finds its API

One deployed client talks to one server. The API URL is a **deploy-time
setting**, not something a visitor types in.

`public/index.html` reads it from `public/local-config.js`, which is
**gitignored** so a deployment's own URL never lands in the template others
fork. **It is required:** without it the page shows "This deployment has no API
URL configured" instead of a sign-in.

```bat
cd client\public
copy local-config.example.js local-config.js
```
Edit the copy, set `LOCAL_API_BASE` to your `../server/` deploy's URL, then
deploy from `client/`. The deploy uploads `local-config.js` from disk even
though git ignores it.

## Signing in

The page asks for a **name and password** and posts them once to
`/api/login`, which returns a session token. The token lives in `localStorage`
(`tracker_token`, with `tracker_name` to prefill the form next time) and is
sent only to `LOCAL_API_BASE`; the password is never stored or sent again. Each
browser signs in once.

**"Signed in as ..."** (in the header) opens the dialog that changes your own
password. It asks for the current password as well as the session, and can sign
out your other browsers without touching the credential your scheduled search
holds. See [`../server/README.md`](../server/README.md#changing-your-own-password).

**Log out** (in the header) revokes that token on the server and clears the
view preferences. It leaves that person's other sessions alone, including the
one their scheduled searches use.

Accounts are created by whoever operates the deployment; there's no sign-up
here. See [`../server/README.md`](../server/README.md#accounts). Each person
sees only their own tracks, leads, applications, page title and location rules.

## One-time setup

Deploy [`../server/`](../server/) first - you'll need its Worker URL for
`local-config.js`.

### Quick deploy (recommended)

No Node.js or `wrangler` CLI required locally - the deploy happens in
Cloudflare's own environment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/client)

1. Click the button, sign in to Cloudflare, accept the defaults.
2. It forks this `client/` directory into a new repo in your own GitHub and
   deploys it as a Worker whose only content is the `public/` directory (via
   `[assets]` in `wrangler.toml` - no build command).
3. Your client's URL is shown on the dashboard (something like
   `https://job-search-tracker-client.<your-subdomain>.workers.dev`).
4. **Required:** in your forked repo, create `public/local-config.js` as in
   [How it finds its API](#how-it-finds-its-api), then redeploy.
5. Open the client and sign in with the name and password of the account you
   created (see [`../server/README.md`](../server/README.md#accounts)) - it's
   remembered in this browser for next time.
6. **Expect an empty page here.** A new database has no tracks, title or
   location rules, so you'll see only the Overview and Applications tabs until
   the [job-search-setup](../.claude/skills/job-search-setup/) skill posts your
   config to `/api/config` (see the root [README](../README.md)'s setup step
   5). Track tabs then appear, reading "No run recorded yet" until their first
   scheduled search reports in.

### Manual setup

```bat
cd client
wrangler login          REM if you haven't already
wrangler deploy
```
Prints your live URL, something like
`https://job-search-tracker-client.<your-subdomain>.workers.dev`. Step 4 above
(`local-config.js`) is required here too. Then sign in as in step 5, and
expect the empty page of step 6 until your config is posted.

## Updating after code changes

**Deploy from `main` in the main checkout, never from a branch or worktree** -
see [verify-and-deploy](../.claude/skills/verify-and-deploy/SKILL.md). A
worktree has no `local-config.js`, and a deploy from one removes it from the
live site.

```bat
cd client
npm run deploy
```

Use `npm run deploy`, not a bare `wrangler deploy`: it runs
`predeploy-check.mjs` first, which refuses the deploy when `local-config.js` is
missing. In PowerShell, use `npm.cmd run deploy` (see
[`../server/README.md`](../server/README.md#one-time-setup)).

A client-only change (styling, a new field, a UI fix) never needs a server
redeploy. A change that depends on a new API field or route needs the server
deployed first - check [`../server/README.md`](../server/README.md)'s API
section for what the deployed server supports.

## Custom domain / different host

Only the deploy step is specific to Cloudflare. `public/` is plain static
files and works unmodified from any static host (another Workers/Pages
project, S3 + CloudFront, GitHub Pages, any web server) - the API's CORS
response (`Access-Control-Allow-Origin: *`) allows any origin. Deploy
`public/`, including `local-config.js`, and skip `wrangler.toml`. Serve it over
HTTPS: browsers block an HTTPS API's `fetch` as "mixed content" from a page
loaded over plain HTTP.
