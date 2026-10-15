-- Migration: 013_harden_users_for_auth.sql
-- Phase 3: make password_hash mandatory, add brute-force protection columns.
--
-- Changes:
--   1. password_hash TEXT → NOT NULL  (every user must have a hashed password)
--   2. failed_login_attempts INT      (count of consecutive bad passwords)
--   3. locked_until TIMESTAMPTZ       (account locked until this time; NULL = not locked)
--   4. last_login_at TIMESTAMPTZ      (audit: when the user last successfully logged in)
--   5. last_login_ip TEXT             (audit: IP of last successful login; never for tracking)
--
-- NOTE: This migration sets password_hash NOT NULL with a DEFAULT of a permanently
--   invalid hash ('!') so existing rows with NULL password_hash pass the constraint.
--   The '!' prefix is bcrypt-invalid and can never be produced by bcrypt. This means
--   rows seeded with no password are locked until a password is explicitly provisioned
--   via the provision-admin script.

BEGIN;

-- Add brute-force protection columns with safe defaults
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_ip         TEXT;

-- Update any NULL password_hash rows to the permanently-invalid sentinel value
-- '!' is not a valid bcrypt hash prefix, so these accounts cannot be logged into
UPDATE users SET password_hash = '!' WHERE password_hash IS NULL;

-- Now enforce NOT NULL
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;

-- Add a default of '!' for future INSERT statements that omit password_hash
-- (the provision-admin script always provides a real bcrypt hash)
ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT '!';

COMMENT ON COLUMN users.password_hash          IS 'bcrypt hash. Never plain text. Default ! means account locked.';
COMMENT ON COLUMN users.failed_login_attempts  IS 'Consecutive failed logins. Reset to 0 on success.';
COMMENT ON COLUMN users.locked_until           IS 'If non-NULL and in future, account is temporarily locked.';
COMMENT ON COLUMN users.last_login_at          IS 'Timestamp of last successful login for audit purposes.';
COMMENT ON COLUMN users.last_login_ip          IS 'IP of last successful login. NOT used for tracking users.';

COMMIT;
