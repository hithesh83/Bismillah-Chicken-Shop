/**
 * server/src/routes/dailyPrices.js
 *
 * Daily price endpoints.
 *
 * All roles — read:
 *   GET /api/daily-prices                  — price list (filter: product_id, date range)
 *   GET /api/daily-prices/today            — today's price for every active product (IST)
 *   GET /api/daily-prices/:product_id/history — full price history for one product
 *
 * Admin only — write:
 *   POST   /api/daily-prices               — set price for a product on a given date
 *   DELETE /api/daily-prices/:id           — remove a future/incorrect price entry
 *                                            (past prices: protected by business rule)
 *
 * ── Sales Pricing Architecture (canonical reference) ──────────────────────
 *
 *   This table is the single source of truth for what price was OFFERED per
 *   product per business day. The table is APPEND-ONLY by design:
 *
 *     • UNIQUE(product_id, effective_date) — one rate per product per day.
 *     • rate_per_kg > 0 — enforced by DB CHECK and API validation.
 *     • Past prices (effective_date < TODAY) may not be deleted through the
 *       API (business rule, not a DB constraint) to preserve audit integrity.
 *
 *   When Phase 06 implements Sales:
 *     1. Fetch the applicable price:
 *          SELECT rate_per_kg FROM daily_prices
 *          WHERE product_id = $1
 *            AND effective_date = $sale_date   -- business date of the sale (IST)
 *
 *     2. Store the fetched rate as a SNAPSHOT in sale_items.rate_per_kg.
 *        There is NO foreign key from sale_items → daily_prices intentionally.
 *        Once stored in a sale_item, the rate is immutable — future price
 *        changes in daily_prices have ZERO effect on historical sale records.
 *
 *     3. line_total = ROUND(quantity_kg × rate_per_kg, 2) — computed at insert.
 *
 *   This design satisfies: "historical sales are never altered by future price changes."
 */

import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

// ── IST date helper ────────────────────────────────────────────────────────
// Returns today's business date as a YYYY-MM-DD string in IST.
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ── Normalise a date value from the DB to YYYY-MM-DD ───────────────────────
// Supabase/pg returns DATE columns as JS Date objects (or ISO strings like
// '2026-10-15T18:30:00.000Z'). We always want a YYYY-MM-DD local string.
function toDateString(val) {
  if (!val) return null
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val
  // Parse the ISO string or Date object as UTC, then format as YYYY-MM-DD
  const d = new Date(val)
  return d.toISOString().slice(0, 10)
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/daily-prices/today
// Today's price for every active product (IST date).
// Staff and admin can both access this — needed to price a sale.
// ══════════════════════════════════════════════════════════════════════════
router.get('/today', requireAuth, async (_req, res, next) => {
  try {
    const today = todayIST()

    const { rows } = await query(
      `SELECT
         dp.id,
         dp.product_id,
         p.name        AS product_name,
         p.category,
         TO_CHAR(dp.effective_date, 'YYYY-MM-DD') AS effective_date,
         dp.rate_per_kg,
         dp.created_at,
         u.display_name AS created_by_name
       FROM daily_prices dp
       JOIN products p ON p.id = dp.product_id
       JOIN users   u ON u.id = dp.created_by
       WHERE dp.effective_date = $1
         AND p.is_active = TRUE
       ORDER BY p.category, p.name`,
      [today]
    )

    return res.json({
      date:   today,
      prices: rows,
      count:  rows.length,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/daily-prices
// Price list with optional filters: ?product_id=uuid, ?from=YYYY-MM-DD, ?to=YYYY-MM-DD
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { product_id, from, to } = req.query

    const conditions = []
    const params = []

    if (product_id) {
      params.push(product_id)
      conditions.push(`dp.product_id = $${params.length}`)
    }

    if (from) {
      params.push(from)
      conditions.push(`dp.effective_date >= $${params.length}`)
    }

    if (to) {
      params.push(to)
      conditions.push(`dp.effective_date <= $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const { rows } = await query(
      `SELECT
         dp.id,
         dp.product_id,
         p.name        AS product_name,
         p.category,
         TO_CHAR(dp.effective_date, 'YYYY-MM-DD') AS effective_date,
         dp.rate_per_kg,
         dp.created_at,
         u.display_name AS created_by_name
       FROM daily_prices dp
       JOIN products p ON p.id = dp.product_id
       JOIN users   u ON u.id = dp.created_by
       ${where}
       ORDER BY dp.effective_date DESC, p.category, p.name
       LIMIT 200`,
      params
    )

    return res.json({ prices: rows, count: rows.length })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/daily-prices/:product_id/history
// Full price history for one product (newest first).
// ══════════════════════════════════════════════════════════════════════════
router.get('/:product_id/history', requireAuth, async (req, res, next) => {
  try {
    const { product_id } = req.params

    // Confirm product exists
    const { rows: [product] } = await query(
      `SELECT id, name, category FROM products WHERE id = $1`, [product_id]
    )
    if (!product) {
      return res.status(404).json({ error: 'Not Found', message: 'Product not found.' })
    }

    const { rows } = await query(
      `SELECT
         dp.id,
         TO_CHAR(dp.effective_date, 'YYYY-MM-DD') AS effective_date,
         dp.rate_per_kg,
         dp.created_at,
         u.display_name AS created_by_name
       FROM daily_prices dp
       JOIN users u ON u.id = dp.created_by
       WHERE dp.product_id = $1
       ORDER BY dp.effective_date DESC`,
      [product_id]
    )

    return res.json({ product, history: rows, count: rows.length })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/daily-prices  — Admin only
// Set the price for a product on a specific date.
// ══════════════════════════════════════════════════════════════════════════
router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { product_id, effective_date, rate_per_kg } = req.body ?? {}

    // ── Validation ────────────────────────────────────────
    const errors = {}

    if (!product_id || typeof product_id !== 'string') {
      errors.product_id = 'product_id is required.'
    }

    // effective_date: must be a valid YYYY-MM-DD string
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!effective_date || !dateRegex.test(effective_date)) {
      errors.effective_date = 'effective_date must be a valid date (YYYY-MM-DD).'
    } else {
      const d = new Date(effective_date)
      if (isNaN(d.getTime())) {
        errors.effective_date = 'effective_date is not a valid calendar date.'
      }
    }

    // rate_per_kg: must be a positive number
    const rate = Number(rate_per_kg)
    if (!rate_per_kg || isNaN(rate) || rate <= 0) {
      errors.rate_per_kg = 'rate_per_kg must be a positive number greater than zero.'
    } else if (rate > 99999.99) {
      errors.rate_per_kg = 'rate_per_kg exceeds the maximum allowed value.'
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // ── Confirm product exists and is active ──────────────
    const { rows: [product] } = await query(
      `SELECT id, name FROM products WHERE id = $1 AND is_active = TRUE`,
      [product_id]
    )
    if (!product) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Active product not found.',
      })
    }

    // ── Insert (UNIQUE constraint handles duplicate) ───────
    try {
      const { rows: [price] } = await query(
        `INSERT INTO daily_prices (product_id, effective_date, rate_per_kg, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, product_id, TO_CHAR(effective_date,'YYYY-MM-DD') AS effective_date, rate_per_kg, created_at`,
        [product_id, effective_date, rate.toFixed(2), req.user.id]
      )

      return res.status(201).json({
        price: { ...price, product_name: product.name },
        message: `Price set for ${product.name} on ${effective_date}.`,
      })
    } catch (dbErr) {
      // PostgreSQL unique_violation = 23505
      if (dbErr.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: `A price for "${product.name}" on ${effective_date} already exists. To change it, delete the existing entry first.`,
        })
      }
      throw dbErr
    }
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// DELETE /api/daily-prices/:id  — Admin only
// Remove a price entry.
// Business rule: past prices (before today in IST) may NOT be deleted.
// Future or today's prices may be deleted if no sale referenced them.
// ══════════════════════════════════════════════════════════════════════════
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params

    const { rows: [price] } = await query(
      `SELECT id, product_id, effective_date FROM daily_prices WHERE id = $1`, [id]
    )

    if (!price) {
      return res.status(404).json({ error: 'Not Found', message: 'Price entry not found.' })
    }

    // ── Business rule: protect past prices ────────────────
    const today = todayIST()
    const entryDate = toDateString(price.effective_date)
    if (entryDate < today) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Past price entries cannot be deleted. Historical prices are preserved for audit integrity.',
      })
    }

    await query(`DELETE FROM daily_prices WHERE id = $1`, [id])

    return res.json({ message: 'Price entry deleted.' })
  } catch (err) {
    next(err)
  }
})

export default router
