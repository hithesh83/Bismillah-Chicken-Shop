-- Migration: 006_create_parties.sql
-- Customer and hotel accounts (credit-enabled parties).
--
-- Key design notes:
--   • party_code is the human-readable customer ID (e.g. HTL-001).
--   • name is NOT unique — two "Ahmed Hotel" entries are valid.
--   • No opening_balance column: opening balances are account_adjustments
--     rows (type='opening_balance') enforced by a partial unique index.
--   • Deactivate instead of deleting when financial history exists.

BEGIN;

CREATE TABLE parties (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  party_code     TEXT        NOT NULL UNIQUE,
  name           TEXT        NOT NULL,
  phone          TEXT,
  address        TEXT,
  party_type     TEXT        NOT NULL DEFAULT 'hotel'
                   CHECK (party_type IN ('hotel', 'party', 'retail')),
  credit_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No opening_balance field. See account_adjustments.
);

COMMENT ON TABLE  parties                IS 'Hotels, parties and retail credit customers.';
COMMENT ON COLUMN parties.party_code     IS 'Human-readable customer ID, e.g. HTL-001. Unique.';
COMMENT ON COLUMN parties.name           IS 'NOT unique — two customers with identical names are valid.';
COMMENT ON COLUMN parties.credit_enabled IS 'TRUE allows party_credit sale type for this customer.';

COMMIT;
