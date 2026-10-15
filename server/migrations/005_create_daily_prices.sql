-- Migration: 005_create_daily_prices.sql
-- Product pricing by effective date.
--
-- Key design notes:
--   • One price per product per effective_date (UNIQUE constraint).
--   • Prices are snapshots — past prices are never modified.
--   • sale_items capture the rate at sale time; later price changes
--     have zero effect on historical sale records.
--   • effective_date uses DATE (business calendar day in IST).
--     To query today's price: WHERE effective_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE

BEGIN;

CREATE TABLE daily_prices (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     UUID          NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  effective_date DATE          NOT NULL,
  rate_per_kg    NUMERIC(10,2) NOT NULL
                   CHECK (rate_per_kg > 0),
  created_by     UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- One price record per product per business day
  UNIQUE (product_id, effective_date)
);

COMMENT ON TABLE  daily_prices               IS 'Snapshot prices per product per business date.';
COMMENT ON COLUMN daily_prices.effective_date IS 'Business calendar date (IST). Use DATE, not TIMESTAMPTZ.';
COMMENT ON COLUMN daily_prices.rate_per_kg    IS 'Price at time of entry. Historical rates are immutable.';

COMMIT;
