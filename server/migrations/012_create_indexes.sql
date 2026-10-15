-- Migration: 012_create_indexes.sql
-- Secondary indexes for performance on common query patterns.
-- All primary keys and UNIQUE constraints already have implicit indexes.
-- This file adds non-unique indexes for foreign keys and frequent filters.

BEGIN;

-- ── chicken_loads ─────────────────────────────────────────────────────────
CREATE INDEX idx_chicken_loads_date
  ON chicken_loads(load_date DESC);

CREATE INDEX idx_chicken_loads_created_by
  ON chicken_loads(created_by);

-- ── stock_entries ─────────────────────────────────────────────────────────
-- Most common query: observations for a product, newest first
CREATE INDEX idx_stock_entries_product_date
  ON stock_entries(product_id, observed_at DESC);

CREATE INDEX idx_stock_entries_created_by
  ON stock_entries(created_by);

-- ── daily_prices ──────────────────────────────────────────────────────────
-- Most common query: latest price for a product
CREATE INDEX idx_daily_prices_product_date
  ON daily_prices(product_id, effective_date DESC);

-- ── parties ───────────────────────────────────────────────────────────────
CREATE INDEX idx_parties_name
  ON parties(name);   -- name lookups (not unique — two customers may share a name)

CREATE INDEX idx_parties_active
  ON parties(is_active)
  WHERE is_active = TRUE;   -- partial: active customers only

-- ── account_adjustments ───────────────────────────────────────────────────
CREATE INDEX idx_account_adjustments_party
  ON account_adjustments(party_id);

CREATE INDEX idx_account_adjustments_active
  ON account_adjustments(party_id, effective_date DESC)
  WHERE voided_at IS NULL;

-- ── sales ─────────────────────────────────────────────────────────────────
CREATE INDEX idx_sales_date
  ON sales(sale_date DESC);

CREATE INDEX idx_sales_party
  ON sales(party_id)
  WHERE party_id IS NOT NULL;

-- Partial index for active credit sales — used by ledger balance queries
CREATE INDEX idx_sales_active_credit
  ON sales(party_id, sale_date DESC)
  WHERE sale_type = 'party_credit'
    AND status = 'confirmed'
    AND voided_at IS NULL;

CREATE INDEX idx_sales_created_by
  ON sales(created_by);

-- ── sale_items ────────────────────────────────────────────────────────────
CREATE INDEX idx_sale_items_sale
  ON sale_items(sale_id);

CREATE INDEX idx_sale_items_product
  ON sale_items(product_id);

-- ── payments ──────────────────────────────────────────────────────────────
CREATE INDEX idx_payments_party
  ON payments(party_id)
  WHERE party_id IS NOT NULL;

-- Partial index for active payments — used by unallocated credit queries
CREATE INDEX idx_payments_active
  ON payments(party_id, payment_date DESC)
  WHERE voided_at IS NULL;

-- ── payment_allocations ───────────────────────────────────────────────────
CREATE INDEX idx_alloc_payment
  ON payment_allocations(payment_id);

CREATE INDEX idx_alloc_sale
  ON payment_allocations(sale_id);

-- Partial index for active allocations — used by balance and invoice queries
CREATE INDEX idx_alloc_active_by_sale
  ON payment_allocations(sale_id)
  WHERE voided_at IS NULL;

CREATE INDEX idx_alloc_active_by_payment
  ON payment_allocations(payment_id)
  WHERE voided_at IS NULL;

-- ── audit_logs ────────────────────────────────────────────────────────────
CREATE INDEX idx_audit_entity
  ON audit_logs(entity_type, entity_id);

CREATE INDEX idx_audit_actor
  ON audit_logs(actor_id);

CREATE INDEX idx_audit_timestamp
  ON audit_logs(event_timestamp DESC);

COMMIT;
