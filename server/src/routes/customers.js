/**
 * server/src/routes/customers.js
 *
 * Customer (Parties) Management endpoints — Phase 08.
 *
 * Core Business Rules Enforced:
 *   • Duplicate Names vs. Unique Party IDs:
 *       - Multiple customers can share identical names (e.g. two "Taj Hotel"s).
 *       - party_code (Party ID) is strictly unique at both DB and API validation levels.
 *   • Disambiguation:
 *       - party_code, name, and address are returned together for unambiguous selection.
 *   • Auditable Opening Balances:
 *       - Opening balances are saved as account_adjustments ledger rows (adjustment_type='opening_balance').
 *       - Sign convention: customer owing ₹X means ledger_effect = -X (debit).
 *       - Corrections void the previous adjustment and insert a new one within a transaction.
 *   • Non-Destructive History:
 *       - Customers are deactivated (is_active=FALSE) instead of being hard-deleted.
 *       - Ledger history and opening balances are strictly preserved.
 *   • Role-Based Permissions:
 *       - Staff + Admin can create and edit customer profiles.
 *       - Admin only can toggle customer active/inactive status (deactivation).
 *   • Server-Side Validation:
 *       - Rejects missing names, invalid customer types, duplicate party IDs, and malformed balances.
 */

import { Router }                  from 'express'
import { query, withTransaction }  from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

// UUID format validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Allowed customer types
const ALLOWED_PARTY_TYPES = ['hotel', 'party', 'retail']

// ── Validation Helper ────────────────────────────────────────────────────────
function validateCustomerPayload({ name, party_code, phone, party_type, opening_balance }) {
  const errors = {}

  // Name: required, min 2 characters
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    errors.name = 'Customer name is required (minimum 2 characters).'
  }

  // party_code: optional on create (auto-generated if empty), but if provided must be >= 2 chars
  if (party_code !== undefined && party_code !== null && party_code !== '') {
    if (typeof party_code !== 'string' || party_code.trim().length < 2) {
      errors.party_code = 'Party ID must be at least 2 characters.'
    } else if (!/^[A-Za-z0-9_-]+$/.test(party_code.trim())) {
      errors.party_code = 'Party ID can only contain letters, numbers, hyphens, and underscores.'
    }
  }

  // Phone: optional, but if provided must match basic phone format
  if (phone !== undefined && phone !== null && phone !== '') {
    const cleanPhone = phone.trim()
    if (!/^[0-9+\-\s()]{7,15}$/.test(cleanPhone)) {
      errors.phone = 'Please enter a valid phone number (7 to 15 digits/symbols).'
    }
  }

  // party_type: optional (defaults to 'hotel'), but if provided must be in allowed list
  if (party_type !== undefined && party_type !== null && party_type !== '') {
    if (!ALLOWED_PARTY_TYPES.includes(party_type.trim())) {
      errors.party_type = `Customer type must be one of: ${ALLOWED_PARTY_TYPES.join(', ')}.`
    }
  }

  // opening_balance: optional numeric >= 0
  if (opening_balance !== undefined && opening_balance !== null && opening_balance !== '') {
    const ob = Number(opening_balance)
    if (isNaN(ob)) {
      errors.opening_balance = 'Opening balance must be a valid number.'
    } else if (ob < 0) {
      errors.opening_balance = 'Opening balance cannot be negative.'
    }
  }

  return errors
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/customers
// List customers with search & filter parameters:
//   ?search=... (matches name, party_code, or phone)
//   ?party_type=hotel|party|retail
//   ?status=active|inactive|all (default: all)
//   ?credit_enabled=true|false
//   ?page=1&limit=50
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const {
      search,
      party_type,
      status,
      credit_enabled,
      page = 1,
      limit = 50,
    } = req.query

    const pageNum  = Math.max(1, parseInt(page, 10)  || 1)
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50))
    const offset   = (pageNum - 1) * limitNum

    const conditions = []
    const params     = []

    // Search query across name, party_code, and phone
    if (search && search.trim()) {
      const q = `%${search.trim()}%`
      params.push(q)
      conditions.push(`(p.name ILIKE $${params.length} OR p.party_code ILIKE $${params.length} OR p.phone ILIKE $${params.length})`)
    }

    // Filter by customer type
    if (party_type && ALLOWED_PARTY_TYPES.includes(party_type.trim())) {
      params.push(party_type.trim())
      conditions.push(`p.party_type = $${params.length}`)
    }

    // Filter by active/inactive status
    if (status === 'active') {
      conditions.push('p.is_active = TRUE')
    } else if (status === 'inactive') {
      conditions.push('p.is_active = FALSE')
    }

    // Filter by credit enabled
    if (credit_enabled === 'true') {
      conditions.push('p.credit_enabled = TRUE')
    } else if (credit_enabled === 'false') {
      conditions.push('p.credit_enabled = FALSE')
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Count total matching records
    const countSql = `SELECT COUNT(*) AS total FROM parties p ${whereClause}`
    const { rows: [{ total }] } = await query(countSql, params)

    // Fetch page of customer records with auditable opening balance and creator names
    const dataSql = `
      SELECT
        p.id,
        p.party_code,
        p.name,
        p.phone,
        p.address,
        p.party_type,
        p.credit_enabled,
        p.is_active,
        p.created_at,
        p.updated_at,
        u_create.display_name AS created_by_name,
        u_update.display_name AS updated_by_name,
        -- Non-voided opening balance amount
        COALESCE((
          SELECT -aa.ledger_effect
          FROM account_adjustments aa
          WHERE aa.party_id = p.id
            AND aa.adjustment_type = 'opening_balance'
            AND aa.voided_at IS NULL
          LIMIT 1
        ), 0) AS opening_balance
      FROM parties p
      LEFT JOIN users u_create ON u_create.id = p.created_by
      LEFT JOIN users u_update ON u_update.id = p.updated_by
      ${whereClause}
      ORDER BY p.is_active DESC, p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `
    const { rows: customers } = await query(dataSql, [...params, limitNum, offset])

    // Overall summary metrics for dashboard cards
    const summarySql = `
      SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE is_active = TRUE) AS active_count,
        COUNT(*) FILTER (WHERE is_active = FALSE) AS inactive_count,
        COUNT(*) FILTER (WHERE credit_enabled = TRUE AND is_active = TRUE) AS credit_enabled_count,
        COALESCE(SUM(
          (SELECT -aa.ledger_effect
           FROM account_adjustments aa
           WHERE aa.party_id = parties.id
             AND aa.adjustment_type = 'opening_balance'
             AND aa.voided_at IS NULL
           LIMIT 1)
        ), 0) AS total_opening_balance
      FROM parties
    `
    const { rows: [summary] } = await query(summarySql)

    return res.json({
      customers,
      total: parseInt(total, 10),
      page:  pageNum,
      limit: limitNum,
      summary: {
        total_customers: parseInt(summary.total_count, 10),
        active_customers: parseInt(summary.active_count, 10),
        inactive_customers: parseInt(summary.inactive_count, 10),
        credit_enabled_customers: parseInt(summary.credit_enabled_count, 10),
        total_opening_balance: Number(summary.total_opening_balance).toFixed(2),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/customers/:id
// Get single customer details with opening balance ledger row and audit history.
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const customerSql = `
      SELECT
        p.id,
        p.party_code,
        p.name,
        p.phone,
        p.address,
        p.party_type,
        p.credit_enabled,
        p.is_active,
        p.created_at,
        p.updated_at,
        u_create.display_name AS created_by_name,
        u_update.display_name AS updated_by_name,
        COALESCE((
          SELECT -aa.ledger_effect
          FROM account_adjustments aa
          WHERE aa.party_id = p.id
            AND aa.adjustment_type = 'opening_balance'
            AND aa.voided_at IS NULL
          LIMIT 1
        ), 0) AS opening_balance
      FROM parties p
      LEFT JOIN users u_create ON u_create.id = p.created_by
      LEFT JOIN users u_update ON u_update.id = p.updated_by
      WHERE p.id = $1
    `
    const { rows: [customer] } = await query(customerSql, [id])
    if (!customer) {
      return res.status(404).json({ error: 'Not Found', message: 'Customer not found.' })
    }

    // Fetch opening balance adjustment history (including voided records)
    const adjSql = `
      SELECT
        aa.id,
        aa.adjustment_type,
        -aa.ledger_effect AS balance_effect,
        aa.effective_date,
        aa.reason,
        aa.created_at,
        aa.voided_at,
        aa.void_reason,
        u_create.display_name AS created_by_name,
        u_void.display_name AS voided_by_name
      FROM account_adjustments aa
      LEFT JOIN users u_create ON u_create.id = aa.created_by
      LEFT JOIN users u_void   ON u_void.id   = aa.voided_by
      WHERE aa.party_id = $1 AND aa.adjustment_type = 'opening_balance'
      ORDER BY aa.created_at DESC
    `
    const { rows: openingBalances } = await query(adjSql, [id])

    // Fetch audit trail for this customer profile
    const auditSql = `
      SELECT
        al.id,
        al.action_type,
        al.event_timestamp,
        al.change_metadata,
        u.display_name AS actor_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.entity_type = 'party' AND al.entity_id = $1
      ORDER BY al.event_timestamp DESC
    `
    const { rows: audit } = await query(auditSql, [id])

    return res.json({
      customer,
      openingBalances,
      audit,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/customers
// Create a new customer profile with optional auditable opening balance.
// Allowed: Staff and Admin (requireAuth).
// ══════════════════════════════════════════════════════════════════════════
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      name,
      party_code,
      phone,
      address,
      party_type = 'hotel',
      credit_enabled = false,
      opening_balance,
      opening_balance_date,
      opening_balance_reason,
    } = req.body ?? {}

    // Field-level validation
    const errors = validateCustomerPayload({
      name,
      party_code,
      phone,
      party_type,
      opening_balance,
    })

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    const trimmedName      = name.trim()
    const trimmedPartyType = party_type ? party_type.trim() : 'hotel'
    const trimmedPhone     = phone ? phone.trim() : null
    const trimmedAddress   = address ? address.trim() : null
    const isCredit         = Boolean(credit_enabled)

    // Check Party ID uniqueness if provided
    let finalPartyCode = party_code ? party_code.trim().toUpperCase() : null
    if (finalPartyCode) {
      const { rows: [existing] } = await query(
        'SELECT id FROM parties WHERE UPPER(party_code) = UPPER($1)',
        [finalPartyCode]
      )
      if (existing) {
        return res.status(400).json({
          error: 'Validation Error',
          errors: { party_code: `Party ID '${finalPartyCode}' is already in use. Please specify a unique Party ID.` },
        })
      }
    }

    // Transaction: Insert customer + auditable opening balance + audit log
    const result = await withTransaction(async (client) => {
      // If party_code was not specified, let the sequence default generate it
      let insertSql, insertParams
      if (finalPartyCode) {
        insertSql = `
          INSERT INTO parties (
            name, party_code, phone, address, party_type, credit_enabled, created_by, updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
          RETURNING *
        `
        insertParams = [trimmedName, finalPartyCode, trimmedPhone, trimmedAddress, trimmedPartyType, isCredit, req.user.id]
      } else {
        insertSql = `
          INSERT INTO parties (
            name, phone, address, party_type, credit_enabled, created_by, updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $6)
          RETURNING *
        `
        insertParams = [trimmedName, trimmedPhone, trimmedAddress, trimmedPartyType, isCredit, req.user.id]
      }

      const { rows: [newParty] } = await client.query(insertSql, insertParams)

      // If opening balance is specified and > 0, record in account_adjustments
      let createdOpeningBalance = 0
      if (opening_balance !== undefined && opening_balance !== null && opening_balance !== '') {
        const obAmount = Number(opening_balance)
        if (obAmount > 0) {
          createdOpeningBalance = obAmount
          // Negative ledger effect = debit (customer owes money)
          const ledgerEffect = -obAmount
          const effectiveDate = opening_balance_date || new Date().toISOString().slice(0, 10)
          const reason = opening_balance_reason?.trim() || 'Initial opening balance recorded on customer creation'

          await client.query(
            `INSERT INTO account_adjustments (
               party_id, adjustment_type, ledger_effect, effective_date, reason, created_by
             )
             VALUES ($1, 'opening_balance', $2, $3, $4, $5)`,
            [newParty.id, ledgerEffect, effectiveDate, reason, req.user.id]
          )
        }
      }

      // Record CREATE event in audit_logs
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'CREATE', 'party', $2, $3)`,
        [
          req.user.id,
          newParty.id,
          JSON.stringify({
            party_code: newParty.party_code,
            name: newParty.name,
            phone: newParty.phone,
            address: newParty.address,
            party_type: newParty.party_type,
            credit_enabled: newParty.credit_enabled,
            opening_balance: createdOpeningBalance,
          }),
        ]
      )

      return {
        ...newParty,
        opening_balance: createdOpeningBalance,
        created_by_name: req.user.display_name,
      }
    })

    return res.status(201).json({
      customer: result,
      message: `Customer ${result.name} (${result.party_code}) created successfully.`,
    })
  } catch (err) {
    // Handle unique constraint violation on party_code gracefully if caught at DB level
    if (err.code === '23505' && err.constraint === 'parties_party_code_key') {
      return res.status(400).json({
        error: 'Validation Error',
        errors: { party_code: 'Party ID is already registered. Please choose a different Party ID.' },
      })
    }
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// PUT /api/customers/:id
// Update customer profile details and/or adjust opening balance.
// Allowed: Staff and Admin (requireAuth).
// ══════════════════════════════════════════════════════════════════════════
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const {
      name,
      party_code,
      phone,
      address,
      party_type,
      credit_enabled,
      opening_balance,
      opening_balance_reason,
    } = req.body ?? {}

    // Validation
    const errors = validateCustomerPayload({
      name,
      party_code,
      phone,
      party_type,
      opening_balance,
    })

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // Verify customer exists
    const { rows: [existing] } = await query(
      `SELECT * FROM parties WHERE id = $1`,
      [id]
    )
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Customer not found.' })
    }

    // Check Party ID uniqueness if changed
    const newPartyCode = party_code ? party_code.trim().toUpperCase() : existing.party_code
    if (newPartyCode !== existing.party_code) {
      const { rows: [dup] } = await query(
        'SELECT id FROM parties WHERE UPPER(party_code) = UPPER($1) AND id <> $2',
        [newPartyCode, id]
      )
      if (dup) {
        return res.status(400).json({
          error: 'Validation Error',
          errors: { party_code: `Party ID '${newPartyCode}' is already in use by another customer.` },
        })
      }
    }

    const updatedName      = name.trim()
    const updatedPhone     = phone !== undefined ? (phone ? phone.trim() : null) : existing.phone
    const updatedAddress   = address !== undefined ? (address ? address.trim() : null) : existing.address
    const updatedPartyType = party_type ? party_type.trim() : existing.party_type
    const updatedCredit    = credit_enabled !== undefined ? Boolean(credit_enabled) : existing.credit_enabled

    // Execute update inside transaction
    const updatedCustomer = await withTransaction(async (client) => {
      const { rows: [updated] } = await client.query(
        `UPDATE parties
         SET
           name = $1,
           party_code = $2,
           phone = $3,
           address = $4,
           party_type = $5,
           credit_enabled = $6,
           updated_by = $7,
           updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [
          updatedName,
          newPartyCode,
          updatedPhone,
          updatedAddress,
          updatedPartyType,
          updatedCredit,
          req.user.id,
          id,
        ]
      )

      // Handle opening balance adjustment if provided
      let currentOpeningBalance = 0
      if (opening_balance !== undefined && opening_balance !== null && opening_balance !== '') {
        const newObAmount = Number(opening_balance)

        // Find existing active opening balance
        const { rows: [activeAdj] } = await client.query(
          `SELECT id, ledger_effect
           FROM account_adjustments
           WHERE party_id = $1 AND adjustment_type = 'opening_balance' AND voided_at IS NULL`,
          [id]
        )

        const oldObAmount = activeAdj ? -Number(activeAdj.ledger_effect) : 0

        if (newObAmount !== oldObAmount) {
          // Void previous opening balance if one existed
          if (activeAdj) {
            await client.query(
              `UPDATE account_adjustments
               SET voided_at = NOW(),
                   voided_by = $1,
                   void_reason = $2
               WHERE id = $3`,
              [
                req.user.id,
                opening_balance_reason?.trim() || 'Voided due to opening balance update',
                activeAdj.id,
              ]
            )
          }

          // Insert new opening balance if > 0
          if (newObAmount > 0) {
            await client.query(
              `INSERT INTO account_adjustments (
                 party_id, adjustment_type, ledger_effect, effective_date, reason, created_by
               )
               VALUES ($1, 'opening_balance', $2, CURRENT_DATE, $3, $4)`,
              [
                id,
                -newObAmount,
                opening_balance_reason?.trim() || 'Updated opening balance',
                req.user.id,
              ]
            )
          }
        }
        currentOpeningBalance = newObAmount
      }

      // Record UPDATE in audit_logs
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'UPDATE', 'party', $2, $3)`,
        [
          req.user.id,
          id,
          JSON.stringify({
            previous: {
              name: existing.name,
              party_code: existing.party_code,
              phone: existing.phone,
              address: existing.address,
              party_type: existing.party_type,
              credit_enabled: existing.credit_enabled,
            },
            updated: {
              name: updated.name,
              party_code: updated.party_code,
              phone: updated.phone,
              address: updated.address,
              party_type: updated.party_type,
              credit_enabled: updated.credit_enabled,
              opening_balance: currentOpeningBalance,
            },
          }),
        ]
      )

      return {
        ...updated,
        opening_balance: currentOpeningBalance,
        updated_by_name: req.user.display_name,
      }
    })

    return res.json({
      customer: updatedCustomer,
      message: `Customer ${updatedCustomer.name} updated successfully.`,
    })
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'parties_party_code_key') {
      return res.status(400).json({
        error: 'Validation Error',
        errors: { party_code: 'Party ID is already registered. Please choose a different Party ID.' },
      })
    }
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// PATCH /api/customers/:id/status
// Toggle active/inactive status (deactivation rather than hard delete).
// Allowed: Admin only (requireRole('admin')).
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id/status', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const { is_active } = req.body ?? {}
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        error: 'Validation Error',
        errors: { is_active: 'is_active must be a boolean (true or false).' },
      })
    }

    const result = await withTransaction(async (client) => {
      const { rows: [existing] } = await client.query(
        'SELECT id, name, party_code, is_active FROM parties WHERE id = $1',
        [id]
      )
      if (!existing) {
        return null
      }

      const { rows: [updated] } = await client.query(
        `UPDATE parties
         SET is_active = $1,
             updated_by = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [is_active, req.user.id, id]
      )

      // Audit log entry
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'UPDATE', 'party', $2, $3)`,
        [
          req.user.id,
          id,
          JSON.stringify({
            status_change: is_active ? 'ACTIVATED' : 'DEACTIVATED',
            previous_is_active: existing.is_active,
            new_is_active: is_active,
          }),
        ]
      )

      return updated
    })

    if (!result) {
      return res.status(404).json({ error: 'Not Found', message: 'Customer not found.' })
    }

    return res.json({
      customer: result,
      message: `Customer ${result.name} (${result.party_code}) has been ${is_active ? 'activated' : 'deactivated'}.`,
    })
  } catch (err) {
    next(err)
  }
})

export default router
