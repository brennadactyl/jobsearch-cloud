# Backlog

What is worth building next, and why, ranked. Not a plan and not a promise: an
item leaves this list when it gets a plan of its own or ships.

Kept by whoever is holding the product manager role.

## Next

- **[Account settings](account-settings-plan.md)** - a person edits their own
  search, and swaps their resume, where the password dialog already is. Planned
  in full; unassigned. Today any change needs the operator and the
  `job-search-setup` skill, which does not survive strangers signing up.
- **An `attempts` column on `intake`** - the retry bound is a three-day rule on
  `sent_at` today, which is the right stop in the wrong unit. Counting nights is
  one column and one increment, and needs its own migration.

## Worth doing, unscheduled

- **[Split user tokens from machine tokens](token-split-plan.md)** - planned;
  unassigned. Every session token reaches every route today, so a search's
  token on a machine can rewrite config or delete leads.
- **Rate-limit `/api/login` and `/api/signup`.** Both are public and unthrottled;
  password length is the only defence. `server/README.md` says so in its own
  security notes.
- **Tokens never expire.** Revoking means deleting a `sessions` row by hand.
- **A privacy posture for strangers.** Whoever administers the Cloudflare
  account can read every account's rows in D1. Honest for friends; with
  strangers' resumes it needs a retention policy and a deletion path a person
  can invoke themselves. The delete-account route is the operator half of this.
- **Company discovery as its own nightly job**
  ([company-discovery-plan.md](company-discovery-plan.md), unmerged) - searches
  re-evaluate the same companies on the same nights.

## Small

- A stray phrase in `prompt.js` step 3b, "when the named list reads as big
  tech", left over from per-search company lists. Next change that touches
  `prompt.js`.
- Adding or removing a search from the account panel: a new role means a new
  tab, and removing one has leads and applications hanging off it.

## Watching

- **The first nights without per-search company lists, and with the run queue.**
  Compare companies covered, leads found, run length and queue waits against the
  week before.
- **Whether an empty first morning is normal.** The page now says it is. The one
  run that produced it had an inverted scope, so it is not yet evidence.
