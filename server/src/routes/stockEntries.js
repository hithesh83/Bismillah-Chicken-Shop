/**
 * server/src/routes/stockEntries.js
 *
 * Manual Remaining Stock Observation endpoints — Phase 07.
 *
 * Business rules enforced here (server is always authoritative):
 *   • Strict Manual Observation: Quantities are physical readings observed
 *     and recorded at a specific timestamp. They are NEVER calculated from
 *     sales or chicken loads.
 *   • No Silent Overwrites: Every reading is an immutable point-in-time observation.
 *     Multiple readings per product per day are saved as distinct historical records.
 *   • Corrections & Audit Trail: Authorized corrections create a new row
 *     referencing the original entry (is_correction=TRUE, corrects_entry_id=...).
 *     Original observations are never overwritten or deleted.
 *   • Server-Side Validation: Reject negative quantities, invalid timestamps,
 *     and nonexistent or inactive products.
 *   • Role-Based Permissions:
 *       - Staff + Admin can record manual stock observations (POST /api/stock-entries).
 *       - Admin only can perform authorized corrections (POST /api/stock-entries/:id/correct).
 *
 * Endpoints:
 *   GET  /api/stock-entries/latest       — latest readings for all configured products (all roles)
 *   GET  /api/stock-entries              — history with filters (date range, product, category, user) (all roles)
 *   GET  /api/stock-entries/:id          — single observation detail, corrections, & audit history (all roles)
 *   POST /api/stock-entries              — record a new physical stock observation (Staff + Admin)
 *   POST /api/stock-entries/:id/correct  — submit an authorized correction (Admin only)
 */

import { Router }                  from 'express'
import { query, withTransaction }  from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── Validation Helper ────────────────────────────────────────────────────────
function validateObservationPayload({ product_id, quantity_kg, observed_at }) {
  const errors = {}

  // product_id validation
  if (!product_id || typeof product_id !== 'string' || !UUID_REGEX.test(product_id.trim())) {
    errors.product_id = 'product_id is required and must be a valid UUID.'
  }

  // quantity_kg validation: required, number, >= 0
  if (quantity_kg === undefined || quantity_kg === null || quantity_kg === '') {
    errors.quantity_kg = 'quantity_kg is required.'
  } else {
    const qty = Number(quantity_kg)
    if (isNaN(qty)) {
      errors.quantity_kg = 'quantity_kg must be a valid number.'
    } else if (qty < 0) {
      errors.quantity_kg = 'quantity_kg must be zero or a positive number.'
    }
  }

  // observed_at validation (optional, defaults to NOW() if omitted)
  if (observed_at !== undefined && observed_at !== null && observed_at !== '') {
    const dateObj = new Date(observed_at)
    if (isNaN(dateObj.getTime())) {
      errors.observed_at = 'observed_at must be a valid ISO date/time timestamp.'
    }
  }

  return errors
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/stock-entries/latest
// Returns the latest manual observation for all active configured products,
// along with summary metrics.
// ══════════════════════════════════════════════════════════════════════════
router.get('/latest', requireAuth, async (_req, res, next) => {
  try {
    // Distinct on product_id ordering by observed_at DESC, created_at DESC
    // This correctly picks up the most recent observation (or correction) for each product
    const sql = `
      SELECT DISTINCT ON (p.id)
        p.id AS product_id,
        p.name AS product_name,
        p.category AS product_category,
        p.seed_key,
        p.is_active,
        se.id AS observation_id,
        se.observed_at,
        se.quantity_kg,
        se.notes,
        se.is_correction,
        se.corrects_entry_id,
        se.correction_reason,
        se.created_at,
        u.display_name AS created_by_name,
        u.role AS created_by_role
      FROM products p
      LEFT JOIN stock_entries se ON se.product_id = p.id
      LEFT JOIN users u ON u.id = se.created_by
      WHERE p.is_active = TRUE
      ORDER BY p.id, se.observed_at DESC, se.created_at DESC
    `

    const { rows } = await query(sql)

    // Calculate high-level summary cards
    const productsWithStock = rows.filter(r => r.observation_id != null)
    const totalObservedKg = productsWithStock.reduce((acc, r) => acc + Number(r.quantity_kg || 0), 0)

    // Sort output products by category and name for consistent presentation
    const categoryOrder = { whole: 1, cut: 2, offal: 3 }
    rows.sort((a, b) => {
      const catDiff = (categoryOrder[a.product_category] || 99) - (categoryOrder[b.product_category] || 99)
      if (catDiff !== 0) return catDiff
      return a.product_name.localeCompare(b.product_name)
    })

    return res.json({
      latest: rows,
      summary: {
        total_products: rows.length,
        observed_products: productsWithStock.length,
        unobserved_products: rows.length - productsWithStock.length,
        total_observed_kg: totalObservedKg.toFixed(3),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/stock-entries
// Filterable history of all manual stock observations.
// Query filters:
//   ?product_id=UUID
//   ?category=whole|cut|offal
//   ?from=YYYY-MM-DD
//   ?to=YYYY-MM-DD
//   ?user_id=UUID
//   ?page=1 & ?limit=50
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const {
      product_id,
      category,
      from,
      to,
      user_id,
      page = 1,
      limit = 50,
    } = req.query

    const pageNum  = Math.max(1, parseInt(page, 10)  || 1)
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50))
    const offset   = (pageNum - 1) * limitNum

    const conditions = []
    const params     = []

    if (product_id && UUID_REGEX.test(product_id.trim())) {
      params.push(product_id.trim())
      conditions.push(`se.product_id = $${params.length}`)
    }

    if (category && ['whole', 'cut', 'offal'].includes(category.trim())) {
      params.push(category.trim())
      conditions.push(`p.category = $${params.length}`)
    }

    if (from) {
      params.push(from)
      conditions.push(`se.observed_at >= $${params.length}::date`)
    }

    if (to) {
      params.push(to)
      conditions.push(`se.observed_at < ($${params.length}::date + INTERVAL '1 day')`)
    }

    if (user_id && UUID_REGEX.test(user_id.trim())) {
      params.push(user_id.trim())
      conditions.push(`se.created_by = $${params.length}`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Count matching rows
    const countSql = `
      SELECT COUNT(*) AS total
      FROM stock_entries se
      JOIN products p ON p.id = se.product_id
      ${whereClause}
    `
    const { rows: [{ total }] } = await query(countSql, params)

    // Fetch page of entries with product and user details
    const dataSql = `
      SELECT
        se.id,
        se.observed_at,
        se.quantity_kg,
        se.notes,
        se.is_correction,
        se.corrects_entry_id,
        se.correction_reason,
        se.created_at,
        p.id AS product_id,
        p.name AS product_name,
        p.category AS product_category,
        p.seed_key,
        u.display_name AS created_by_name,
        u.role AS created_by_role,
        -- Check if this entry has had any corrections recorded against it
        EXISTS (
          SELECT 1 FROM stock_entries corr
          WHERE corr.corrects_entry_id = se.id
        ) AS has_been_corrected
      FROM stock_entries se
      JOIN products p ON p.id = se.product_id
      JOIN users u ON u.id = se.created_by
      ${whereClause}
      ORDER BY se.observed_at DESC, se.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `
    const { rows: entries } = await query(dataSql, [...params, limitNum, offset])

    return res.json({
      entries,
      total: parseInt(total, 10),
      page:  pageNum,
      limit: limitNum,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/stock-entries/:id
// Single observation detail, any corrections, and audit logs.
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const entrySql = `
      SELECT
        se.id,
        se.observed_at,
        se.quantity_kg,
        se.notes,
        se.is_correction,
        se.corrects_entry_id,
        se.correction_reason,
        se.created_at,
        p.id AS product_id,
        p.name AS product_name,
        p.category AS product_category,
        p.seed_key,
        u.display_name AS created_by_name,
        u.role AS created_by_role
      FROM stock_entries se
      JOIN products p ON p.id = se.product_id
      JOIN users u ON u.id = se.created_by
      WHERE se.id = $1
    `
    const { rows: [entry] } = await query(entrySql, [id])
    if (!entry) {
      return res.status(404).json({ error: 'Not Found', message: 'Stock observation not found.' })
    }

    // Fetch corrections referencing this entry
    const correctionsSql = `
      SELECT
        c.id,
        c.observed_at,
        c.quantity_kg,
        c.notes,
        c.correction_reason,
        c.created_at,
        u.display_name AS created_by_name,
        u.role AS created_by_role
      FROM stock_entries c
      JOIN users u ON u.id = c.created_by
      WHERE c.corrects_entry_id = $1
      ORDER BY c.created_at ASC
    `
    const { rows: corrections } = await query(correctionsSql, [id])

    // Fetch audit trail for this stock observation
    const auditSql = `
      SELECT
        al.id,
        al.action_type,
        al.event_timestamp,
        al.change_metadata,
        u.display_name AS actor_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.entity_type = 'stock_entry'
        AND (al.entity_id = $1::uuid OR al.change_metadata->>'original_entry_id' = $1::text)
      ORDER BY al.event_timestamp DESC
    `
    const { rows: audit } = await query(auditSql, [id])

    return res.json({ entry, corrections, audit })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/stock-entries
// Record a new manual physical stock observation.
// Allowed: Staff and Admin (requireAuth).
// ══════════════════════════════════════════════════════════════════════════
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { product_id, quantity_kg, observed_at, notes } = req.body ?? {}

    // Field-level validation
    const errors = validateObservationPayload({ product_id, quantity_kg, observed_at })
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // Verify product exists and is active
    const { rows: [product] } = await query(
      'SELECT id, name, category FROM products WHERE id = $1 AND is_active = TRUE',
      [product_id.trim()]
    )
    if (!product) {
      return res.status(400).json({
        error: 'Validation Error',
        errors: { product_id: 'Selected product does not exist or is inactive.' },
      })
    }

    const qty = Number(quantity_kg)
    const observationTimestamp = observed_at ? new Date(observed_at).toISOString() : new Date().toISOString()

    // Insert observation and audit log within a single transaction
    const newEntry = await withTransaction(async (client) => {
      const insertSql = `
        INSERT INTO stock_entries (
          product_id,
          quantity_kg,
          observed_at,
          notes,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          id,
          observed_at,
          quantity_kg,
          notes,
          is_correction,
          created_at
      `
      const { rows: [inserted] } = await client.query(insertSql, [
        product.id,
        qty.toFixed(3),
        observationTimestamp,
        notes?.trim() || null,
        req.user.id,
      ])

      // Write audit log entry
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'CREATE', 'stock_entry', $2, $3)`,
        [
          req.user.id,
          inserted.id,
          JSON.stringify({
            product_id: product.id,
            product_name: product.name,
            product_category: product.category,
            quantity_kg: qty,
            observed_at: inserted.observed_at,
            notes: notes?.trim() || null,
          }),
        ]
      )

      return {
        ...inserted,
        product_id: product.id,
        product_name: product.name,
        product_category: product.category,
        created_by_name: req.user.display_name,
      }
    })

    return res.status(201).json({
      entry: newEntry,
      message: `Stock observation for ${product.name} (${qty.toFixed(3)} kg) recorded successfully.`,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/stock-entries/:id/correct
// Submit an authorized correction for an existing observation.
// Allowed: Admin only (requireRole('admin')).
// Never overwrites original row; inserts a new row with is_correction = TRUE.
// ══════════════════════════════════════════════════════════════════════════
router.post('/:id/correct', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const { quantity_kg, correction_reason, observed_at, notes } = req.body ?? {}

    // Validation
    const errors = {}

    // quantity_kg validation
    if (quantity_kg === undefined || quantity_kg === null || quantity_kg === '') {
      errors.quantity_kg = 'quantity_kg is required.'
    } else {
      const qty = Number(quantity_kg)
      if (isNaN(qty)) {
        errors.quantity_kg = 'quantity_kg must be a valid number.'
      } else if (qty < 0) {
        errors.quantity_kg = 'quantity_kg must be zero or a positive number.'
      }
    }

    // correction_reason validation
    if (!correction_reason || typeof correction_reason !== 'string' || correction_reason.trim().length < 3) {
      errors.correction_reason = 'correction_reason is required (minimum 3 characters).'
    }

    // observed_at validation if provided
    if (observed_at !== undefined && observed_at !== null && observed_at !== '') {
      const dateObj = new Date(observed_at)
      if (isNaN(dateObj.getTime())) {
        errors.observed_at = 'observed_at must be a valid ISO date/time timestamp.'
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // Verify original observation exists
    const { rows: [original] } = await query(
      `SELECT se.id, se.product_id, se.quantity_kg, se.observed_at, se.notes, p.name AS product_name
       FROM stock_entries se
       JOIN products p ON p.id = se.product_id
       WHERE se.id = $1`,
      [id]
    )

    if (!original) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Original stock observation to correct was not found.',
      })
    }

    const newQty = Number(quantity_kg)
    const effectiveObservedAt = observed_at
      ? new Date(observed_at).toISOString()
      : original.observed_at

    // Execute correction creation and audit log in a single transaction
    const correctionEntry = await withTransaction(async (client) => {
      const insertSql = `
        INSERT INTO stock_entries (
          product_id,
          quantity_kg,
          observed_at,
          notes,
          is_correction,
          corrects_entry_id,
          correction_reason,
          created_by
        )
        VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7)
        RETURNING
          id,
          observed_at,
          quantity_kg,
          notes,
          is_correction,
          corrects_entry_id,
          correction_reason,
          created_at
      `
      const { rows: [inserted] } = await client.query(insertSql, [
        original.product_id,
        newQty.toFixed(3),
        effectiveObservedAt,
        notes !== undefined ? (notes?.trim() || null) : original.notes,
        original.id,
        correction_reason.trim(),
        req.user.id,
      ])

      // Write audit log entry with action 'CORRECT'
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'CORRECT', 'stock_entry', $2, $3)`,
        [
          req.user.id,
          inserted.id,
          JSON.stringify({
            original_entry_id: original.id,
            product_id: original.product_id,
            product_name: original.product_name,
            old_quantity_kg: Number(original.quantity_kg),
            new_quantity_kg: newQty,
            correction_reason: correction_reason.trim(),
            observed_at: inserted.observed_at,
          }),
        ]
      )

      return {
        ...inserted,
        product_id: original.product_id,
        product_name: original.product_name,
        created_by_name: req.user.display_name,
      }
    })

    return res.status(201).json({
      correction: correctionEntry,
      message: `Stock observation corrected successfully for ${original.product_name}.`,
    })
  } catch (err) {
    next(err)
  }
})

export default router
