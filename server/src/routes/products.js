/**
 * server/src/routes/products.js
 *
 * Product catalogue endpoints.
 *
 * All roles — read:
 *   GET  /api/products          — list products (filterable by status, category)
 *   GET  /api/products/:id      — single product
 *
 * Admin only — write:
 *   POST   /api/products             — create a new product
 *   PATCH  /api/products/:id         — update name / notes / category
 *   PATCH  /api/products/:id/status  — activate or deactivate
 *
 * Design notes:
 *   - seed_key is immutable after creation (stable reference for seeded products).
 *   - Products are never hard-deleted; set is_active = FALSE instead.
 *   - product names must be non-empty after trimming.
 *   - category must be 'whole' | 'cut' | 'offal' (enforced at DB and API level).
 *
 * Sales pricing architecture note (read before implementing Sales in Phase 6):
 *   When a sale line item is created, the caller must:
 *     1. Look up the applicable daily price for the product on the sale's sale_date:
 *          SELECT rate_per_kg FROM daily_prices
 *          WHERE product_id = $1 AND effective_date = $2
 *     2. Copy that rate_per_kg into sale_items.rate_per_kg at INSERT time.
 *   This means sale_items.rate_per_kg is a SNAPSHOT — it is never updated again.
 *   Future changes to daily_prices do NOT affect historical sale_items.
 *   There is no foreign key from sale_items to daily_prices intentionally.
 */

import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

const VALID_CATEGORIES = ['whole', 'cut', 'offal']

// ══════════════════════════════════════════════════════════════════════════
// GET /api/products
// List products. Optional query params: ?status=active|inactive|all, ?category=whole|cut|offal
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status = 'active', category } = req.query

    const conditions = []
    const params = []

    // Status filter
    if (status === 'active') {
      conditions.push(`p.is_active = TRUE`)
    } else if (status === 'inactive') {
      conditions.push(`p.is_active = FALSE`)
    }
    // 'all' → no filter

    // Category filter
    if (category && VALID_CATEGORIES.includes(category)) {
      params.push(category)
      conditions.push(`p.category = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const { rows } = await query(
      `SELECT
         p.id,
         p.seed_key,
         p.name,
         p.category,
         p.is_active,
         p.notes,
         p.created_at,
         p.updated_at,
         -- Include today's price for convenience (IST date)
         dp.rate_per_kg  AS today_rate,
         dp.effective_date AS today_price_date
       FROM products p
       LEFT JOIN daily_prices dp
         ON dp.product_id = p.id
         AND dp.effective_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE
       ${where}
       ORDER BY p.category, p.name`,
      params
    )

    return res.json({ products: rows, count: rows.length })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/products/:id
// Single product with its full price history.
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params

    const { rows: [product] } = await query(
      `SELECT id, seed_key, name, category, is_active, notes, created_at, updated_at
       FROM products WHERE id = $1`,
      [id]
    )

    if (!product) {
      return res.status(404).json({ error: 'Not Found', message: 'Product not found.' })
    }

    // Last 30 price entries for this product
    const { rows: prices } = await query(
      `SELECT dp.id, dp.effective_date, dp.rate_per_kg,
              dp.created_at, u.display_name AS created_by_name
       FROM daily_prices dp
       JOIN users u ON u.id = dp.created_by
       WHERE dp.product_id = $1
       ORDER BY dp.effective_date DESC
       LIMIT 30`,
      [id]
    )

    return res.json({ product, price_history: prices })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/products  — Admin only
// Create a new product.
// ══════════════════════════════════════════════════════════════════════════
router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, category = 'whole', notes } = req.body ?? {}

    // ── Validation ────────────────────────────────────────
    const errors = {}

    const trimmedName = (name ?? '').trim()
    if (!trimmedName) {
      errors.name = 'Product name is required.'
    } else if (trimmedName.length > 100) {
      errors.name = 'Product name must be 100 characters or fewer.'
    }

    if (!VALID_CATEGORIES.includes(category)) {
      errors.category = `Category must be one of: ${VALID_CATEGORIES.join(', ')}.`
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // ── Check duplicate name ──────────────────────────────
    const { rows: existing } = await query(
      `SELECT id FROM products WHERE LOWER(name) = LOWER($1) AND is_active = TRUE`,
      [trimmedName]
    )
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Conflict',
        message: `An active product named "${trimmedName}" already exists.`,
      })
    }

    // ── Insert ────────────────────────────────────────────
    // seed_key for user-created products: slugified name + timestamp (not a fixed seed)
    const seedKey = `custom_${Date.now()}`

    const { rows: [product] } = await query(
      `INSERT INTO products (seed_key, name, category, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, seed_key, name, category, is_active, notes, created_at`,
      [seedKey, trimmedName, category, notes?.trim() ?? null]
    )

    return res.status(201).json({ product })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/products/:id  — Admin only
// Update name, category, or notes.
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    const { name, category, notes } = req.body ?? {}

    // Must exist
    const { rows: [existing] } = await query(
      `SELECT id, is_active FROM products WHERE id = $1`, [id]
    )
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Product not found.' })
    }

    // ── Validation ────────────────────────────────────────
    const errors = {}
    const updates = {}

    if (name !== undefined) {
      const trimmed = name.trim()
      if (!trimmed) errors.name = 'Product name cannot be empty.'
      else if (trimmed.length > 100) errors.name = 'Product name must be 100 characters or fewer.'
      else updates.name = trimmed
    }

    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category)) {
        errors.category = `Category must be one of: ${VALID_CATEGORIES.join(', ')}.`
      } else {
        updates.category = category
      }
    }

    if (notes !== undefined) {
      updates.notes = notes?.trim() ?? null
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Bad Request', message: 'No fields to update.' })
    }

    // ── Build UPDATE ──────────────────────────────────────
    const setClauses = Object.keys(updates).map((col, i) => `${col} = $${i + 2}`)
    const values     = [id, ...Object.values(updates)]
    setClauses.push(`updated_at = NOW()`)

    const { rows: [product] } = await query(
      `UPDATE products SET ${setClauses.join(', ')} WHERE id = $1
       RETURNING id, seed_key, name, category, is_active, notes, updated_at`,
      values
    )

    return res.json({ product })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/products/:id/status  — Admin only
// Activate or deactivate a product.
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id/status', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    const { is_active } = req.body ?? {}

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'is_active must be true or false.',
      })
    }

    const { rows: [product] } = await query(
      `UPDATE products SET is_active = $2, updated_at = NOW() WHERE id = $1
       RETURNING id, name, is_active, updated_at`,
      [id, is_active]
    )

    if (!product) {
      return res.status(404).json({ error: 'Not Found', message: 'Product not found.' })
    }

    return res.json({
      product,
      message: is_active ? 'Product activated.' : 'Product deactivated.',
    })
  } catch (err) {
    next(err)
  }
})

export default router
