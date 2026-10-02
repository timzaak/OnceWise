-- No-account space model (DEC-data-sync-007): the server keeps only spaces (id + key hash),
-- scripts and immutable script versions — no users, tokens, members or invitations tables. Space
-- and script ids are client-generated opaque strings (TEXT primary keys); the only server-allocated
-- value is the script version number (MAX+1 under the scripts row lock, see routes/scripts.rs).
-- Time fields are fixed-width RFC 3339 UTC millisecond text (D2-B7), produced by db::now_utc only.
CREATE TABLE spaces (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL,                 -- SHA-256 hex of the space access key (constant-time compare)
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE scripts (
  id         TEXT PRIMARY KEY,              -- client-generated; global collision → 409 SCRIPT_EXISTS
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_scripts_space ON scripts(space_id);

CREATE TABLE script_versions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  script_id      TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version_number BIGINT NOT NULL,
  content        TEXT NOT NULL,             -- flow JSON text snapshot (immutable)
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  UNIQUE (script_id, version_number)
);
