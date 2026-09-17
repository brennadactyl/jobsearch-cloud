---
name: team-setup
description: Bring up this repo's team of Claude sessions on this machine - one session per role (Product Partner, Backend Buddy, Client Comrade, Prompt Bro, Fullstack Friend, Clean Code Companion, Documentation Dude), each titled with its role name and started with "You are <role name>." Skips any role already running. Use when told "set up the team", or when a fresh clone needs its teammates.
---

# Setting up the team

Each teammate is a separate Claude session that loads its role skill
(`.claude/skills/role-*`) from its first message. This skill starts the ones
that aren't already running and changes nothing about the ones that are.
`CLAUDE.md` has the rules every teammate follows and who owns what.

It never registers scheduled tasks. The nightly searches run on one machine
only: two machines would run every search twice and race each other writing the
same search docs. `scripts\setup-scheduler.ps1` stays a deliberate step on that
one machine.

## The roles

In this order. The title is the role name spelled exactly - that is how step 2
recognises a teammate that already exists.

| Title | First message |
|---|---|
| Product Partner | You are Product Partner. |
| Backend Buddy | You are Backend Buddy. |
| Client Comrade | You are Client Comrade. |
| Prompt Bro | You are Prompt Bro. |
| Fullstack Friend | You are Fullstack Friend. |
| Clean Code Companion | You are Clean Code Companion. |
| Documentation Dude | You are Documentation Dude. |

## 1. Check the machine

Check everything below before creating anything. If any check fails, stop and
list every failure with what fixes it; don't create part of the team.

- **A git checkout with an `origin`:** `git rev-parse --show-toplevel` succeeds
  and `git remote get-url origin` prints a URL.
- **`claude` is installed and signed in:** `claude --version` succeeds, and
  either `CLAUDE_CODE_OAUTH_TOKEN` is set or `claude auth status` reports a
  signed-in account. Fix: `claude setup-token`, then
  `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"` and a new terminal.
- **Only if this machine will run the nightly searches** - ask the user if it
  isn't clear: `private\` (or `$JOB_SEARCH_DATA_DIR`) exists and holds at least
  one `<user-id>\tracker.json`. Fix: copy `private\` from the machine that has
  it, by hand; see `private.example/README.md`. It is never committed.

## 2. List the sessions that exist

List this app's sessions and collect their titles. A role whose title matches
exactly is already running: skip it, and don't rename, restart or message it.

If the app offers no way to list sessions, ask the user which roles are already
running on this machine.

## 3. Start each missing role

**When the app offers a tool to start a session,** for each missing role in
table order:

1. Start a new session in its own worktree of this repo.
2. Title it with the role name.
3. Pin it.
4. Send the first message, `You are <role name>.`

If a step fails for one role, note the failure and carry on with the next role.

**When the app offers no such tool,** print the roles still to start, in table
order, one block each:

```
Title:          Backend Buddy
First message:  You are Backend Buddy.
```

Tell the user to start a new session in its own worktree for each, set the
title exactly as shown, and send the first message.

## 4. Offer Remote Control

For the sessions this run created, ask once whether to turn on Remote Control
for them. Turn it on only for the ones the user says yes to. Don't change it on
sessions that were already running.

## 5. Report

One line per role, in table order:

- **created** - started, titled, pinned and messaged (say if Remote Control is
  on);
- **already running** - its title already existed;
- **start by hand** - printed for the user, or a step failed (say which).

End with the step that stays manual when this machine runs the searches:
`scripts\setup-scheduler.ps1`, on this machine only.
