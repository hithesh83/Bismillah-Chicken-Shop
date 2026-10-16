/**
 * server/src/routes/outstanding.js
 *
 * Phase 10 — Outstanding Balances & Customer Ledger Statements
 *
 * Key Responsibilities:
 *   • GET /api/outstanding                    — customer balances list with metrics
 *   • GET /api/outstanding/:party_id/invoices — open unpaid invoices for customer
 *   • GET /api/ledger/:party_id               — chronological statement with running balance
 *   • GET /api/customers/:id/statement        — alias for customer statement
 *
 * Accounting Rules:
 *   • Outstanding Formula:
 *       Outstanding = Opening Balance + Total Credit Charges - Total Payments - Valid Credits / Adjustments
 *   • Running Balance Reconciliation:
 *       Current Running Balance = Previous Running Balance + Line Debit - Line Credit
 *   • Zero Double-Counting:
 *       Immediate payments from Phase 09 sale creation are recorded as separate payments
 *       and credited once against the invoice total.
 */

import express from 'express'
import { query } from '../db/pool.js'
import { requireAuth } from '../auth/middleware.js'

const router = express.Router()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function roundCurrency(val) {
  return Math.round((Number(val) + Number.EPSILON) * 100) / 100
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/outstanding
// List customer outstanding balances with search, filters, and top-level KPIs
//   ?search=...
//   ?has_balance=true|false
//   ?party_type=hotel|party|retail
//   ?sort=balance_desc|balance_asc|name_asc
//   ?page=1&limit=50
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const {
      search,
      has_balance = 'true',
      party_type,
      sort = 'balance_desc',
      page = 1,
      limit = 50,
    } = req.query

    const pageNum  = Math.max(1, parseInt(page, 10)  || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50))
    const offset   = (pageNum - 1) * limitNum

    const conditions = ['p.is_active = TRUE']
    const params = []

    if (party_type) {
      params.push(party_type.toLowerCase().trim())
      conditions.push(`p.party_type = $${params.length}`)
    }

    if (search && search.trim()) {
      params.push(`%${search.trim()}%`)
      const idx = params.length
      conditions.push(`(p.name ILIKE $${idx} OR p.party_code ILIKE $${idx} OR p.phone ILIKE $${idx})`)
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`

    // Subquery computing authoritative balances for each party
    const balanceSubquery = `
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
        -- Opening balance (debt = -ledger_effect)
        COALESCE((
          SELECT -aa.ledger_effect
          FROM account_adjustments aa
          WHERE aa.party_id = p.id
            AND aa.adjustment_type = 'opening_balance'
            AND aa.voided_at IS NULL
          LIMIT 1
        ), 0::NUMERIC(12,2)) AS opening_balance,
        -- Total credit sales
        COALESCE((
          SELECT SUM(s.total_amount)
          FROM sales s
          WHERE s.party_id = p.id
            AND s.sale_type = 'party_credit'
            AND s.status = 'confirmed'
            AND s.voided_at IS NULL
        ), 0::NUMERIC(12,2)) AS total_credit_sales,
        -- Total payments received
        COALESCE((
          SELECT SUM(pay.amount)
          FROM payments pay
          WHERE pay.party_id = p.id
            AND pay.voided_at IS NULL
        ), 0::NUMERIC(12,2)) AS total_payments,
        -- Other adjustments (debt increase = -ledger_effect)
        COALESCE((
          SELECT SUM(-aa.ledger_effect)
          FROM account_adjustments aa
          WHERE aa.party_id = p.id
            AND aa.adjustment_type != 'opening_balance'
            AND aa.voided_at IS NULL
        ), 0::NUMERIC(12,2)) AS total_adjustments,
        -- Count of open unpaid credit invoices
        COALESCE((
          SELECT COUNT(DISTINCT s.id)
          FROM sales s
          LEFT JOIN payment_allocations pa ON pa.sale_id = s.id AND pa.voided_at IS NULL
          WHERE s.party_id = p.id
            AND s.sale_type = 'party_credit'
            AND s.status = 'confirmed'
            AND s.voided_at IS NULL
          GROUP BY s.id
          HAVING (s.total_amount - COALESCE(SUM(pa.allocated_amount), 0)) > 0.005
        ), 0) AS open_invoice_count,
        -- Most recent credit sale date
        (
          SELECT MAX(s.sale_date)
          FROM sales s
          WHERE s.party_id = p.id
            AND s.sale_type = 'party_credit'
            AND s.status = 'confirmed'
            AND s.voided_at IS NULL
        ) AS last_sale_date,
        -- Most recent payment date
        (
          SELECT MAX(pay.payment_date)
          FROM payments pay
          WHERE pay.party_id = p.id
            AND pay.voided_at IS NULL
        ) AS last_payment_date
      FROM parties p
      ${whereClause}
    `

    // Balance filter clause
    let balanceFilter = ''
    if (has_balance === 'true') {
      balanceFilter = 'WHERE (b.opening_balance + b.total_credit_sales - b.total_payments + b.total_adjustments) > 0.005'
    } else if (has_balance === 'false') {
      balanceFilter = 'WHERE (b.opening_balance + b.total_credit_sales - b.total_payments + b.total_adjustments) <= 0.005'
    }

    // Sort order
    let orderBy = 'ORDER BY current_balance DESC'
    if (sort === 'balance_asc') {
      orderBy = 'ORDER BY current_balance ASC'
    } else if (sort === 'name_asc') {
      orderBy = 'ORDER BY b.name ASC'
    }

    const dataSql = `
      SELECT
        b.*,
        ROUND((b.opening_balance + b.total_credit_sales - b.total_payments + b.total_adjustments), 2) AS current_balance
      FROM (${balanceSubquery}) b
      ${balanceFilter}
      ${orderBy}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `
    const { rows: customers } = await query(dataSql, [...params, limitNum, offset])

    // Count matching
    const countSql = `
      SELECT COUNT(*) AS total
      FROM (${balanceSubquery}) b
      ${balanceFilter}
    `
    const { rows: [{ total }] } = await query(countSql, params)

    // Global summary across all active customers
    const summarySql = `
      SELECT
        COUNT(DISTINCT p.id) AS total_customers,
        COUNT(DISTINCT p.id) FILTER (
          WHERE (
            COALESCE((SELECT -aa.ledger_effect FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type = 'opening_balance' AND aa.voided_at IS NULL LIMIT 1), 0)
            + COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.party_id = p.id AND s.sale_type = 'party_credit' AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
            - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = p.id AND pay.voided_at IS NULL), 0)
            + COALESCE((SELECT SUM(-aa.ledger_effect) FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type != 'opening_balance' AND aa.voided_at IS NULL), 0)
          ) > 0.005
        ) AS owing_customers_count,
        COALESCE(SUM(
          COALESCE((SELECT -aa.ledger_effect FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type = 'opening_balance' AND aa.voided_at IS NULL LIMIT 1), 0)
          + COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.party_id = p.id AND s.sale_type = 'party_credit' AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
          - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = p.id AND pay.voided_at IS NULL), 0)
          + COALESCE((SELECT SUM(-aa.ledger_effect) FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type != 'opening_balance' AND aa.voided_at IS NULL), 0)
        ), 0) AS total_outstanding_amount
      FROM parties p
      WHERE p.is_active = TRUE
    `
    const { rows: [summary] } = await query(summarySql)

    return res.json({
      customers,
      total: parseInt(total, 10),
      page:  pageNum,
      limit: limitNum,
      summary: {
        total_customers: parseInt(summary.total_customers, 10),
        owing_customers_count: parseInt(summary.owing_customers_count, 10),
        total_outstanding_amount: Number(summary.total_outstanding_amount || 0).toFixed(2),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/outstanding/:party_id/invoices
// Returns open unpaid credit invoices for a specific customer (oldest first)
// ══════════════════════════════════════════════════════════════════════════
router.get('/:party_id/invoices', requireAuth, async (req, res, next) => {
  try {
    const { party_id } = req.params
    if (!UUID_REGEX.test(party_id)) {
      return res.status(400).json({ error: 'Invalid customer ID format' })
    }

    const sql = `
      SELECT
        s.id,
        s.sale_number,
        s.sale_date,
        s.sale_timestamp,
        s.total_amount,
        COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS paid_amount,
        GREATEST(0, s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS due_amount
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
    const { rows: invoices } = await query(sql, [party_id])

    return res.json({ invoices })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/ledger/:party_id & GET /api/customers/:id/statement
// Complete customer ledger / statement with running balances.
//
// Reconciles:
//   1. Opening Balance
//   2. Confirmed Credit Sales (Debit)
//   3. Payments Received (Credit)
//   4. Adjustments / Credit Notes
//
// Calculates:
//   Every row has: debit, credit, running_balance
//   Closing balance mathematically equals final running balance.
// ══════════════════════════════════════════════════════════════════════════
export async function getCustomerStatement(req, res, next) {
  try {
    const partyId = req.params.party_id || req.params.id
    if (!UUID_REGEX.test(partyId)) {
      return res.status(400).json({ error: 'Invalid customer ID format' })
    }

    const { from, to } = req.query

    // 1. Fetch customer details
    const partySql = `
      SELECT id, party_code, name, phone, address, party_type, credit_enabled, is_active
      FROM parties
      WHERE id = $1
    `
    const { rows: [customer] } = await query(partySql, [partyId])
    if (!customer) {
      return res.status(404).json({ error: 'Not Found', message: 'Customer not found.' })
    }

    // 2. Fetch all financial records for this customer
    // A. Opening balance adjustment
    const opBalSql = `
      SELECT
        aa.id,
        aa.effective_date AS date,
        aa.created_at AS timestamp,
        'opening_balance' AS entry_type,
        'Opening Balance' AS reference,
        aa.reason AS description,
        CASE WHEN aa.ledger_effect < 0 THEN -aa.ledger_effect ELSE 0 END AS debit,
        CASE WHEN aa.ledger_effect > 0 THEN aa.ledger_effect ELSE 0 END AS credit
      FROM account_adjustments aa
      WHERE aa.party_id = $1
        AND aa.adjustment_type = 'opening_balance'
        AND aa.voided_at IS NULL
    `
    const { rows: opBalRows } = await query(opBalSql, [partyId])

    // B. Confirmed credit sales (Debit to customer)
    const salesSql = `
      SELECT
        s.id,
        s.sale_date AS date,
        s.sale_timestamp AS timestamp,
        'sale' AS entry_type,
        s.sale_number AS reference,
        COALESCE(s.notes, 'Credit Sale') AS description,
        s.total_amount AS debit,
        0.00 AS credit
      FROM sales s
      WHERE s.party_id = $1
        AND s.sale_type = 'party_credit'
        AND s.status = 'confirmed'
        AND s.voided_at IS NULL
    `
    const { rows: saleRows } = await query(salesSql, [partyId])

    // C. Non-voided payments (Credit to customer)
    const paymentsSql = `
      SELECT
        p.id,
        p.payment_date AS date,
        p.payment_timestamp AS timestamp,
        'payment' AS entry_type,
        p.payment_number AS reference,
        CONCAT(
          'Payment received via ', UPPER(p.method),
          CASE WHEN p.external_ref IS NOT NULL AND p.external_ref != '' THEN CONCAT(' (Ref: ', p.external_ref, ')') ELSE '' END,
          CASE WHEN p.notes IS NOT NULL AND p.notes != '' THEN CONCAT(' — ', p.notes) ELSE '' END
        ) AS description,
        0.00 AS debit,
        p.amount AS credit
      FROM payments p
      WHERE p.party_id = $1
        AND p.voided_at IS NULL
    `
    const { rows: payRows } = await query(paymentsSql, [partyId])

    // D. Other account adjustments (credit notes, corrections, write-offs)
    const adjSql = `
      SELECT
        aa.id,
        aa.effective_date AS date,
        aa.created_at AS timestamp,
        'adjustment' AS entry_type,
        CONCAT(UPPER(aa.adjustment_type), CASE WHEN aa.reason IS NOT NULL THEN CONCAT(': ', aa.reason) ELSE '' END) AS reference,
        aa.reason AS description,
        CASE WHEN aa.ledger_effect < 0 THEN -aa.ledger_effect ELSE 0 END AS debit,
        CASE WHEN aa.ledger_effect > 0 THEN aa.ledger_effect ELSE 0 END AS credit
      FROM account_adjustments aa
      WHERE aa.party_id = $1
        AND aa.adjustment_type != 'opening_balance'
        AND aa.voided_at IS NULL
    `
    const { rows: adjRows } = await query(adjSql, [partyId])

    // 3. Combine all transactions and sort chronologically
    const allEvents = [...opBalRows, ...saleRows, ...payRows, ...adjRows]

    allEvents.sort((a, b) => {
      // 1. By date string YYYY-MM-DD
      const dateA = typeof a.date === 'string' ? a.date : new Date(a.date).toISOString().slice(0, 10)
      const dateB = typeof b.date === 'string' ? b.date : new Date(b.date).toISOString().slice(0, 10)
      if (dateA !== dateB) return dateA.localeCompare(dateB)

      // 2. Put opening balance first on same date
      if (a.entry_type === 'opening_balance' && b.entry_type !== 'opening_balance') return -1
      if (b.entry_type === 'opening_balance' && a.entry_type !== 'opening_balance') return 1

      // 3. By timestamp
      const timeA = new Date(a.timestamp).getTime()
      const timeB = new Date(b.timestamp).getTime()
      if (timeA !== timeB) return timeA - timeB

      // 4. Stable tie breaker by ID
      return String(a.id).localeCompare(String(b.id))
    })

    // 4. Calculate chronological running balances across all history
    let runningBalance = 0
    let totalAllDebits = 0
    let totalAllCredits = 0

    const statementLines = []
    let periodOpeningBalance = 0

    const fromDate = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null
    const toDate   = to   && /^\d{4}-\d{2}-\d{2}$/.test(to)   ? to   : null

    for (const ev of allEvents) {
      const lineDate = typeof ev.date === 'string' ? ev.date : new Date(ev.date).toISOString().slice(0, 10)
      const debit  = roundCurrency(Number(ev.debit  || 0))
      const credit = roundCurrency(Number(ev.credit || 0))

      // Update global running balance
      runningBalance = roundCurrency(runningBalance + debit - credit)
      totalAllDebits  = roundCurrency(totalAllDebits + debit)
      totalAllCredits = roundCurrency(totalAllCredits + credit)

      // If filtering by from date and this event is before fromDate, accumulate into periodOpeningBalance
      if (fromDate && lineDate < fromDate) {
        periodOpeningBalance = runningBalance
        continue
      }

      // If filtering by to date and this event is after toDate, skip from output
      if (toDate && lineDate > toDate) {
        continue
      }

      statementLines.push({
        id: ev.id,
        date: lineDate,
        timestamp: ev.timestamp,
        entry_type: ev.entry_type,
        reference: ev.reference,
        description: ev.description,
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
        running_balance: runningBalance.toFixed(2),
      })
    }

    // Totals for the returned view
    let periodDebits = 0
    let periodCredits = 0
    for (const line of statementLines) {
      periodDebits  = roundCurrency(periodDebits + Number(line.debit))
      periodCredits = roundCurrency(periodCredits + Number(line.credit))
    }

    const closingBalance = fromDate
      ? roundCurrency(periodOpeningBalance + periodDebits - periodCredits)
      : runningBalance

    return res.json({
      customer,
      period: {
        from: fromDate,
        to: toDate,
        opening_balance: periodOpeningBalance.toFixed(2),
        total_debits: periodDebits.toFixed(2),
        total_credits: periodCredits.toFixed(2),
        closing_balance: closingBalance.toFixed(2),
      },
      summary: {
        all_time_debits: totalAllDebits.toFixed(2),
        all_time_credits: totalAllCredits.toFixed(2),
        current_outstanding: runningBalance.toFixed(2),
      },
      statement: statementLines,
    })
  } catch (err) {
    next(err)
  }
}

router.get('/:party_id', requireAuth, getCustomerStatement)
router.get('/:party_id/statement', requireAuth, getCustomerStatement)

export default router
