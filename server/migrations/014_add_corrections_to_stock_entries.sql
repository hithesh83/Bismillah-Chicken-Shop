-- Migration: 014_add_corrections_to_stock_entries.sql
-- Add audit corrections tracking to manual stock_entries.
--
-- Key design notes:
--   • Point-in-time stock observations remain immutable.
--   • Authorized corrections do not update existing rows. Instead, a new row
--     is inserted with is_correction = TRUE, pointing to the original entry
--     via corrects_entry_id, with a mandatory correction_reason.
--   • Both the original observation and its correction are preserved in the DB.

BEGIN;

ALTER TABLE stock_entries
  ADD COLUMN IF NOT EXISTS is_correction BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS corrects_entry_id UUID REFERENCES stock_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS correction_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_stock_correction_needs_ref'
  ) THEN
    ALTER TABLE stock_entries
      ADD CONSTRAINT chk_stock_correction_needs_ref
        CHECK (is_correction = FALSE OR corrects_entry_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stock_entries_corrects_entry
  ON stock_entries(corrects_entry_id)
  WHERE corrects_entry_id IS NOT NULL;

COMMENT ON COLUMN stock_entries.is_correction IS 'TRUE if this row represents an authorized admin correction of a prior observation.';
COMMENT ON COLUMN stock_entries.corrects_entry_id IS 'Points to the original observation row being corrected. Never null when is_correction=TRUE.';
COMMENT ON COLUMN stock_entries.correction_reason IS 'Mandatory human-readable explanation of why the observation was corrected.';

COMMIT;
