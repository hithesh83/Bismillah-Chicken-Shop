/**
 * server/src/routes/sales.js
 *
 * Sales Management endpoints — Phase 09.
 *
 * Core Business Rules Enforced:
 *   • Server-Side Financial Calculations:
 *       - line_total = ROUND(quantity_kg * rate_per_kg, 2)
 *       - total_amount = SUM(line_totals)
 *       - Server recalculates and validates all line and header amounts.
 *   • Historical Price Immutability:
 *       - sale_items records the actual charged rate_per_kg at sale time.
 *       - Later changes to daily_prices never alter historical sales.
 *   • Draft → Confirmed Workflow & Database Triggers:
 *       - In accordance with trigger fn_sales_no_direct_confirm, sale is inserted as
 *         'draft', sale_items are inserted, and then status is updated to 'confirmed'.
 *       - Trigger fn_sales_validate_on_confirm validates item count and total_amount > 0.
 *   • Atomic Payments & No Double-Counting:
 *       - When an immediate payment is made (full or partial), the sale, items, payment,
 *         and payment_allocations rows are inserted in a single PostgreSQL transaction.
 *       - Outstanding due = total_amount - allocated_payments.
 *       - Party ledger balance = sales total - payments amount. Neither initial nor
 *         later payments are double-counted.
 *   • Customer Credit Eligibility:
 *       - party_credit sales require an active customer with credit_enabled = TRUE.
 *       - walkin sales require party_id = null.
 *   • Idempotency & Duplicate Submission Protection:
 *       - Uses idempotency_key to prevent accidental duplicate sale submissions.
 *   • Role-Based Access Control:
 *       - Staff + Admin can create and view sales.
 *       - Admin only can void or correct confirmed sales.
 *   • No Automatic Stock Deduction:
 *       - Manual stock observations remain strictly manual and independent.
 */

import { Router }                  from 'express'
import { query, withTransaction }  from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// IST date helper: YYYY-MM-DD
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ── Financial Math Helpers ──────────────────────────────────────────────────
function roundCurrency(val) {
  return Math.round((Number(val) + Number.EPSILON) * 100) / 100
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/sales
// List sales with search, date range, type, and payment status filters.
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const {
      search,
      party_id,
      sale_type,
      status,
      payment_status,
      from,
      to,
      page = 1,
      limit = 30,
    } = req.query

    const pageNum  = Math.max(1, parseInt(page, 10)  || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30))
    const offset   = (pageNum - 1) * limitNum

    const conditions = []
    const params     = []

    // Search query across sale_number, customer name, or party_code
    if (search && search.trim()) {
      const q = `%${search.trim()}%`
      params.push(q)
      conditions.push(`(s.sale_number ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.party_code ILIKE $${params.length})`)
    }

    // Specific party filter
    if (party_id && UUID_REGEX.test(party_id.trim())) {
      params.push(party_id.trim())
      conditions.push(`s.party_id = $${params.length}`)
    }

    // Sale type filter
    if (sale_type && ['walkin', 'party_cash', 'party_credit'].includes(sale_type.trim())) {
      params.push(sale_type.trim())
      conditions.push(`s.sale_type = $${params.length}`)
    }

    // Status filter (default to non-draft unless specified)
    if (status && ['draft', 'confirmed', 'voided'].includes(status.trim())) {
      params.push(status.trim())
      conditions.push(`s.status = $${params.length}`)
    } else {
      conditions.push(`s.status != 'draft'`)
    }

    // Date range filter (sale_date)
    if (from) {
      params.push(from)
      conditions.push(`s.sale_date >= $${params.length}::date`)
    }
    if (to) {
      params.push(to)
      conditions.push(`s.sale_date <= $${params.length}::date`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Payment status having filter (computed from allocated payments)
    let paymentHaving = ''
    if (payment_status === 'paid') {
      paymentHaving = 'HAVING (s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) <= 0.005'
    } else if (payment_status === 'partial') {
      paymentHaving = 'HAVING COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) > 0.005 AND (s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) > 0.005'
    } else if (payment_status === 'unpaid') {
      paymentHaving = 'HAVING COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) <= 0.005'
    }

    // Main query with payments aggregation
    const dataSql = `
      SELECT
        s.id,
        s.sale_number,
        s.status,
        s.sale_date,
        s.sale_timestamp,
        s.sale_type,
        s.total_amount,
        s.notes,
        s.is_correction,
        s.corrects_sale_id,
        s.voided_at,
        s.void_reason,
        s.created_at,
        p.id AS party_id,
        p.name AS party_name,
        p.party_code,
        p.address AS party_address,
        u_create.display_name AS created_by_name,
        u_void.display_name AS voided_by_name,
        (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count,
        COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS paid_amount,
        GREATEST(0, s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS due_amount
      FROM sales s
      LEFT JOIN parties p ON p.id = s.party_id
      LEFT JOIN users u_create ON u_create.id = s.created_by
      LEFT JOIN users u_void   ON u_void.id   = s.voided_by
      LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
      ${whereClause}
      GROUP BY s.id, p.id, u_create.display_name, u_void.display_name
      ${paymentHaving}
      ORDER BY s.sale_timestamp DESC, s.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `

    const { rows: sales } = await query(dataSql, [...params, limitNum, offset])

    // Total count query
    const countSql = `
      SELECT COUNT(*) AS total
      FROM (
        SELECT s.id
        FROM sales s
        LEFT JOIN parties p ON p.id = s.party_id
        LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
        ${whereClause}
        GROUP BY s.id, p.id
        ${paymentHaving}
      ) sub
    `
    const { rows: [{ total }] } = await query(countSql, params)

    // Summary statistics for sales
    const summarySql = `
      SELECT
        COUNT(*) AS total_sales,
        COALESCE(SUM(s.total_amount) FILTER (WHERE s.status = 'confirmed'), 0) AS total_revenue,
        COALESCE((
          SELECT SUM(pa.allocated_amount)
          FROM payment_allocations pa
          JOIN sales s2 ON s2.id = pa.sale_id
          WHERE s2.status = 'confirmed' AND pa.voided_at IS NULL
        ), 0) AS total_collected
      FROM sales s
      WHERE s.status = 'confirmed'
    `
    const { rows: [summary] } = await query(summarySql)

    const totalRev  = Number(summary.total_revenue || 0)
    const totalColl = Number(summary.total_collected || 0)

    return res.json({
      sales,
      total: parseInt(total, 10),
      page:  pageNum,
      limit: limitNum,
      summary: {
        total_sales: parseInt(summary.total_sales, 10),
        total_revenue: totalRev.toFixed(2),
        total_collected: totalColl.toFixed(2),
        total_outstanding: Math.max(0, totalRev - totalColl).toFixed(2),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/sales/:id
// Get single sale details with line items, allocated payments, and audit trail.
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const saleSql = `
      SELECT
        s.id,
        s.sale_number,
        s.status,
        s.sale_date,
        s.sale_timestamp,
        s.sale_type,
        s.total_amount,
        s.notes,
        s.is_correction,
        s.corrects_sale_id,
        s.voided_at,
        s.void_reason,
        s.created_at,
        p.id AS party_id,
        p.name AS party_name,
        p.party_code,
        p.phone AS party_phone,
        p.address AS party_address,
        u_create.display_name AS created_by_name,
        u_create.role AS created_by_role,
        u_void.display_name AS voided_by_name,
        COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS paid_amount,
        GREATEST(0, s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS due_amount
      FROM sales s
      LEFT JOIN parties p ON p.id = s.party_id
      LEFT JOIN users u_create ON u_create.id = s.created_by
      LEFT JOIN users u_void   ON u_void.id   = s.voided_by
      LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
      WHERE s.id = $1
      GROUP BY s.id, p.id, u_create.display_name, u_create.role, u_void.display_name
    `
    const { rows: [sale] } = await query(saleSql, [id])
    if (!sale) {
      return res.status(404).json({ error: 'Not Found', message: 'Sale not found.' })
    }

    // Line items with product catalogue information
    const itemsSql = `
      SELECT
        si.id,
        si.product_id,
        p.name AS product_name,
        p.category AS product_category,
        p.seed_key,
        si.quantity_kg,
        si.rate_per_kg,
        si.line_total,
        si.created_at
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
      ORDER BY si.created_at ASC
    `
    const { rows: items } = await query(itemsSql, [id])

    // Payment allocations applied to this sale
    const paymentsSql = `
      SELECT
        pa.id AS allocation_id,
        pa.allocated_amount,
        pa.created_at AS allocated_at,
        pa.voided_at,
        pa.void_reason,
        pay.id AS payment_id,
        pay.payment_date,
        pay.payment_timestamp,
        pay.amount AS payment_total_amount,
        pay.method,
        pay.external_ref,
        pay.notes,
        u.display_name AS recorded_by_name
      FROM payment_allocations pa
      JOIN payments pay ON pay.id = pa.payment_id
      LEFT JOIN users u ON u.id = pa.created_by
      WHERE pa.sale_id = $1
      ORDER BY pa.created_at ASC
    `
    const { rows: payments } = await query(paymentsSql, [id])

    // Audit logs for this sale
    const auditSql = `
      SELECT
        al.id,
        al.action_type,
        al.event_timestamp,
        al.change_metadata,
        u.display_name AS actor_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.entity_type = 'sale' AND al.entity_id = $1
      ORDER BY al.event_timestamp DESC
    `
    const { rows: audit } = await query(auditSql, [id])

    return res.json({
      sale,
      items,
      payments,
      audit,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/sales
// Create a new sale with line items and optional immediate payment.
// Atomic execution inside a single PostgreSQL transaction.
// Allowed: Staff and Admin (requireAuth).
// ══════════════════════════════════════════════════════════════════════════
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      sale_date = todayIST(),
      sale_type,
      party_id,
      items,
      initial_payment,
      notes,
      idempotency_key: bodyIdempKey,
    } = req.body ?? {}

    // Idempotency key from header or body
    const idempotency_key = req.headers['idempotency-key'] || bodyIdempKey || null

    // ── Idempotency Check ──────────────────────────────────────────────────
    if (idempotency_key && typeof idempotency_key === 'string' && idempotency_key.trim()) {
      const { rows: [existing] } = await query(
        `SELECT id, sale_number, status, total_amount FROM sales WHERE idempotency_key = $1`,
        [idempotency_key.trim()]
      )
      if (existing) {
        return res.status(200).json({
          sale: existing,
          message: `Sale ${existing.sale_number} already recorded (idempotent submission).`,
          is_duplicate: true,
        })
      }
    }

    // ── Validation: Sale Header ────────────────────────────────────────────
    const errors = {}

    // sale_date
    if (!sale_date || !/^\d{4}-\d{2}-\d{2}$/.test(sale_date) || isNaN(new Date(sale_date).getTime())) {
      errors.sale_date = 'sale_date must be a valid calendar date in YYYY-MM-DD format.'
    }

    // sale_type
    const validSaleTypes = ['walkin', 'party_cash', 'party_credit']
    if (!sale_type || !validSaleTypes.includes(sale_type)) {
      errors.sale_type = `sale_type must be one of: ${validSaleTypes.join(', ')}.`
    }

    // party_id validation
    let customerParty = null
    if (sale_type === 'walkin') {
      if (party_id) {
        errors.party_id = 'Walk-in sales cannot be assigned to a customer account.'
      }
    } else {
      // party_cash or party_credit requires party_id
      if (!party_id || !UUID_REGEX.test(party_id.trim())) {
        errors.party_id = 'Customer selection (Party ID) is required for party and credit sales.'
      } else {
        const { rows: [party] } = await query(
          'SELECT id, name, party_code, is_active, credit_enabled FROM parties WHERE id = $1',
          [party_id.trim()]
        )
        if (!party) {
          errors.party_id = 'Selected customer does not exist.'
        } else if (!party.is_active) {
          errors.party_id = `Customer ${party.name} (${party.party_code}) is deactivated. Cannot record sales for inactive accounts.`
        } else if (sale_type === 'party_credit' && !party.credit_enabled) {
          errors.party_id = `Customer ${party.name} (${party.party_code}) is not enabled for credit sales. Please enable credit or select cash sale.`
        } else {
          customerParty = party
        }
      }
    }

    // ── Validation: Line Items ─────────────────────────────────────────────
    if (!Array.isArray(items) || items.length === 0) {
      errors.items = 'At least one line item is required for a sale.'
    } else {
      const itemErrors = []
      let computedTotal = 0

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx]
        const err = {}

        if (!item.product_id || !UUID_REGEX.test(String(item.product_id).trim())) {
          err.product_id = 'product_id is required and must be a valid UUID.'
        }

        const qty = Number(item.quantity_kg)
        if (item.quantity_kg === undefined || item.quantity_kg === null || isNaN(qty) || qty <= 0) {
          err.quantity_kg = 'quantity_kg must be a positive number greater than zero.'
        }

        const rate = Number(item.rate_per_kg)
        if (item.rate_per_kg === undefined || item.rate_per_kg === null || isNaN(rate) || rate <= 0) {
          err.rate_per_kg = 'rate_per_kg must be a positive number greater than zero.'
        }

        if (Object.keys(err).length === 0) {
          const lineTotal = roundCurrency(qty * rate)
          if (lineTotal <= 0) {
            err.line_total = 'Computed line total must be greater than zero.'
          } else {
            computedTotal = roundCurrency(computedTotal + lineTotal)
          }
        }

        if (Object.keys(err).length > 0) {
          itemErrors[idx] = err
        }
      }

      if (itemErrors.length > 0) {
        errors.items = itemErrors
      }

      // ── Validation: Initial Payment ───────────────────────────────────────
      if (initial_payment) {
        const payAmount = Number(initial_payment.amount)
        if (initial_payment.amount !== undefined && initial_payment.amount !== null && initial_payment.amount !== '') {
          if (isNaN(payAmount) || payAmount < 0) {
            errors.initial_payment = 'Payment amount cannot be negative.'
          } else if (payAmount > computedTotal) {
            errors.initial_payment = `Payment amount (₹${payAmount.toFixed(2)}) cannot exceed sale total (₹${computedTotal.toFixed(2)}).`
          }
        }
        if (initial_payment.method && !['cash', 'upi', 'bank', 'other'].includes(initial_payment.method)) {
          errors.initial_payment_method = 'Payment method must be one of: cash, upi, bank, other.'
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Error', errors })
    }

    // ── Atomic Execution in Transaction ────────────────────────────────────
    const result = await withTransaction(async (client) => {
      // 1. Insert sale in draft status (respecting trigger fn_sales_no_direct_confirm)
      const insertSaleSql = `
        INSERT INTO sales (
          sale_date,
          sale_timestamp,
          party_id,
          sale_type,
          notes,
          created_by,
          status,
          idempotency_key
        )
        VALUES ($1, NOW(), $2, $3, $4, $5, 'draft', $6)
        RETURNING id, sale_number, sale_date, sale_timestamp, sale_type, status
      `
      const { rows: [newSale] } = await client.query(insertSaleSql, [
        sale_date,
        customerParty ? customerParty.id : null,
        sale_type,
        notes?.trim() || null,
        req.user.id,
        idempotency_key ? idempotency_key.trim() : null,
      ])

      // 2. Insert line items
      const insertedItems = []
      for (const item of items) {
        const qty       = Number(item.quantity_kg)
        const rate      = Number(item.rate_per_kg)
        const lineTotal = roundCurrency(qty * rate)

        const { rows: [insertedItem] } = await client.query(
          `INSERT INTO sale_items (sale_id, product_id, quantity_kg, rate_per_kg, line_total)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, product_id, quantity_kg, rate_per_kg, line_total`,
          [newSale.id, item.product_id, qty.toFixed(3), rate.toFixed(2), lineTotal.toFixed(2)]
        )
        insertedItems.push(insertedItem)
      }

      // 3. Confirm the sale (trigger fn_sales_validate_on_confirm validates & calculates total_amount)
      const { rows: [confirmedSale] } = await client.query(
        `UPDATE sales
         SET status = 'confirmed',
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [newSale.id]
      )

      // 4. Handle immediate initial payment if provided
      let recordedPayment = null
      let paidAmount = 0
      const paymentToRecord = Number(initial_payment?.amount || 0)

      if (paymentToRecord > 0) {
        paidAmount = roundCurrency(paymentToRecord)

        // Insert payment header
        const { rows: [paymentRow] } = await client.query(
          `INSERT INTO payments (
             party_id,
             payment_date,
             payment_timestamp,
             amount,
             method,
             external_ref,
             notes,
             created_by
           )
           VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
           RETURNING id, payment_date, amount, method, external_ref`,
          [
            customerParty ? customerParty.id : null,
            sale_date,
            paidAmount.toFixed(2),
            initial_payment.method || 'cash',
            initial_payment.external_ref?.trim() || null,
            initial_payment.notes?.trim() || `Initial payment for sale ${confirmedSale.sale_number}`,
            req.user.id,
          ]
        )

        // Insert payment allocation linked to this sale
        const { rows: [allocationRow] } = await client.query(
          `INSERT INTO payment_allocations (
             payment_id,
             sale_id,
             allocated_amount,
             created_by
           )
           VALUES ($1, $2, $3, $4)
           RETURNING id, allocated_amount`,
          [paymentRow.id, confirmedSale.id, paidAmount.toFixed(2), req.user.id]
        )

        recordedPayment = {
          payment_id: paymentRow.id,
          allocation_id: allocationRow.id,
          amount: paidAmount,
          method: paymentRow.method,
          external_ref: paymentRow.external_ref,
        }
      }

      const dueAmount = roundCurrency(Number(confirmedSale.total_amount) - paidAmount)

      // 5. Record CREATE event in audit_logs
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'CREATE', 'sale', $2, $3)`,
        [
          req.user.id,
          confirmedSale.id,
          JSON.stringify({
            sale_number:   confirmedSale.sale_number,
            sale_date:     confirmedSale.sale_date,
            sale_type:     confirmedSale.sale_type,
            party_id:      confirmedSale.party_id,
            total_amount:  Number(confirmedSale.total_amount),
            paid_amount:   paidAmount,
            due_amount:    dueAmount,
            items_count:   insertedItems.length,
            created_by:    req.user.display_name,
          }),
        ]
      )

      return {
        ...confirmedSale,
        items: insertedItems,
        payment: recordedPayment,
        paid_amount: paidAmount,
        due_amount: dueAmount,
        customer: customerParty,
      }
    })

    return res.status(201).json({
      sale: result,
      message: `Sale ${result.sale_number} (₹${Number(result.total_amount).toFixed(2)}) created successfully.`,
    })
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'sales_idempotency_key_key') {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A sale with this idempotency key was already created.',
      })
    }
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/sales/:id/void
// Authorized void workflow for confirmed sales.
// Allowed: Admin only (requireRole('admin')).
// ══════════════════════════════════════════════════════════════════════════
router.post('/:id/void', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const { void_reason } = req.body ?? {}
    if (!void_reason || typeof void_reason !== 'string' || void_reason.trim().length < 3) {
      return res.status(400).json({
        error: 'Validation Error',
        errors: { void_reason: 'A clear void_reason is required (minimum 3 characters).' },
      })
    }

    const result = await withTransaction(async (client) => {
      // 1. Lock and check the sale
      const { rows: [sale] } = await client.query(
        'SELECT id, sale_number, status, total_amount, party_id FROM sales WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!sale) return null
      if (sale.status === 'voided') {
        throw new Error('Sale is already voided.')
      }

      // 2. Void any active payment allocations associated with this sale
      await client.query(
        `UPDATE payment_allocations
         SET voided_at = NOW(),
             voided_by = $1,
             void_reason = $2
         WHERE sale_id = $3 AND voided_at IS NULL`,
        [req.user.id, `Voided with sale ${sale.sale_number}: ${void_reason.trim()}`, id]
      )

      // 3. Void the sale
      const { rows: [voided] } = await client.query(
        `UPDATE sales
         SET status = 'voided',
             voided_at = NOW(),
             voided_by = $1,
             void_reason = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [req.user.id, void_reason.trim(), id]
      )

      // 4. Audit log entry
      await client.query(
        `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
         VALUES ($1, 'VOID', 'sale', $2, $3)`,
        [
          req.user.id,
          id,
          JSON.stringify({
            sale_number: sale.sale_number,
            void_reason: void_reason.trim(),
            total_amount: Number(sale.total_amount),
            party_id: sale.party_id,
          }),
        ]
      )

      return voided
    })

    if (!result) {
      return res.status(404).json({ error: 'Not Found', message: 'Sale not found.' })
    }

    return res.json({
      sale: result,
      message: `Sale ${result.sale_number} has been voided successfully.`,
    })
  } catch (err) {
    if (err.message === 'Sale is already voided.') {
      return res.status(400).json({ error: 'Bad Request', message: err.message })
    }
    next(err)
  }
})

export default router
