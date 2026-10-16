-- Migration: 016_add_idempotency_key_to_sales.sql
-- Add idempotency_key to sales table for duplicate submission protection.

BEGIN;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_sales_idempotency_key
  ON sales(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN sales.idempotency_key IS 'Optional client-provided unique key to prevent duplicate sale creation on network retries.';

COMMIT;
