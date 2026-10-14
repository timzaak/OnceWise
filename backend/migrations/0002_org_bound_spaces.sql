-- Org-bound spaces: a space is addressed EITHER by its access key (key_hash; legacy spaces
-- and AUTH_MODE=none deployments) OR by Herald organization membership (org_id). The CHECK
-- keeps the two addressing methods mutually exclusive (never both); org-bound creation
-- inserts the row with both NULL inside its transaction and fills org_id after the Herald
-- registration succeeds, so committed rows always carry exactly one addressing method —
-- PostgreSQL CHECKs are non-deferrable, hence "at most one" rather than "exactly one". The
-- UNIQUE index on org_id binds at most one space per organization (org_id carries no
-- cross-database FK: the organization entity lives in Herald, consistency is enforced by the
-- create/delete flows plus the access layer's fail-closed org_not_found handling).
ALTER TABLE spaces
  ALTER COLUMN key_hash DROP NOT NULL,
  ADD COLUMN org_id TEXT,
  ADD CONSTRAINT spaces_addressing_mutually_exclusive CHECK (num_nonnulls(key_hash, org_id) <= 1);

CREATE UNIQUE INDEX idx_spaces_org_id ON spaces(org_id);

-- One-time invite codes: only sha256(full "{spaceId}#iv-…" string) rows are stored — the
-- hash input includes the space id prefix, so a code can never be replayed against a
-- different space. Single use (used_at set once, never reset), 24 h validity; no member
-- identity is recorded (membership facts live in Herald). Time fields stay fixed-width
-- RFC 3339 UTC millisecond text (db::now_utc), so lexicographic order equals chronological
-- order.
CREATE TABLE space_invites (
  code_hash  TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX idx_space_invites_space ON space_invites(space_id);
