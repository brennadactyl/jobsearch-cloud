# Account settings, where the password already is

"Signed in as <name>" opens an account panel. Changing your password is one
section of it; the rest is the search you described when you signed up, editable
for as long as you have the account.

This changes `client/` (the panel), `server/` (a field-scoped settings route and
an answers edit) and the overnight run (it rewrites prose when the answers
change). It builds on [instant-setup-plan.md](instant-setup-plan.md), whose
ownership split decides what each edit is allowed to touch.

## Context

Everything a person typed at signup is fixed once they send it. The setup form
is one-shot by design - retyping answers into a form that is only read once is
churn. But a job search changes: the pay floor moves, a city comes off the list,
a title stops being the one you want. Today that needs the operator and the
`job-search-setup` skill.

The password dialog is already the one place a person goes to change something
about their own account, and it is already reached from the header. The settings
belong there rather than in a new place.

## Two kinds of edit

The split is the same one the write paths already enforce, and it decides what
the panel promises after each save.

**Takes effect immediately** - values, written straight through:

| Field | |
|---|---|
| Page title | `display_title` |
| Pronouns | `settings.pronouns` |
| Which locations come first | `priority_locations`, recomputed by the page from the typed list, with the same read-back and short-token warning as the setup form |
| Companies you'd never work for | `excluded_companies` |
| What each search is called | each track's `label` |

**Takes effect tonight** - answers the overnight run turns into prose:

| Field | Feeds |
|---|---|
| Where can you work? | the scope wording |
| Anywhere you can't take a job? | the disqualifier |
| Per search: what roles? | the role line and description |
| Per search: kinds of companies | the candidate profile |
| Per search: anything that rules a job out | the fit clauses |
| Per search: lowest acceptable pay | the fit filter |
| Preferences the search should weigh | the candidate profile |

Each section says which it is. An answer edit shows "tonight's run applies
this" until the write-up lands.

## Your resume

A resume section in the same panel. It works for every account, including ones
set up by hand before invites existed, because it is built on the search's own
document list (`tracks.documents`, [schema.md](schema.md)) rather than on setup
answers - an account set up by the skill has no intake row at all.

- **It lists the files the account has** under `resumes/`, with their dates,
  from `GET /api/documents`. Uploading adds one; removing one deletes it.
- **Each resume says which tabs it drives**: the searches whose `documents` list
  holds its path, plus any tab filled by one of them (`fed_by`). A resume no
  search lists reads "not used by any search".
- **Each search gets a picker** of the account's readable resumes. Choosing one
  writes that search's `documents` entry through `POST /api/settings`, and takes
  effect on the search's next run, which downloads what the list names. One
  resume can drive several searches.
- **The daily prompt reads the resume the list names**, not a file named inside
  `resume_line`. `resume_line` keeps only how this search frames the resume, so
  swapping a file never leaves prose pointing at the old one.
- **The same format rule as the setup form**: `.txt`, `.md` and `.pdf` are
  readable overnight, from the one shared constant; the 8 MB cap and the
  filename rule are the documents route's.
- **A search cannot be left without a readable resume.** Removing a file a
  search lists, or picking an unreadable one, is refused naming the search.
- **The candidate profile catches up on the next run.** A changed resume marks
  that search's profile stale, and its next run rewrites the profile section of
  its doc from the new file before searching, then clears the mark.

## Server

- **`POST /api/settings`** (session token) accepts only the fields the form
  owns - the immediate list above - and refuses any other key by name. It is
  the mirror of `POST /api/writeup`: neither can write the other's fields,
  whatever it is sent. `POST /api/config` stays as it is for the tracker's own
  configuration.
- **`PUT /api/intake/answers`** (session token) replaces the stored answers
  after `done` or `failed`, and sets the intake back to `pending` with a reason
  of `edit`. This is also how a failed setup is recovered: a note that says the
  resume couldn't be read links to the resume section here, and fixing it there
  is what gets the search built.
  The setup form itself stays one-shot: `POST /api/intake` still refuses a
  second send, so the panel is the only way to change an answer.
- **The scope check runs on edit too**, with the same loose rule and the same
  400 naming `work_scope`, so the panel cannot store a scope that rules out
  every preferred location.
- `verify-local` proves: the settings route cannot write a write-up field, the
  answers edit cannot write config, and an edit leaves every track key, lead
  and application untouched.

## The overnight run

A `pending` intake with reason `edit` is a rewrite, not a build:

- It writes the prose fields for the tracks that already exist, through
  `POST /api/writeup`, and creates nothing.
- **It does not regenerate the track doc.** The per-company fetch notes and the
  record of where a search has already looked are earned over weeks; an edited
  pay floor is no reason to lose them. It updates the doc's candidate profile
  section only.
- Tokens, folders and scheduled tasks are already in place, so it skips them.

## What the person sees

- **The header button is unchanged**: "Signed in as <name>". The dialog it opens
  gains sections, with Password first, then the search.
- **Each section saves on its own**, through the header's save indicator, the
  same as any other write on the page.
- **No deleting or adding a search here.** Adding a role is a new search with a
  new tab, and removing one has leads and applications hanging off it; both need
  their own design.
- Works at phone width and in both themes.

## Not in this change

Adding or removing a search, editing the prose the run wrote, a self-service
password reset for someone locked out, and deleting your own account.
