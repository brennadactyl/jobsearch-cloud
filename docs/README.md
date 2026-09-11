# docs

Two kinds of document live here, and the filename says which.

## Reference

The system as it exists today. When a change makes one of these wrong, it
updates the doc in the same commit. CI checks `schema.md` against the
migrations (`server/verify-schema-doc.mjs`).

- [`schema.md`](schema.md) — every D1 table, its columns, and how they relate
- [`architecture.svg`](architecture.svg) and
  [`architecture.html`](architecture.html) — components and data flow (open the
  HTML locally; GitHub shows its source)

## Plans — `*-plan.md`

A change someone intends to make, written before it is built. A plan describes
where the system is going, not where it is; once it lands, the code and the
reference docs above are the authority.

- [`multi-user-plan.md`](multi-user-plan.md) — accounts, and an owner on every row
- [`private-storage-plan.md`](private-storage-plan.md) — resumes and baseline docs moved into R2
- [`prompt-size-plan.md`](prompt-size-plan.md) — cutting the nightly prompt down
- [`react-adoption-plan.md`](react-adoption-plan.md) — the tracker page rebuilt in React, beside the one that ships
- [`rotation-always-on-plan.md`](rotation-always-on-plan.md) — every search rotates through its companies
- [`one-company-list-plan.md`](one-company-list-plan.md) — one global company list that every search indexes into

## Adding a document

Name a plan `<topic>-plan.md`. Anything else in this folder is reference.

A plan that touches something a reference doc covers links to it and describes
only what it changes — it does not copy the current state in.
