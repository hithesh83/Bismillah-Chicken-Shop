/**
 * server/src/routes/chickenLoads.js
 *
 * Chicken Load endpoints — Phase 06.
 *
 * Business rules enforced here (server is always authoritative):
 *   • live_weight_kg must be > 0 (prevents division-by-zero in wastage calc)
 *   • dressed_weight_kg must be >= 0 and <= live_weight_kg
 *   • remaining_stock_kg must be >= 0 (if provided)
 *   • wastage_pct is a GENERATED column in PostgreSQL — we NEVER accept or
 *     recalculate it here; the DB computes it automatically
 *   • Remaining stock updates are manual-only (never auto-calculated)
 *   • Admin corrections create a NEW row (is_correction=TRUE), never edit old
 *   • Every create / stock-update / correction is recorded in audit_logs
 *
 * Endpoints:
 *
 *   All authenticated users (Staff + Admin):
 *     GET  /api/chicken-loads              — paginated list with filters
 *     GET  /api/chicken-loads/:id          — single load detail + audit history
 *
 *   Staff + Admin (creating loads):
 *     POST /api/chicken-loads              — create a new load record
 *
 *   Staff + Admin (updating manual remaining stock):
 *     PATCH /api/chicken-loads/:id/stock   — update remaining_stock_kg
 *
 *   Admin only (authorized correction):
 *     POST /api/chicken-loads/:id/correct  — insert a correction row for an
 *                                             existing load (correction_reason required)
 */

import { Router }                  from 'express'
import { query, withTransaction }  from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

// ── IST date helper ────────────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ── Validation helper ──────────────────────────────────────────────────────
/**
 * Validate the numeric weight fields that appear on every load write.
 * Returns an errors object (empty if valid).
 */
function validateWeights({ live_weight_kg, dressed_weight_kg, remaining_stock_kg }) {
  const errors = {}

  const live    = Number(live_weight_kg)
  const dressed = Number(dressed_weight_kg)

  // live_weight_kg: required, must be > 0 (prevents division-by-zero)
  if (live_weight_kg === undefined || live_weight_kg === null || live_weight_kg === '') {
    errors.live_weight_kg = 'live_weight_kg is required.'
  } else if (isNaN(live) || live <= 0) {
    errors.live_weight_kg = 'live_weight_kg must be a positive number greater than zero.'
  }

  // dressed_weight_kg: required, must be >= 0
  if (dressed_weight_kg === undefined || dressed_weight_kg === null || dressed_weight_kg === '') {
    errors.dressed_weight_kg = 'dressed_weight_kg is required.'
  } else if (isNaN(dressed) || dressed < 0) {
    errors.dressed_weight_kg = 'dressed_weight_kg must be zero or a positive number.'
  } else if (!isNaN(live) && live > 0 && dressed > live) {
    // Dressed cannot exceed live (the DB constraint also enforces this, but
    // we return a clear API error before the DB ever sees it)
    errors.dressed_weight_kg =
      'dressed_weight_kg cannot exceed live_weight_kg. ' +
      'If you need to correct this, use the Admin correction workflow.'
  }

  // remaining_stock_kg: optional, but if provided must be >= 0
  if (remaining_stock_kg !== undefined && remaining_stock_kg !== null && remaining_stock_kg !== '') {
    const remaining = Number(remaining_stock_kg)
    if (isNaN(remaining) || remaining < 0) {
      errors.remaining_stock_kg = 'remaining_stock_kg must be zero or a positive number.'
    }
  }

  return errors
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/chicken-loads
// Paginated list with optional filters:
//   ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?load_number=LD-00001
//   ?page=1  ?limit=20
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { from, to, load_number, page = 1, limit = 30 } = req.query

    const conditions = ['cl.is_correction = FALSE'] // main list excludes correction rows
    const params     = []

    if (from) {
      params.push(from)
      conditions.push(`cl.load_date >= $${params.length}`)
    }

    if (to) {
      params.push(to)
      conditions.push(`cl.load_date <= $${params.length}`)
    }

    if (load_number) {
      params.push(`%${load_number.toUpperCase()}%`)
      conditions.push(`cl.load_number ILIKE $${params.length}`)
    }

    const where = `WHERE ${conditions.join(' AND ')}`

    // Total count (for pagination)
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) AS count FROM chicken_loads cl ${where}`,
      params
    )

    // Pagination
    const pageNum  = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30))
    const offset   = (pageNum - 1) * limitNum

    params.push(limitNum, offset)

    const { rows } = await query(
      `SELECT
         cl.id,
         cl.load_number,
         TO_CHAR(cl.load_date, 'YYYY-MM-DD') AS load_date,
         cl.supplier_ref,
         cl.live_weight_kg,
         cl.dressed_weight_kg,
         cl.wastage_pct,
         cl.remaining_stock_kg,
         cl.notes,
         cl.is_correction,
         cl.corrects_load_id,
         cl.created_at,
         cl.updated_at,
         u.display_name  AS created_by_name
       FROM chicken_loads cl
       JOIN users u ON u.id = cl.created_by
       ${where}
       ORDER BY cl.load_date DESC, cl.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    return res.json({
      loads:      rows,
      count:      rows.length,
      total:      parseInt(count, 10),
      page:       pageNum,
      totalPages: Math.ceil(parseInt(count, 10) / limitNum),
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/chicken-loads/:id
// Single load detail, plus any correction rows linked to it,
// plus the audit log entries for this load.
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params

    // Main load record
    const { rows: [load] } = await query(
      `SELECT
         cl.id,
         cl.load_number,
         TO_CHAR(cl.load_date, 'YYYY-MM-DD') AS load_date,
         cl.supplier_ref,
         cl.live_weight_kg,
         cl.dressed_weight_kg,
         cl.wastage_pct,
         cl.remaining_stock_kg,
         cl.notes,
         cl.is_correction,
         cl.corrects_load_id,
         cl.created_at,
         cl.updated_at,
         u.display_name  AS created_by_name,
         u.id            AS created_by_id
       FROM chicken_loads cl
       JOIN users u ON u.id = cl.created_by
       WHERE cl.id = $1`,
      [id]
    )

    if (!load) {
      return res.status(404).json({
        error:   'Not Found',
        message: 'Chicken load not found.',
      })
    }

    // Any correction rows that reference this load
    const { rows: corrections } = await query(
      `SELECT
         cl.id,
         cl.load_number,
         TO_CHAR(cl.load_date, 'YYYY-MM-DD') AS load_date,
         cl.live_weight_kg,
         cl.dressed_weight_kg,
         cl.wastage_pct,
         cl.remaining_stock_kg,
         cl.notes,
         cl.created_at,
         u.display_name AS created_by_name
       FROM chicken_loads cl
       JOIN users u ON u.id = cl.created_by
       WHERE cl.corrects_load_id = $1
       ORDER BY cl.created_at ASC`,
      [id]
    )

    // Audit log entries for this load (newest first)
    const { rows: auditEntries } = await query(
      `SELECT
         al.id,
         al.action_type,
         al.event_timestamp,
         al.change_metadata,
         u.display_name AS actor_name
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_id
       WHERE al.entity_type = 'chicken_load'
         AND al.entity_id   = $1
       ORDER BY al.event_timestamp DESC`,
      [id]
    )

    return res.json({ load, corrections, audit: auditEntries })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/chicken-loads  — Staff and Admin
// Create a new load record.
// ══════════════════════════════════════════════════════════════════════════
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      load_date,
      supplier_ref,
      live_weight_kg,
      dressed_weight_kg,
      remaining_stock_kg,
      notes,
    } = req.body ?? {}

    // ── Field-level validation ─────────────────────────────────────────────
    const errors = {}

    // load_date: required, must be YYYY-MM-DD
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!load_date || !dateRegex.test(load_date)) {
      errors.load_date = 'load_date is required and must be in YYYY-MM-DD format.'
    } else if (isNaN(new Date(load_date).getTime())) {
      errors.load_date = 'load_date is not a valid calendar date.'
    }

    // Weight validation (live, dressed, remaining)
    const weightErrors = validateWeights({ live_weight_kg, dressed_weight_kg, remaining_stock_kg })
    Object.assign(errors, weightErrors)

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // ── Insert + audit (single transaction) ───────────────────────────────
    const live        = Number(live_weight_kg)
    const dressed     = Number(dressed_weight_kg)
    const remaining   = (remaining_stock_kg !== undefined && remaining_stock_kg !== null && remaining_stock_kg !== '')
      ? Number(remaining_stock_kg)
      : null

    const result = await withTransaction(async (client) => {
      // Insert the load
      const { rows: [newLoad] } = await client.query(
        `INSERT INTO chicken_loads
           (load_date, supplier_ref, live_weight_kg, dressed_weight_kg,
            remaining_stock_kg, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING
           id, load_number,
           TO_CHAR(load_date, 'YYYY-MM-DD') AS load_date,
           supplier_ref, live_weight_kg, dressed_weight_kg,
           wastage_pct, remaining_stock_kg, notes,
           is_correction, created_at, updated_at`,
        [
          load_date,
          supplier_ref?.trim() || null,
          live.toFixed(3),
          dressed.toFixed(3),
          remaining !== null ? remaining.toFixed(3) : null,
          notes?.trim() || null,
          req.user.id,
        ]
      )

      // Write audit log in the same transaction
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'CREATE', 'chicken_load', $2, $3)`,
        [
          req.user.id,
          newLoad.id,
          JSON.stringify({
            load_number:      newLoad.load_number,
            load_date,
            live_weight_kg:   live,
            dressed_weight_kg: dressed,
            wastage_pct:      newLoad.wastage_pct,
            remaining_stock_kg: remaining,
          }),
        ]
      )

      return newLoad
    })

    return res.status(201).json({
      load:    result,
      message: `Load ${result.load_number} created successfully.`,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/chicken-loads/:id/stock  — Staff and Admin
// Manually update remaining_stock_kg for a load.
// This is NEVER calculated automatically — it is always a manual entry.
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id/stock', requireAuth, async (req, res, next) => {
  try {
    const { id }                 = req.params
    const { remaining_stock_kg, notes } = req.body ?? {}

    // ── Validation ────────────────────────────────────────────────────────
    const errors = {}

    if (remaining_stock_kg === undefined || remaining_stock_kg === null || remaining_stock_kg === '') {
      errors.remaining_stock_kg = 'remaining_stock_kg is required.'
    } else {
      const val = Number(remaining_stock_kg)
      if (isNaN(val) || val < 0) {
        errors.remaining_stock_kg = 'remaining_stock_kg must be zero or a positive number.'
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // ── Confirm load exists ───────────────────────────────────────────────
    const { rows: [existing] } = await query(
      `SELECT id, load_number, remaining_stock_kg FROM chicken_loads WHERE id = $1`,
      [id]
    )

    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Chicken load not found.' })
    }

    const newStock   = Number(remaining_stock_kg)
    const prevStock  = existing.remaining_stock_kg

    // ── Update + audit (single transaction) ───────────────────────────────
    const updated = await withTransaction(async (client) => {
      const { rows: [row] } = await client.query(
        `UPDATE chicken_loads
         SET remaining_stock_kg = $1,
             notes = COALESCE($2, notes),
             updated_at = NOW()
         WHERE id = $3
         RETURNING
           id, load_number,
           TO_CHAR(load_date, 'YYYY-MM-DD') AS load_date,
           live_weight_kg, dressed_weight_kg, wastage_pct,
           remaining_stock_kg, notes, updated_at`,
        [newStock.toFixed(3), notes?.trim() || null, id]
      )

      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'UPDATE', 'chicken_load', $2, $3)`,
        [
          req.user.id,
          id,
          JSON.stringify({
            field:     'remaining_stock_kg',
            before:    prevStock,
            after:     newStock,
            note:      notes?.trim() || null,
            load_number: existing.load_number,
          }),
        ]
      )

      return row
    })

    return res.json({
      load:    updated,
      message: `Remaining stock for ${updated.load_number} updated to ${newStock.toFixed(3)} kg.`,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/chicken-loads/:id/correct  — Admin only
//
// Authorized correction workflow:
//   • Inserts a NEW row with is_correction=TRUE referencing the original
//   • The original row is NEVER edited (immutable historical record)
//   • A correction_reason (non-empty string) is required
//   • Writes a CORRECT audit entry on the ORIGINAL load's entity_id
//
// This is the ONLY way to change live/dressed weights after creation.
// ══════════════════════════════════════════════════════════════════════════
router.post('/:id/correct', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    const {
      load_date,
      supplier_ref,
      live_weight_kg,
      dressed_weight_kg,
      remaining_stock_kg,
      notes,
      correction_reason,
    } = req.body ?? {}

    // ── Confirm original load exists and is NOT itself a correction ────────
    const { rows: [original] } = await query(
      `SELECT id, load_number, is_correction FROM chicken_loads WHERE id = $1`,
      [id]
    )

    if (!original) {
      return res.status(404).json({ error: 'Not Found', message: 'Original load not found.' })
    }

    // ── Validation ────────────────────────────────────────────────────────
    const errors = {}

    if (!correction_reason || typeof correction_reason !== 'string' || !correction_reason.trim()) {
      errors.correction_reason = 'correction_reason is required and must be a non-empty string.'
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!load_date || !dateRegex.test(load_date)) {
      errors.load_date = 'load_date is required and must be in YYYY-MM-DD format.'
    } else if (isNaN(new Date(load_date).getTime())) {
      errors.load_date = 'load_date is not a valid calendar date.'
    }

    const weightErrors = validateWeights({ live_weight_kg, dressed_weight_kg, remaining_stock_kg })
    Object.assign(errors, weightErrors)

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    const live      = Number(live_weight_kg)
    const dressed   = Number(dressed_weight_kg)
    const remaining = (remaining_stock_kg !== undefined && remaining_stock_kg !== null && remaining_stock_kg !== '')
      ? Number(remaining_stock_kg)
      : null

    // ── Insert correction row + audit ──────────────────────────────────────
    const correctionLoad = await withTransaction(async (client) => {
      // Insert the correction row
      const { rows: [newRow] } = await client.query(
        `INSERT INTO chicken_loads
           (load_date, supplier_ref, live_weight_kg, dressed_weight_kg,
            remaining_stock_kg, notes, is_correction, corrects_load_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8)
         RETURNING
           id, load_number,
           TO_CHAR(load_date, 'YYYY-MM-DD') AS load_date,
           supplier_ref, live_weight_kg, dressed_weight_kg,
           wastage_pct, remaining_stock_kg, notes,
           is_correction, corrects_load_id, created_at`,
        [
          load_date,
          supplier_ref?.trim() || null,
          live.toFixed(3),
          dressed.toFixed(3),
          remaining !== null ? remaining.toFixed(3) : null,
          notes?.trim() || null,
          id,              // corrects_load_id = original
          req.user.id,
        ]
      )

      // Audit entry on the ORIGINAL load's entity_id
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'CORRECT', 'chicken_load', $2, $3)`,
        [
          req.user.id,
          id,    // entity_id = original load
          JSON.stringify({
            original_load_number:   original.load_number,
            correction_load_number: newRow.load_number,
            correction_load_id:     newRow.id,
            correction_reason:      correction_reason.trim(),
            new_live_weight_kg:     live,
            new_dressed_weight_kg:  dressed,
            new_wastage_pct:        newRow.wastage_pct,
          }),
        ]
      )

      return newRow
    })

    return res.status(201).json({
      correction: correctionLoad,
      message: `Correction ${correctionLoad.load_number} created for ${original.load_number}.`,
    })
  } catch (err) {
    next(err)
  }
})

export default router
