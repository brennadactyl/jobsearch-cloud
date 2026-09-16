-- intake: what a new person asked for on the setup form, waiting for the
-- overnight run that turns it into their search.
--
-- One row per account. The person writes it (POST /api/intake, their own
-- session), and the onboarding run reads every row still waiting and records
-- how it went (GET /api/intake/pending and POST /api/intake/complete,
-- ADMIN_TOKEN). The answers are the form's, stored as sent: the run needs every
-- field, and a field the form adds later needs no migration to carry. The
-- fields the run cannot work without are checked on the way in
-- (routes/onboarding.js).
--
--   user_id      the account, and the primary key: a person has one setup
--   answers      the form's answers as JSON
--   status       pending - waiting for the run
--                done    - the run built the search; the form is closed
--                failed  - the run could not, and status_note says why
--   status_note  plain text the run wrote for the person; '' unless it had
--                something to say
--   sent_at      ISO 8601 instant the current attempt began: the first send, or
--                the send that followed a failure. Editing a pending setup
--                leaves it alone, so the page's "this hasn't run yet" warning,
--                which counts from it, cannot be put off by an edit.
--   updated_at   ISO 8601 instant of the last change of any kind

CREATE TABLE IF NOT EXISTS intake (
  user_id     TEXT PRIMARY KEY,
  answers     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  status_note TEXT NOT NULL DEFAULT '',
  sent_at     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);
