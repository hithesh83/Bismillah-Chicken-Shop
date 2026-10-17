/**
 * server/src/routes/settings.js
 *
 * Application Settings API endpoints.
 *
 * Capabilities:
 *   1. GET   /api/settings       — read settings (all authenticated users; security masked for non-admin)
 *   2. PUT   /api/settings/:key  — update settings category (Admin only)
 *   3. GET   /api/settings/audit — view settings modification audit trail (Admin only)
 *
 * Supported Setting Categories:
 *   - shop_profile
 *   - business_preferences
 *   - operational_preferences
 *   - security_policy
 */

import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

const VALID_CATEGORIES = [
  'shop_profile',
  'business_preferences',
  'operational_preferences',
  'security_policy',
]

const DEFAULT_SETTINGS = {
  shop_profile: {
    shop_name: 'Bismillah Chicken Shop',
    tagline:   'Fresh & Quality Halal Poultry',
    phone:     '+91 98765 43210',
    email:     'contact@bismillahchicken.com',
    address:   'Main Market Road, Near Jamia Masjid, Bengaluru, Karnataka 560001',
    tax_id:    '29AAAAA0000A1Z5',
  },
  business_preferences: {
    timezone:        'Asia/Kolkata',
    currency_code:   'INR',
    currency_symbol: '₹',
    date_format:     'YYYY-MM-DD',
    weight_unit:     'kg',
  },
  operational_preferences: {
    low_stock_threshold_kg:        50.0,
    max_credit_limit_default:      25000.0,
    default_payment_mode:          'cash',
    print_receipt_on_sale:         true,
    allow_credit_sales_for_walkin: false,
  },
  security_policy: {
    session_timeout_hours:        8,
    max_login_attempts:           5,
    lockout_minutes:              15,
    password_min_length:          8,
    require_password_change_days: 90,
  },
}

// ══════════════════════════════════════════════════════════════════════════
// 1. GET /api/settings
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         s.key,
         s.value,
         s.description,
         s.updated_at,
         u.display_name AS updated_by_name
       FROM app_settings s
       LEFT JOIN users u ON u.id = s.updated_by
       ORDER BY s.key ASC`
    )

    const isAdmin = req.user.role === 'admin'

    const settingsMap = { ...DEFAULT_SETTINGS }
    for (const row of rows) {
      if (row.key === 'security_policy' && !isAdmin) {
        // Mask security policy internals for non-admins
        settingsMap[row.key] = {
          session_timeout_hours: row.value.session_timeout_hours,
          password_min_length:   row.value.password_min_length,
        }
      } else {
        settingsMap[row.key] = row.value
      }
    }

    return res.json({
      settings: settingsMap,
      raw: isAdmin ? rows : undefined,
    })
  } catch (err) {
    if (err.code === '42P01') {
      return res.json({ settings: DEFAULT_SETTINGS })
    }
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 2. GET /api/settings/audit (Admin only)
// ══════════════════════════════════════════════════════════════════════════
router.get('/audit', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const auditSql = `
      SELECT
        al.id,
        al.action_type,
        al.event_timestamp,
        al.change_metadata,
        u.display_name AS actor_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.entity_type = 'settings'
      ORDER BY al.event_timestamp DESC
      LIMIT 30
    `
    const { rows: audit } = await query(auditSql)
    return res.json({ audit })
  } catch (err) {
    if (err.code === '42P01') {
      return res.json({ audit: [] })
    }
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 3. PUT /api/settings/:key (Admin only)
// ══════════════════════════════════════════════════════════════════════════
router.put('/:key', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { key } = req.params
    const incomingValue = req.body

    if (!VALID_CATEGORIES.includes(key)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Invalid settings key. Must be one of: ${VALID_CATEGORIES.join(', ')}.`,
      })
    }

    if (!incomingValue || typeof incomingValue !== 'object' || Array.isArray(incomingValue)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Settings value must be a valid JSON object.',
      })
    }

    // Category-specific validation
    if (key === 'shop_profile') {
      const { shop_name, phone, email, address } = incomingValue
      if (!shop_name || typeof shop_name !== 'string' || shop_name.trim().length < 2) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Shop name must be at least 2 characters.',
        })
      }
      if (email && (typeof email !== 'string' || !email.includes('@'))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid email address in shop profile.',
        })
      }
    }

    if (key === 'business_preferences') {
      const { timezone, currency_code, currency_symbol } = incomingValue
      if (!timezone || typeof timezone !== 'string') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Timezone is required.',
        })
      }
      if (!currency_symbol || typeof currency_symbol !== 'string') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Currency symbol is required.',
        })
      }
    }

    if (key === 'operational_preferences') {
      const { low_stock_threshold_kg, max_credit_limit_default, default_payment_mode } = incomingValue
      if (low_stock_threshold_kg !== undefined && (isNaN(Number(low_stock_threshold_kg)) || Number(low_stock_threshold_kg) < 0)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Low stock threshold must be a non-negative number.',
        })
      }
      if (max_credit_limit_default !== undefined && (isNaN(Number(max_credit_limit_default)) || Number(max_credit_limit_default) < 0)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Default credit limit must be a non-negative number.',
        })
      }
      if (default_payment_mode && !['cash', 'upi', 'bank', 'other'].includes(default_payment_mode.toLowerCase())) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Default payment mode must be cash, upi, bank, or other.',
        })
      }
    }

    if (key === 'security_policy') {
      const { session_timeout_hours, max_login_attempts, lockout_minutes, password_min_length } = incomingValue
      if (session_timeout_hours !== undefined && (Number(session_timeout_hours) < 1 || Number(session_timeout_hours) > 72)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Session timeout must be between 1 and 72 hours.',
        })
      }
      if (max_login_attempts !== undefined && (Number(max_login_attempts) < 3 || Number(max_login_attempts) > 15)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Max login attempts must be between 3 and 15.',
        })
      }
      if (lockout_minutes !== undefined && (Number(lockout_minutes) < 5 || Number(lockout_minutes) > 120)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Lockout duration must be between 5 and 120 minutes.',
        })
      }
      if (password_min_length !== undefined && (Number(password_min_length) < 8 || Number(password_min_length) > 32)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Minimum password length must be between 8 and 32 characters.',
        })
      }
    }

    // Fetch previous value for audit logging
    const { rows: prevRows } = await query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [key]
    )
    const prevValue = prevRows[0]?.value ?? null

    // Upsert new settings value
    const upsertSql = `
      INSERT INTO app_settings (key, value, updated_at, updated_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (key) DO UPDATE
        SET value      = EXCLUDED.value,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
      RETURNING key, value, updated_at
    `
    const { rows: [saved] } = await query(upsertSql, [
      key,
      JSON.stringify(incomingValue),
      req.user.id,
    ])

    // Audit log
    await query(
      `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
       VALUES ($1, 'UPDATE', 'settings', NULL, $2)`,
      [
        req.user.id,
        JSON.stringify({
          key,
          previous_value: prevValue,
          new_value: incomingValue,
        }),
      ]
    )

    return res.json({
      message: `${key.replace(/_/g, ' ')} updated successfully.`,
      setting: saved,
    })
  } catch (err) {
    next(err)
  }
})

export default router
