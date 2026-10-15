-- Migration: 009_create_payments_and_allocations.sql
-- Payments received from customers and allocation of payments to invoices.
--
-- Key design notes:
--   • A payment is recorded immediately with its full amount.
--   • Allocation is a separate, later step.
--   • Unallocated credit = SUM(payments.amount) - SUM(active allocations)
--   • payment_allocations uses a PARTIAL UNIQUE INDEX (not table constraint)
--     so that voiding an allocation and creating a replacement is permitted.
--   • Allocation limit checks happen in the application within a locked transaction.
--
-- Locking order for all allocation operations (prevents deadlocks):
--   1. Lock payments row first (FOR UPDATE)
--   2. Lock sales row second (FOR UPDATE)
--   Never reverse this order.

BEGIN;

CREATE TABLE payments (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id          UUID          REFERENCES parties(id) ON DELETE RESTRICT,
  payment_timestamp TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  payment_date      DATE          NOT NULL,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method            TEXT          NOT NULL DEFAULT 'cash'
                      CHECK (method IN ('cash', 'upi', 'bank', 'other')),
  external_ref      TEXT,
  notes             TEXT,
  created_by        UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  voided_at         TIMESTAMPTZ,
  voided_by         UUID          REFERENCES users(id) ON DELETE RESTRICT,
  void_reason       TEXT,

  CONSTRAINT chk_payment_void_fields
    CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);

CREATE TABLE payment_allocations (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       UUID          NOT NULL REFERENCES payments(id)  ON DELETE RESTRICT,
  sale_id          UUID          NOT NULL REFERENCES sales(id)      ON DELETE RESTRICT,
  allocated_amount NUMERIC(12,2) NOT NULL CHECK (allocated_amount > 0),
  created_by       UUID          NOT NULL REFERENCES users(id)      ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  voided_at        TIMESTAMPTZ,
  voided_by        UUID          REFERENCES users(id)               ON DELETE RESTRICT,
  void_reason      TEXT,

  CONSTRAINT chk_allocation_void_fields
    CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);

-- ── Partial unique index ──────────────────────────────────────────────────
-- One ACTIVE (non-voided) allocation per payment+sale pair.
-- A new allocation for the same pair is permitted after voiding the previous one.
CREATE UNIQUE INDEX idx_active_allocation_per_pair
  ON payment_allocations(payment_id, sale_id)
  WHERE voided_at IS NULL;

COMMENT ON TABLE  payments                 IS 'Customer payment receipts. Void instead of delete.';
COMMENT ON COLUMN payments.amount          IS 'Full payment amount. Must be > 0.';
COMMENT ON TABLE  payment_allocations      IS 'Allocation of a payment to a specific invoice (sale).';
COMMENT ON COLUMN payment_allocations.allocated_amount IS
  'Amount from the parent payment applied to this invoice. > 0. Enforced <= payment.amount by application.';

COMMIT;
