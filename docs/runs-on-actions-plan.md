# The searches run on GitHub Actions

The nightly runs move off the PC to GitHub-hosted runners, invoking the same
Claude Code CLI against the same tracker API. This changes `scripts/` (the
runners lose Task Scheduler and gain a workflow), adds `.github/workflows/`, and
changes nothing in `server/` beyond what the dispatcher already adds. Nothing is
built.

## Context

A search runs tonight because Windows Task Scheduler invokes
`scripts/run-search.ps1` on Brenna's PC, which fetches that track's prompt from
`GET /api/prompt/<key>`, downloads the person's documents into a throwaway run
directory, runs `claude -p` with a fixed tool allowlist, and writes results back
through the API.

**The machine holds almost nothing.** Per person it holds `tracker.json` - an
API URL and a session token - and a log file. Search config, page config, leads
and applications are in D1; resumes and baseline docs are in R2 behind
`/api/documents` and are fetched into each run; the prompt is composed
server-side. Each run already uploads its own log to the tracker, kept 30 days.
So what moves is the invocation and the clock, not the data.

[One clock, read from the config](dispatcher-plan.md) is the prerequisite and
says so itself: a hosted runner has no task registry to keep in step, and that
plan removes the registry rather than making it more reliable.

## Why Actions rather than the earlier hypothesis

`private/HANDOFF-jobsearch-cloud.md` hypothesised a Cloudflare Workflow calling
the Anthropic API directly, and named the crux: the prompt depends on Claude
Code's `WebSearch`, `WebFetch` and `Bash`, so a server-side replacement needs
equivalents, and whether fetch reliability would match was unvalidated.

A GitHub-hosted runner runs the CLI itself, so that question does not arise. The
prompt, the allowlist and the verification premise - every candidate URL fetched
and confirmed to render - stay exactly as they are. This is a change of where
the same run happens.

## What the repo being public costs

`brennadactyl/jobsearch-cloud` is public, and on a public repository the
workflow logs and the uploaded artifacts are readable by anyone. A run's output
names the companies a person is searching, the postings it found and screened,
and the role line they wrote. That is the one thing in this change that cannot
be solved by being careful, because being careful is a thing someone has to keep
being.

Two ways out, and the choice is the first decision this plan needs:

- **The workflows live in a second, private repository** that checks this one
  out. Run output is private; this repo stays public and keeps no secrets.
- **The run prints nothing.** Everything goes to the tracker's own log, which is
  where it already goes, and the workflow's visible output is a status line.
  Cheaper, but it is one careless `Write-Host` from publishing somebody's
  search, and the failure is silent and public.

The first is the one to take unless there is a reason not to. The second is a
rule; the first is a boundary.

## Credentials

The CLI authenticates today with a personal `CLAUDE_CODE_OAUTH_TOKEN`. Per
person the run also needs that account's tracker URL and session token, and the
fill and backup jobs need `ADMIN_TOKEN`.

- **Whether a personal subscription token may be used by CI at all** is a
  question for Anthropic's terms rather than for this plan, and it is the first
  thing to settle, because the answer may make this an API-key change after all
  and that changes cost per night.
- **A token per person does not scale as a secret per person.** The run already
  asks the server for everything else; the dispatcher's answer is the natural
  place for a short-lived token scoped to one search's run, which is
  [the token split](token-split-plan.md) brought forward rather than new work.

## What to measure before committing

**Whether careers sites serve a GitHub runner the pages they serve a house.**
The runs already meet bot walls from a residential address - Cloudflare
challenges, CAPTCHA pages and outright 403s appear in the logs - and the whole
premise is that a posting is fetched and confirmed to render. GitHub's runners
are datacenter addresses, which boards treat differently.

This is cheap to find out and expensive to discover afterwards: take the
companies a recent night actually swept, fetch each from a runner, and compare
what comes back against what that night got. A materially worse rate is a reason
to stop, not a thing to design around.

Second, **what a night costs in runner minutes.** Searches take 10 to 40 minutes
each and there are eight, so a night is several hours of runner time.

## Scheduling

The dispatcher asks `GET /api/due` on a fixed interval and runs what it is
handed; on Actions that interval is a `schedule:` cron.

- Actions cron is UTC, so the Pacific slots the runs stamp their dates from
  become an offset that changes twice a year. The system is deliberately on
  Pacific (`CLAUDE.md`); this is the first place that costs something.
- Actions cron is best-effort and runs late under load, and GitHub disables
  schedules on a repository with no recent activity. A dispatcher that asks what
  is due tolerates lateness, which is one more reason it comes first.

## Order

1. The fetch comparison above, before anything is built.
2. The dispatcher, as [its own plan](dispatcher-plan.md) has it, still running
   on the PC.
3. One search on Actions, nightly, with the PC's task for it disabled and the
   rest untouched, until a week of its nights match what the PC produced.
4. The remaining searches, then the fill and the backup.
5. The PC's tasks removed once nothing has depended on them for a week.

## Not in this change

The privacy posture, sign-up, and retention - those are the hosted-service
questions in the handover, and this plan is only about where tonight's run
happens. The runs reaching other people's machines is also not this: one hosted
runner for the searches that exist is the whole of it.
