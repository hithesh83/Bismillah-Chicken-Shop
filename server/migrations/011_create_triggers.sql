-- Migration: 011_create_triggers.sql
-- All trigger functions and trigger attachments.
-- Kept in one file so trigger logic is easy to review together.
--
-- Triggers created here:
--   1. set_updated_at()          — auto-update updated_at on all relevant tables
--   2. fn_sales_no_direct_confirm()  — block INSERT with status='confirmed'
--   3. fn_sales_validate_on_confirm() — validate total = SUM(items) on draft→confirmed
--   4. fn_sale_items_immutable()      — block changes to items of confirmed/voided sales

BEGIN;

-- ── 1. updated_at maintenance ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Apply to every table that has an updated_at column
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_chicken_loads_updated_at
  BEFORE UPDATE ON chicken_loads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_parties_updated_at
  BEFORE UPDATE ON parties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sales_updated_at
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. Block direct confirmed INSERT ─────────────────────────────────────
-- Prevents any session (including direct psql) from inserting a sale that
-- bypasses the draft → confirm workflow.
CREATE OR REPLACE FUNCTION fn_sales_no_direct_confirm()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    RAISE EXCEPTION
      'Direct INSERT with status=confirmed is not allowed. '
      'Insert as draft, add items, then confirm via the application workflow.';
  END IF;
  IF NEW.status = 'voided' THEN
    RAISE EXCEPTION
      'Direct INSERT with status=voided is not allowed. '
      'Create a confirmed sale first, then use the void workflow.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_no_direct_confirm
  BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION fn_sales_no_direct_confirm();

-- ── 3. Validate total and item count on draft → confirmed ─────────────────
-- Fires when status changes from 'draft' to 'confirmed'.
-- Overwrites total_amount with the DB-computed SUM(line_total).
-- Rejects confirmation if: no items exist, or computed total <= 0.
CREATE OR REPLACE FUNCTION fn_sales_validate_on_confirm()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item_count INT;
  actual_sum NUMERIC(12,2);
BEGIN
  -- Only run on draft → confirmed transition
  IF NOT (OLD.status = 'draft' AND NEW.status = 'confirmed') THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(line_total), 0::NUMERIC(12,2))
    INTO item_count, actual_sum
    FROM sale_items
    WHERE sale_id = NEW.id;

  IF item_count = 0 THEN
    RAISE EXCEPTION
      'Cannot confirm sale %: at least one line item is required.', NEW.id;
  END IF;

  -- Overwrite the application-declared total with the authoritative DB sum
  NEW.total_amount := actual_sum;

  -- Guard: confirmed sale must have a positive total
  IF NEW.total_amount <= 0 THEN
    RAISE EXCEPTION
      'Cannot confirm sale %: total_amount is % after summing line items. '
      'All line items must produce line_total > 0.',
      NEW.id, NEW.total_amount;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_validate_on_confirm
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION fn_sales_validate_on_confirm();

-- ── 4. Prevent modifications to confirmed/voided sale items ───────────────
-- Fires on any INSERT, UPDATE, or DELETE on sale_items.
-- Checks the parent sale's status at the time of the operation.
-- Cannot be bypassed by direct SQL (triggers run for all sessions).
CREATE OR REPLACE FUNCTION fn_sale_items_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  parent_status TEXT;
BEGIN
  SELECT status INTO parent_status
    FROM sales
    WHERE id = CASE TG_OP WHEN 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END;

  IF parent_status = 'confirmed' THEN
    RAISE EXCEPTION
      'sale_items for a confirmed sale are immutable. '
      'Use the void-and-correct workflow to create a replacement sale.';
  END IF;

  IF parent_status = 'voided' THEN
    RAISE EXCEPTION
      'sale_items for a voided sale cannot be modified.';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_sale_items_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION fn_sale_items_immutable();

COMMIT;
