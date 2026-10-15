-- Migration: 001_create_users.sql
-- Creates the users table.
-- All other tables reference users(id) for created_by / actor fields.
-- Deletion rule: no hard deletes; set is_active = FALSE instead.

BEGIN;

CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT        NOT NULL,
  login_email   TEXT        NOT NULL UNIQUE,
  -- password_hash is populated in Phase 3 (authentication)
  -- Never store plain-text passwords here
  password_hash TEXT,
  role          TEXT        NOT NULL DEFAULT 'staff'
                              CHECK (role IN ('admin', 'manager', 'staff')),
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  users              IS 'Application users. Deactivate instead of deleting.';
COMMENT ON COLUMN users.password_hash IS 'Populated in Phase 3. Never store plain text.';
COMMENT ON COLUMN users.role          IS 'admin | manager | staff';

COMMIT;
