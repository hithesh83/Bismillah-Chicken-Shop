/**
 * server/src/routes/payments.js
 *
 * Phase 10 — Payments, Ledger and Outstanding
 *
 * Key Responsibilities:
 *   • GET  /api/payments             — list payment receipts with search & filters
 *   • GET  /api/payments/:id         — single payment detail, party, allocations, audit
 *   • POST /api/payments             — record payment receipt (FIFO, specific, or advance)
 *   • POST /api/payments/:id/void    — authorized payment void (Admin only)
 *
 * Accounting & Ledger Rules:
 *   • Every payment is an immutable receipt (void instead of delete).
 *   • FIFO Strategy: Automatically allocates payment across oldest open credit sales.
 *   • Specific Strategy: Allocates to chosen open invoices (cannot exceed invoice due).
 *   • Excess payment sits as unallocated credit / customer advance.
 *   • Atomic transactions with strict locking order:
 *       1. payments row first (FOR UPDATE)
 *       2. sales rows second (FOR UPDATE)
 *   • Zero double-counting: Sale total is debit (+), payment is credit (-).
 */

import express from 'express'
import pool, { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = express.Router()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALLOWED_METHODS = ['cash', 'upi', 'bank', 'other']

function roundCurrency(val) {
  return Math.round((Number(val) + Number.EPSILON) * 100) / 100
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/payments
// List payments with search, pagination, and filters:
//   ?search=...         (matches payment_number, party name, party_code, external_ref)
//   ?party_id=UUID      (filter by customer)
//   ?method=cash|upi|... (filter by payment method)
//   ?status=active|voided|all (default: active)
//   ?allocation_status=allocated|unallocated|partial
//   ?from=YYYY-MM-DD
//   ?to=YYYY-MM-DD
//   ?page=1&limit=50
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const {
      search,
      party_id,
      method,
      status = 'active',
      allocation_status,
      from,
      to,
      page = 1,
      limit = 50,
    } = req.query

    const pageNum  = Math.max(1, parseInt(page, 10)  || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50))
    const offset   = (pageNum - 1) * limitNum

    const conditions = []
    const params = []

    // Customer filter
    if (party_id) {
      if (!UUID_REGEX.test(party_id)) {
        return res.status(400).json({ error: 'Invalid party_id format' })
      }
      params.push(party_id)
      conditions.push(`p.party_id = $${params.length}`)
    }

    // Method filter
    if (method && ALLOWED_METHODS.includes(method.toLowerCase())) {
      params.push(method.toLowerCase())
      conditions.push(`p.method = $${params.length}`)
    }

    // Status filter (active vs voided)
    if (status === 'active') {
      conditions.push('p.voided_at IS NULL')
    } else if (status === 'voided') {
      conditions.push('p.voided_at IS NOT NULL')
    }

    // Date range filter
    if (from) {
      params.push(from)
      conditions.push(`p.payment_date >= $${params.length}::date`)
    }
    if (to) {
      params.push(to)
      conditions.push(`p.payment_date <= $${params.length}::date`)
    }

    // Search query
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`)
      const idx = params.length
      conditions.push(`(
        p.payment_number ILIKE $${idx}
        OR p.external_ref ILIKE $${idx}
        OR p.notes ILIKE $${idx}
        OR party.name ILIKE $${idx}
        OR party.party_code ILIKE $${idx}
      )`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Allocation status filter via HAVING
    let havingClause = ''
    if (allocation_status === 'allocated') {
      // fully allocated: amount - allocated <= 0.005
      havingClause = 'HAVING (p.amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) <= 0.005'
    } else if (allocation_status === 'unallocated') {
      // zero allocated
      havingClause = 'HAVING COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) <= 0.005'
    } else if (allocation_status === 'partial') {
      // partially allocated
      havingClause = 'HAVING COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) > 0.005 AND (p.amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) > 0.005'
    }

    // Main data query
    const dataSql = `
      SELECT
        p.id,
        p.payment_number,
        p.payment_date,
        p.payment_timestamp,
        p.amount,
        p.method,
        p.external_ref,
        p.notes,
        p.voided_at,
        p.void_reason,
        p.created_at,
        party.id AS party_id,
        party.name AS party_name,
        party.party_code,
        party.address AS party_address,
        u_create.display_name AS recorded_by_name,
        u_void.display_name AS voided_by_name,
        COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS allocated_amount,
        GREATEST(0, p.amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS unallocated_amount,
        COUNT(DISTINCT pa.id) FILTER (WHERE pa.voided_at IS NULL) AS allocation_count
      FROM payments p
      LEFT JOIN parties party ON party.id = p.party_id
      LEFT JOIN users u_create ON u_create.id = p.created_by
      LEFT JOIN users u_void   ON u_void.id   = p.voided_by
      LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
      ${whereClause}
      GROUP BY p.id, party.id, u_create.display_name, u_void.display_name
      ${havingClause}
      ORDER BY p.payment_date DESC, p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `

    const { rows: payments } = await query(dataSql, [...params, limitNum, offset])

    // Count query
    const countSql = `
      SELECT COUNT(*) AS total
      FROM (
        SELECT p.id
        FROM payments p
        LEFT JOIN parties party ON party.id = p.party_id
        LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
        ${whereClause}
        GROUP BY p.id, party.id
        ${havingClause}
      ) sub
    `
    const { rows: [{ total }] } = await query(countSql, params)

    // Summary totals for dashboard KPI cards (active payments only)
    const summarySql = `
      SELECT
        COUNT(DISTINCT p.id) AS total_count,
        COALESCE(SUM(p.amount), 0) AS total_amount,
        COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS total_allocated
      FROM payments p
      LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
      WHERE p.voided_at IS NULL
    `
    const { rows: [summary] } = await query(summarySql)

    const totalAmt = Number(summary.total_amount || 0)
    const totalAlloc = Number(summary.total_allocated || 0)

    return res.json({
      payments,
      total: parseInt(total, 10),
      page:  pageNum,
      limit: limitNum,
      summary: {
        total_count: parseInt(summary.total_count, 10),
        total_amount: totalAmt.toFixed(2),
        total_allocated: totalAlloc.toFixed(2),
        total_unallocated: Math.max(0, totalAmt - totalAlloc).toFixed(2),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/payments/:id
// Detailed receipt with party details, allocation breakdown, and audit trail
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    const paySql = `
      SELECT
        p.id,
        p.payment_number,
        p.payment_date,
        p.payment_timestamp,
        p.amount,
        p.method,
        p.external_ref,
        p.notes,
        p.voided_at,
        p.void_reason,
        p.created_at,
        party.id AS party_id,
        party.name AS party_name,
        party.party_code,
        party.phone AS party_phone,
        party.address AS party_address,
        u_create.display_name AS recorded_by_name,
        u_create.role AS recorded_by_role,
        u_void.display_name AS voided_by_name,
        COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS allocated_amount,
        GREATEST(0, p.amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS unallocated_amount
      FROM payments p
      LEFT JOIN parties party ON party.id = p.party_id
      LEFT JOIN users u_create ON u_create.id = p.created_by
      LEFT JOIN users u_void   ON u_void.id   = p.voided_by
      LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
      WHERE p.id = $1
      GROUP BY p.id, party.id, u_create.display_name, u_create.role, u_void.display_name
    `
    const { rows: [payment] } = await query(paySql, [id])
    if (!payment) {
      return res.status(404).json({ error: 'Not Found', message: 'Payment receipt not found.' })
    }

    // Fetch allocations with invoice numbers
    const allocSql = `
      SELECT
        pa.id AS allocation_id,
        pa.allocated_amount,
        pa.created_at AS allocated_at,
        pa.voided_at,
        pa.void_reason,
        s.id AS sale_id,
        s.sale_number,
        s.sale_date,
        s.total_amount AS invoice_total
      FROM payment_allocations pa
      JOIN sales s ON s.id = pa.sale_id
      WHERE pa.payment_id = $1
      ORDER BY pa.created_at ASC
    `
    const { rows: allocations } = await query(allocSql, [id])

    // Fetch audit events
    const auditSql = `
      SELECT
        al.id,
        al.action_type,
        al.event_timestamp,
        al.change_metadata,
        u.display_name AS actor_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.entity_type = 'payment' AND al.entity_id = $1
      ORDER BY al.event_timestamp DESC
    `
    const { rows: audit } = await query(auditSql, [id])

    return res.json({
      payment,
      allocations,
      audit,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments
// Record a customer payment receipt with atomic allocation.
//
// Body:
//   party_id:            UUID (required)
//   payment_date:        YYYY-MM-DD (optional, defaults to today in IST)
//   amount:              Number > 0 (required)
//   method:              'cash' | 'upi' | 'bank' | 'other' (optional, default 'cash')
//   external_ref:        String (optional)
//   notes:               String (optional)
//   idempotency_key:     String (optional, avoids double submissions)
//   allocation_strategy: 'fifo' | 'specific' | 'unallocated' (default 'fifo')
//   allocations:         [ { sale_id: UUID, allocated_amount: Number } ]
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id/allocations', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'Invalid ID format' })

    const sql = `
      SELECT pa.*, s.sale_number, s.total_amount AS invoice_total
      FROM payment_allocations pa
      JOIN sales s ON s.id = pa.sale_id
      WHERE pa.payment_id = $1
      ORDER BY pa.created_at ASC
    `
    const { rows } = await query(sql, [id])
    return res.json({ allocations: rows })
  } catch (err) {
    next(err)
  }
})

router.post('/', requireAuth, async (req, res, next) => {
  const client = await pool.connect()

  try {
    const {
      party_id,
      payment_date = todayIST(),
      amount,
      method = 'cash',
      external_ref,
      notes,
      idempotency_key,
      allocation_strategy = 'fifo',
      allocations = [],
    } = req.body

    const errors = {}

    // 1. Validate party_id
    if (!party_id || typeof party_id !== 'string' || !UUID_REGEX.test(party_id.trim())) {
      errors.party_id = 'A valid customer selection is required.'
    }

    // 2. Validate amount
    const numAmount = Number(amount)
    if (amount === undefined || amount === null || isNaN(numAmount)) {
      errors.amount = 'Payment amount must be a valid number.'
    } else if (numAmount <= 0) {
      errors.amount = 'Payment amount must be strictly greater than zero.'
    } else if (numAmount > 10_000_000) {
      errors.amount = 'Payment amount cannot exceed ₹1,00,00,000.'
    }

    // 3. Validate method
    const cleanMethod = (method || 'cash').toLowerCase().trim()
    if (!ALLOWED_METHODS.includes(cleanMethod)) {
      errors.method = `Payment method must be one of: ${ALLOWED_METHODS.join(', ')}.`
    }

    // 4. Validate payment_date
    if (!payment_date || !/^\d{4}-\d{2}-\d{2}$/.test(payment_date)) {
      errors.payment_date = 'Payment date must be in YYYY-MM-DD format.'
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation Failed', errors })
    }

    const roundedAmount = roundCurrency(numAmount)
    const cleanPartyId  = party_id.trim()
    const cleanDate     = payment_date.trim()
    const cleanRef      = external_ref ? String(external_ref).trim() : null
    const cleanNotes    = notes ? String(notes).trim() : null
    const cleanKey      = idempotency_key ? String(idempotency_key).trim() : null

    await client.query('BEGIN')

    // 5. Duplicate protection via idempotency_key
    if (cleanKey) {
      const existingPaySql = `
        SELECT
          p.id,
          p.payment_number,
          p.payment_date,
          p.amount,
          p.method,
          p.external_ref,
          p.notes,
          p.created_at,
          COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS allocated_amount
        FROM payments p
        LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
        WHERE p.idempotency_key = $1 AND p.voided_at IS NULL
        GROUP BY p.id
      `
      const { rows: [existing] } = await client.query(existingPaySql, [cleanKey])
      if (existing) {
        await client.query('COMMIT')
        return res.status(200).json({
          message: 'Payment already processed (idempotency key matched).',
          payment: existing,
          is_duplicate: true,
        })
      }
    }

    // 6. Verify Customer exists and is active
    const { rows: [customer] } = await client.query(
      `SELECT id, name, party_code, is_active, credit_enabled FROM parties WHERE id = $1`,
      [cleanPartyId]
    )
    if (!customer) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: 'Validation Failed',
        errors: { party_id: 'Selected customer not found in system.' },
      })
    }
    if (!customer.is_active) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: 'Validation Failed',
        errors: { party_id: 'Cannot record payment for an inactive customer account.' },
      })
    }

    // 7. Insert payment record (Locking order step 1: payments row created first)
    const insertPaySql = `
      INSERT INTO payments (
        party_id,
        payment_date,
        amount,
        method,
        external_ref,
        notes,
        idempotency_key,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, payment_number, payment_date, amount, method, external_ref, notes, created_at
    `
    const { rows: [payment] } = await client.query(insertPaySql, [
      cleanPartyId,
      cleanDate,
      roundedAmount,
      cleanMethod,
      cleanRef,
      cleanNotes,
      cleanKey,
      req.user.id,
    ])

    const createdAllocations = []
    let remainingToAllocate = roundedAmount

    // 8. Allocation Execution
    if (allocation_strategy === 'fifo') {
      // Lock candidate sales rows FOR UPDATE first (Locking order step 2)
      await client.query(
        `SELECT id FROM sales
         WHERE party_id = $1 AND sale_type = 'party_credit' AND status = 'confirmed' AND voided_at IS NULL
         FOR UPDATE`,
        [cleanPartyId]
      )

      const openSalesSql = `
        SELECT
          s.id,
          s.sale_number,
          s.sale_date,
          s.total_amount,
          COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS already_allocated,
          (s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS remaining_due
        FROM sales s
        LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
        WHERE s.party_id = $1
          AND s.sale_type = 'party_credit'
          AND s.status = 'confirmed'
          AND s.voided_at IS NULL
        GROUP BY s.id
        HAVING (s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) > 0.005
        ORDER BY s.sale_date ASC, s.created_at ASC
      `
      const { rows: openSales } = await client.query(openSalesSql, [cleanPartyId])

      for (const sale of openSales) {
        if (remainingToAllocate <= 0.005) break

        const due = roundCurrency(Number(sale.remaining_due))
        const allocAmt = roundCurrency(Math.min(remainingToAllocate, due))

        if (allocAmt > 0) {
          const { rows: [alloc] } = await client.query(
            `INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by)
             VALUES ($1, $2, $3, $4)
             RETURNING id, payment_id, sale_id, allocated_amount, created_at`,
            [payment.id, sale.id, allocAmt, req.user.id]
          )
          createdAllocations.push({
            ...alloc,
            sale_number: sale.sale_number,
          })
          remainingToAllocate = roundCurrency(remainingToAllocate - allocAmt)
        }
      }
    } else if (allocation_strategy === 'specific') {
      if (!Array.isArray(allocations) || allocations.length === 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: 'Validation Failed',
          errors: { allocations: 'Specific allocation requires at least one target invoice.' },
        })
      }

      // Calculate total requested allocation
      let requestedTotal = 0
      for (const item of allocations) {
        const itemAmt = Number(item.allocated_amount)
        if (isNaN(itemAmt) || itemAmt <= 0) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: 'Validation Failed',
            errors: { allocations: 'Each allocation amount must be strictly greater than zero.' },
          })
        }
        requestedTotal = roundCurrency(requestedTotal + itemAmt)
      }

      if (requestedTotal > roundedAmount) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: 'Validation Failed',
          errors: {
            allocations: `Allocated sum (₹${requestedTotal.toFixed(2)}) cannot exceed payment amount (₹${roundedAmount.toFixed(2)}).`,
          },
        })
      }

      for (const item of allocations) {
        if (!UUID_REGEX.test(item.sale_id)) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: 'Validation Failed',
            errors: { allocations: `Invalid sale_id: ${item.sale_id}` },
          })
        }

        // Lock sale row FOR UPDATE first
        await client.query(
          `SELECT id FROM sales WHERE id = $1 FOR UPDATE`,
          [item.sale_id]
        )

        const { rows: [sale] } = await client.query(
          `SELECT
             s.id,
             s.sale_number,
             s.party_id,
             s.sale_type,
             s.status,
             s.voided_at,
             s.total_amount,
             COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS already_allocated,
             (s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS remaining_due
           FROM sales s
           LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
           WHERE s.id = $1
           GROUP BY s.id`,
          [item.sale_id]
        )

        if (!sale) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: 'Validation Failed',
            errors: { allocations: `Invoice ${item.sale_id} not found.` },
          })
        }
        if (sale.party_id !== cleanPartyId) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: 'Validation Failed',
            errors: { allocations: `Invoice ${sale.sale_number} does not belong to this customer.` },
          })
        }
        if (sale.status !== 'confirmed' || sale.voided_at !== null) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: 'Validation Failed',
            errors: { allocations: `Invoice ${sale.sale_number} is voided or not confirmed.` },
          })
        }

        const due = roundCurrency(Number(sale.remaining_due))
        const allocAmt = roundCurrency(Number(item.allocated_amount))

        if (allocAmt > due + 0.005) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: 'Validation Failed',
            errors: {
              allocations: `Cannot allocate ₹${allocAmt.toFixed(2)} to invoice ${sale.sale_number}: remaining due is only ₹${due.toFixed(2)}.`,
            },
          })
        }

        const { rows: [alloc] } = await client.query(
          `INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, payment_id, sale_id, allocated_amount, created_at`,
          [payment.id, sale.id, allocAmt, req.user.id]
        )
        createdAllocations.push({
          ...alloc,
          sale_number: sale.sale_number,
        })
        remainingToAllocate = roundCurrency(remainingToAllocate - allocAmt)
      }
    }

    const totalAllocated = roundCurrency(roundedAmount - remainingToAllocate)
    const unallocatedCredit = roundCurrency(remainingToAllocate)

    // 9. Audit Log
    await client.query(
      `INSERT INTO audit_logs (entity_type, entity_id, action_type, actor_id, change_metadata)
       VALUES ('payment', $1, 'CREATE', $2, $3)`,
      [
        payment.id,
        req.user.id,
        JSON.stringify({
          payment_number: payment.payment_number,
          party_id: cleanPartyId,
          party_name: customer.name,
          amount: roundedAmount,
          method: cleanMethod,
          external_ref: cleanRef,
          total_allocated: totalAllocated,
          unallocated_credit: unallocatedCredit,
          allocation_strategy,
          allocation_count: createdAllocations.length,
        }),
      ]
    )

    await client.query('COMMIT')

    return res.status(201).json({
      message: `Payment ${payment.payment_number} recorded successfully.`,
      payment: {
        ...payment,
        allocated_amount: totalAllocated,
        unallocated_amount: unallocatedCredit,
        allocations: createdAllocations,
      },
    })
  } catch (err) {
    await client.query('ROLLBACK')
    next(err)
  } finally {
    client.release()
  }
})

// ══════════════════════════════════════════════════════════════════════════
// POST /api/payments/:id/void
// Authorized void workflow (Admin Only).
// Voids payment and all its associated payment_allocations atomically.
// ══════════════════════════════════════════════════════════════════════════
router.post('/:id/void', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    const { void_reason } = req.body

    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' })
    }

    if (!void_reason || typeof void_reason !== 'string' || void_reason.trim().length < 3) {
      return res.status(400).json({
        error: 'Validation Failed',
        errors: { void_reason: 'A detailed void reason of at least 3 characters is mandatory.' },
      })
    }

    const cleanReason = void_reason.trim()

    await client.query('BEGIN')

    // 1. Fetch & lock payment
    const { rows: [payment] } = await client.query(
      `SELECT * FROM payments WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (!payment) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not Found', message: 'Payment receipt not found.' })
    }
    if (payment.voided_at !== null) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: 'Conflict',
        message: 'This payment has already been voided.',
      })
    }

    // 2. Void the payment
    const { rows: [voidedPayment] } = await client.query(
      `UPDATE payments
       SET voided_at = NOW(),
           voided_by = $1,
           void_reason = $2
       WHERE id = $3
       RETURNING id, payment_number, voided_at, void_reason`,
      [req.user.id, cleanReason, id]
    )

    // 3. Void all active payment allocations
    const { rows: voidedAllocations } = await client.query(
      `UPDATE payment_allocations
       SET voided_at = NOW(),
           voided_by = $1,
           void_reason = $2
       WHERE payment_id = $3 AND voided_at IS NULL
       RETURNING id, sale_id, allocated_amount`,
      [req.user.id, `Payment voided: ${cleanReason}`, id]
    )

    // 4. Audit Log
    await client.query(
      `INSERT INTO audit_logs (entity_type, entity_id, action_type, actor_id, change_metadata)
       VALUES ('payment', $1, 'VOID', $2, $3)`,
      [
        id,
        req.user.id,
        JSON.stringify({
          payment_number: payment.payment_number,
          amount: payment.amount,
          party_id: payment.party_id,
          void_reason: cleanReason,
          voided_allocations_count: voidedAllocations.length,
          voided_allocations: voidedAllocations,
        }),
      ]
    )

    await client.query('COMMIT')

    return res.json({
      message: `Payment ${payment.payment_number} voided successfully.`,
      payment: voidedPayment,
      voided_allocations: voidedAllocations,
    })
  } catch (err) {
    await client.query('ROLLBACK')
    next(err)
  } finally {
    client.release()
  }
})

export default router
