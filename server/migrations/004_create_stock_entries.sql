-- Migration: 004_create_stock_entries.sql
-- Physical stock observations (manual, independent of sales or loads).
--
-- Key design notes:
--   • Multiple observations per product per day are supported.
--   • No updated_at — observations are immutable. Corrections = new rows.
--   • Quantities are never auto-calculated from sales or loads.
--   • Negative quantities are prohibited.

BEGIN;

CREATE TABLE stock_entries (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  product_id  UUID          NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity_kg NUMERIC(10,3) NOT NULL
                CHECK (quantity_kg >= 0),
  notes       TEXT,
  created_by  UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- No updated_at: observations are append-only. Create a new row to correct.
);

COMMENT ON TABLE  stock_entries IS 'Manual physical stock observations. Append-only; no deletes.';
COMMENT ON COLUMN stock_entries.observed_at IS 'Exact observation time (UTC stored, IST displayed).';

COMMIT;
