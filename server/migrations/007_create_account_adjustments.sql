-- Migration: 007_create_account_adjustments.sql
-- Ledger adjustments: opening balances, credit notes, write-offs, corrections.
--
-- Sign convention (CRITICAL — must be applied consistently everywhere):
--   ledger_effect > 0  →  credit to customer  (REDUCES what they owe us)
--   ledger_effect < 0  →  debit against customer (INCREASES what they owe us)
--
-- Opening balance example:
--   Customer owes ₹10,000 from before the system existed.
--   INSERT ledger_effect = -10000.00
--   Net effect on balance: -(-10000) = +10000 ← customer balance rises by ₹10,000 ✓
--
-- One opening_balance per party enforced by the partial unique index below.
-- To correct an opening balance: void the old row, insert a new one.

BEGIN;

CREATE TABLE account_adjustments (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id        UUID          NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  adjustment_type TEXT          NOT NULL
                    CHECK (adjustment_type IN (
                      'opening_balance', 'credit_note', 'write_off',
                      'correction', 'other'
                    )),
  -- Positive = credit (reduces what they owe)
  -- Negative = debit  (increases what they owe)
  ledger_effect   NUMERIC(12,2) NOT NULL,
  effective_date  DATE          NOT NULL,
  reason          TEXT          NOT NULL
                    CHECK (LENGTH(TRIM(reason)) > 0),
  created_by      UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  approved_by     UUID          REFERENCES users(id) ON DELETE RESTRICT,
  voided_at       TIMESTAMPTZ,
  voided_by       UUID          REFERENCES users(id) ON DELETE RESTRICT,
  void_reason     TEXT,

  -- Void fields must be consistent
  CONSTRAINT chk_adjustment_void_fields
    CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);

-- ── One active opening balance per party ──────────────────────────────────
-- Partial unique index: applies only to non-voided opening_balance rows.
-- When an opening balance is voided, the WHERE clause no longer covers it,
-- so a new opening_balance row for the same party is permitted.
CREATE UNIQUE INDEX idx_one_opening_balance_per_party
  ON account_adjustments(party_id)
  WHERE adjustment_type = 'opening_balance' AND voided_at IS NULL;

COMMENT ON TABLE  account_adjustments             IS 'Ledger adjustments: opening balances, credit notes, write-offs.';
COMMENT ON COLUMN account_adjustments.ledger_effect IS
  'Positive = credit to customer (reduces balance). Negative = debit (increases balance). See migration comment for sign convention.';

COMMIT;
