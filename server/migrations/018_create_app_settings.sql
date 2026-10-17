-- Migration: 018_create_app_settings.sql
-- Application settings storage for Bismillah Chicken Shop.
-- Stores shop profile, business preferences, operational defaults, and security policies.

BEGIN;

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE  app_settings            IS 'Application configuration and system preferences.';
COMMENT ON COLUMN app_settings.key        IS 'Stable key identifier for settings category (e.g., shop_profile).';
COMMENT ON COLUMN app_settings.value      IS 'Validated configuration JSON. Never store plain credentials or DB secrets.';
COMMENT ON COLUMN app_settings.updated_by IS 'Admin user who last updated this configuration.';

-- Seed default application settings
INSERT INTO app_settings (key, value, description)
VALUES
  ('shop_profile', '{
    "shop_name": "Bismillah Chicken Shop",
    "tagline": "Fresh & Quality Halal Poultry",
    "phone": "+91 98765 43210",
    "email": "contact@bismillahchicken.com",
    "address": "Main Market Road, Near Jamia Masjid, Bengaluru, Karnataka 560001",
    "tax_id": "29AAAAA0000A1Z5"
  }'::jsonb, 'Shop contact, branding, and invoice header information'),

  ('business_preferences', '{
    "timezone": "Asia/Kolkata",
    "currency_code": "INR",
    "currency_symbol": "₹",
    "date_format": "YYYY-MM-DD",
    "weight_unit": "kg"
  }'::jsonb, 'Regional display, currency, and date formatting preferences'),

  ('operational_preferences', '{
    "low_stock_threshold_kg": 50.0,
    "max_credit_limit_default": 25000.0,
    "default_payment_mode": "cash",
    "print_receipt_on_sale": true,
    "allow_credit_sales_for_walkin": false
  }'::jsonb, 'Shop-floor operations, credit defaults, and inventory alerts'),

  ('security_policy', '{
    "session_timeout_hours": 8,
    "max_login_attempts": 5,
    "lockout_minutes": 15,
    "password_min_length": 8,
    "require_password_change_days": 90
  }'::jsonb, 'Session expiration, brute-force lockout, and password policy standards')
ON CONFLICT (key) DO NOTHING;

COMMIT;
