-- Migration: 015_enhance_parties_for_customer_management.sql
-- Customer management enhancements:
--   1. Add updated_by tracking column to parties
--   2. Add sequence for auto-generating party_code (e.g. PTY-00001) if not provided
--   3. Add indexes on phone and party_type for fast search and filtering

BEGIN;

CREATE SEQUENCE IF NOT EXISTS party_code_seq START 1 INCREMENT 1;

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE parties
  ALTER COLUMN party_code SET DEFAULT 'PTY-' || LPAD(nextval('party_code_seq')::TEXT, 5, '0');

CREATE INDEX IF NOT EXISTS idx_parties_phone
  ON parties(phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parties_party_type
  ON parties(party_type);

COMMENT ON COLUMN parties.updated_by IS 'User who last modified the customer profile.';

COMMIT;
