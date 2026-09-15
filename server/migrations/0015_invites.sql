-- invites: how a new person gets an account without the operator choosing
-- their password.
--
-- The operator mints a code (POST /api/invites, ADMIN_TOKEN) and sends the
-- person a link carrying it. The person redeems it once at POST /api/signup,
-- choosing their own name and password. Two public routes read this table -
-- GET /api/invite/<code> and POST /api/signup - and neither is authenticated or
-- throttled, so a code has to be unguessable rather than merely unpublished:
-- 32 random bytes from the Workers CSPRNG, the same as a session token. Only the
-- SHA-256 of a code is stored, so a backup or an export hands over no usable
-- invite - the property sessions.id has for the same reason.
--
--   id          the ledger's handle for an invite, and what revoking names
--   code_hash   base64 SHA-256 of the code; every lookup goes through it
--   note        the operator's reminder of who the invite was for
--   created_at  ISO 8601 instant
--   expires_at  ISO 8601 instant; 14 days after creation unless the operator
--               asks for fewer or more, never more than 30
--   used_at     ISO 8601 instant the invite created an account; '' while unused
--   used_by     id of the account it created; '' while unused
--   revoked_at  ISO 8601 instant the operator withdrew it; '' while not
--
-- `used_by` rather than `user_id`. Every `user_id` column in this schema means
-- the row belongs to that person, which is what db.js scopes each statement
-- on. An invite belongs to the deployment, and only names the account it
-- produced.
--
-- Claiming an invite and creating its account run in one D1 batch, which is one
-- transaction: neither can land without the other, and two people racing one
-- link produce one account (src/onboarding.js).

CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT NOT NULL UNIQUE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT NOT NULL DEFAULT '',
  used_by    TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT ''
);
