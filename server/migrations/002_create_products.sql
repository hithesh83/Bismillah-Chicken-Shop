-- Migration: 002_create_products.sql
-- Creates the products table and inserts the 6 seed products.
-- seed_key is the stable identifier for idempotent re-seeding.
-- Product categories:
--   whole  = live chicken, dressed chicken (processing stages)
--   cut    = boneless, wings, leg piece (saleable cuts)
--   offal  = liver

BEGIN;

CREATE TABLE products (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_key   TEXT        NOT NULL UNIQUE,
  name       TEXT        NOT NULL,
  category   TEXT        NOT NULL DEFAULT 'whole'
               CHECK (category IN ('whole', 'cut', 'offal')),
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  products          IS 'Product catalogue. Deactivate instead of deleting.';
COMMENT ON COLUMN products.seed_key IS 'Stable key for idempotent seeding. Never change after creation.';
COMMENT ON COLUMN products.category IS 'whole | cut | offal — processing stage grouping.';

-- ── Idempotent seed data ──────────────────────────────────────────────────
-- Uses ON CONFLICT (seed_key) DO NOTHING so re-running is safe.
INSERT INTO products (seed_key, name, category) VALUES
  ('live_chicken',     'Live Chicken',    'whole'),
  ('dressed_chicken',  'Dressed Chicken', 'whole'),
  ('boneless',         'Boneless',        'cut'),
  ('wings',            'Wings',           'cut'),
  ('leg_piece',        'Leg Piece',       'cut'),
  ('liver',            'Liver',           'offal')
ON CONFLICT (seed_key) DO NOTHING;

COMMIT;
