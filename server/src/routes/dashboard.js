/**
 * server/src/routes/dashboard.js
 *
 * Real Dashboard Endpoint — Phase 11.
 *
 * Core Business Rules:
 *   1. Distinct Financial Metrics: Strictly separate Total Sales, Collections Received,
 *      and Customer Outstanding. Total sales is never treated as cash received.
 *   2. Weighted Aggregate Wastage Formula:
 *        ((SUM(live_weight) - SUM(dressed_weight)) / SUM(live_weight)) * 100
 *      Never simple average. Handles zero loads gracefully without division-by-zero.
 *   3. Manual Remaining Stock Only: Displays latest manually recorded physical stock
 *      observations. Never infers physical stock from dressed weight minus sales.
 *   4. Timezone-Accurate Date Boundaries: Uses Asia/Kolkata (IST) for "today",
 *      with support for explicit date parameter (?date=YYYY-MM-DD).
 *   5. Role Permissions: Enforces authentication on all endpoints. Both Admin
 *      and Staff can access dashboard metrics.
 */

import { Router }      from 'express'
import { query }       from '../db/pool.js'
import { requireAuth } from '../auth/middleware.js'

const router = Router()

/**
 * Returns today's date formatted as YYYY-MM-DD in the shop's local timezone (IST).
 */
export function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

/**
 * GET /api/dashboard
 * Query parameters:
 *   ?date=YYYY-MM-DD (optional, defaults to current date in Asia/Kolkata)
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const targetDate = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : todayIST()

    // ── 1. Today's Chicken Loads & Weighted Aggregate Wastage ───────────────
    // If a load has been corrected, take the latest correction row; otherwise the original.
    const loadsSql = `
      SELECT
        COALESCE(SUM(eff.live_weight_kg), 0)::NUMERIC(10,3)    AS total_live_weight_kg,
        COALESCE(SUM(eff.dressed_weight_kg), 0)::NUMERIC(10,3) AS total_dressed_weight_kg,
        COUNT(eff.id)::INT                                     AS total_loads_count
      FROM (
        SELECT DISTINCT ON (COALESCE(cl.corrects_load_id, cl.id))
          cl.id,
          cl.live_weight_kg,
          cl.dressed_weight_kg,
          cl.load_date
        FROM chicken_loads cl
        WHERE cl.load_date = $1
        ORDER BY COALESCE(cl.corrects_load_id, cl.id), cl.created_at DESC
      ) eff
    `
    const { rows: [loadsRow] } = await query(loadsSql, [targetDate])

    const liveKg    = Number(loadsRow?.total_live_weight_kg || 0)
    const dressedKg = Number(loadsRow?.total_dressed_weight_kg || 0)
    const wastageKg = Math.max(0, liveKg - dressedKg)
    const loadsCount = parseInt(loadsRow?.total_loads_count || 0, 10)

    // Formula: ((SUM(live) - SUM(dressed)) / SUM(live)) * 100
    // Cleanly returns null when liveKg = 0 (no division by zero or NaN)
    const aggregateWastagePct = liveKg > 0
      ? (((liveKg - dressedKg) / liveKg) * 100).toFixed(4)
      : null

    // ── 2. Latest Manually Recorded Remaining Stock Observations ─────────────
    // Manual physical stock only — never inferred from sales or dressed weight.
    const stockSql = `
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
        se.created_at,
        u.display_name AS observed_by_name
      FROM products p
      LEFT JOIN stock_entries se ON se.product_id = p.id
      LEFT JOIN users u ON u.id = se.created_by
      WHERE p.is_active = TRUE
      ORDER BY p.id, se.observed_at DESC, se.created_at DESC
    `
    const { rows: stockRows } = await query(stockSql)

    // Order products by category (whole, cut, offal) then name
    const categoryOrder = { whole: 1, cut: 2, offal: 3 }
    stockRows.sort((a, b) => {
      const catDiff = (categoryOrder[a.product_category] || 99) - (categoryOrder[b.product_category] || 99)
      if (catDiff !== 0) return catDiff
      return a.product_name.localeCompare(b.product_name)
    })

    const productsWithStock = stockRows.filter(r => r.observation_id != null)
    const totalObservedStockKg = productsWithStock.reduce(
      (sum, r) => sum + Number(r.quantity_kg || 0),
      0
    )

    // ── 3. Today's Sales Metrics ─────────────────────────────────────────────
    // Confirmed non-voided sales on target date
    const salesSql = `
      SELECT
        COALESCE(SUM(s.total_amount), 0::NUMERIC(12,2)) AS total_sales,
        COUNT(s.id)::INT                                AS sales_count,
        COALESCE(SUM(
          GREATEST(0, s.total_amount - COALESCE((
            SELECT SUM(pa.allocated_amount)
            FROM payment_allocations pa
            WHERE pa.sale_id = s.id AND pa.voided_at IS NULL
          ), 0))
        ), 0::NUMERIC(12,2)) AS credit_sales,
        COALESCE(SUM(
          LEAST(s.total_amount, COALESCE((
            SELECT SUM(pa.allocated_amount)
            FROM payment_allocations pa
            WHERE pa.sale_id = s.id AND pa.voided_at IS NULL
          ), 0))
        ), 0::NUMERIC(12,2)) AS paid_sales
      FROM sales s
      WHERE s.sale_date = $1
        AND s.status = 'confirmed'
        AND s.voided_at IS NULL
    `
    const { rows: [salesRow] } = await query(salesSql, [targetDate])

    // ── 4. Today's Collections Received ──────────────────────────────────────
    // Actual money received today: includes immediate payments on today's sales
    // and standalone payment receipts recorded today, without double counting.
    const paymentsSql = `
      SELECT
        COALESCE(SUM(p.amount), 0::NUMERIC(12,2)) AS total_collected,
        COUNT(p.id)::INT                          AS payments_count
      FROM payments p
      WHERE p.payment_date = $1
        AND p.voided_at IS NULL
    `
    const { rows: [paymentsRow] } = await query(paymentsSql, [targetDate])

    // ── 5. Total Customer Outstanding ────────────────────────────────────────
    // Sum of net balances across all active customers (opening + credit sales - payments + adjustments)
    const outstandingSql = `
      SELECT
        COUNT(DISTINCT p.id)::INT AS total_customers,
        COUNT(DISTINCT p.id) FILTER (
          WHERE (
            COALESCE((SELECT -aa.ledger_effect FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type = 'opening_balance' AND aa.voided_at IS NULL LIMIT 1), 0)
            + COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.party_id = p.id AND s.sale_type = 'party_credit' AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
            - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = p.id AND pay.voided_at IS NULL), 0)
            + COALESCE((SELECT SUM(-aa.ledger_effect) FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type != 'opening_balance' AND aa.voided_at IS NULL), 0)
          ) > 0.005
        )::INT AS owing_customers_count,
        COALESCE(SUM(
          COALESCE((SELECT -aa.ledger_effect FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type = 'opening_balance' AND aa.voided_at IS NULL LIMIT 1), 0)
          + COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.party_id = p.id AND s.sale_type = 'party_credit' AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
          - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = p.id AND pay.voided_at IS NULL), 0)
          + COALESCE((SELECT SUM(-aa.ledger_effect) FROM account_adjustments aa WHERE aa.party_id = p.id AND aa.adjustment_type != 'opening_balance' AND aa.voided_at IS NULL), 0)
        ), 0::NUMERIC(12,2)) AS total_outstanding_amount
      FROM parties p
      WHERE p.is_active = TRUE
    `
    const { rows: [outstandingRow] } = await query(outstandingSql)

    // ── 6. Recent Activity Lists ─────────────────────────────────────────────
    // A. Recent Chicken Loads (last 5)
    const recentLoadsSql = `
      SELECT
        cl.id,
        cl.load_number,
        TO_CHAR(cl.load_date, 'YYYY-MM-DD') AS load_date,
        cl.supplier_ref,
        cl.live_weight_kg,
        cl.dressed_weight_kg,
        cl.wastage_pct,
        cl.remaining_stock_kg,
        cl.created_at,
        u.display_name AS created_by_name
      FROM chicken_loads cl
      JOIN users u ON u.id = cl.created_by
      WHERE cl.is_correction = FALSE
      ORDER BY cl.load_date DESC, cl.created_at DESC
      LIMIT 5
    `
    const { rows: recentLoads } = await query(recentLoadsSql)

    // B. Recent Sales (last 5)
    const recentSalesSql = `
      SELECT
        s.id,
        s.sale_number,
        s.status,
        TO_CHAR(s.sale_date, 'YYYY-MM-DD') AS sale_date,
        s.sale_timestamp,
        s.sale_type,
        s.total_amount,
        p.name AS party_name,
        p.party_code,
        COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0) AS paid_amount,
        GREATEST(0, s.total_amount - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.voided_at IS NULL), 0)) AS due_amount,
        u.display_name AS created_by_name
      FROM sales s
      LEFT JOIN parties p ON p.id = s.party_id
      LEFT JOIN users u ON u.id = s.created_by
      LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
      WHERE s.voided_at IS NULL
      GROUP BY s.id, p.name, p.party_code, u.display_name
      ORDER BY s.sale_timestamp DESC, s.created_at DESC
      LIMIT 5
    `
    const { rows: recentSales } = await query(recentSalesSql)

    // C. Recent Payments (last 5)
    const recentPaymentsSql = `
      SELECT
        p.id,
        p.payment_number,
        TO_CHAR(p.payment_date, 'YYYY-MM-DD') AS payment_date,
        p.payment_timestamp,
        p.amount,
        p.method,
        p.external_ref,
        party.name AS party_name,
        party.party_code,
        u.display_name AS recorded_by_name
      FROM payments p
      LEFT JOIN parties party ON party.id = p.party_id
      LEFT JOIN users u ON u.id = p.created_by
      WHERE p.voided_at IS NULL
      ORDER BY p.payment_date DESC, p.payment_timestamp DESC, p.created_at DESC
      LIMIT 5
    `
    const { rows: recentPayments } = await query(recentPaymentsSql)

    // ── Construct and return response ────────────────────────────────────────
    return res.json({
      date: targetDate,
      user: {
        id: req.user.id,
        name: req.user.display_name || req.user.email,
        email: req.user.email,
        role: req.user.role,
      },
      loads: {
        today_live_weight_kg:        liveKg.toFixed(3),
        today_dressed_weight_kg:     dressedKg.toFixed(3),
        today_wastage_kg:            wastageKg.toFixed(3),
        today_aggregate_wastage_pct: aggregateWastagePct,
        today_loads_count:           loadsCount,
      },
      stock: {
        latest_observations: stockRows.map(r => ({
          product_id:          r.product_id,
          product_name:        r.product_name,
          product_category:    r.product_category,
          seed_key:            r.seed_key,
          is_active:           r.is_active,
          observation_id:      r.observation_id,
          observed_at:         r.observed_at,
          quantity_kg:         r.quantity_kg != null ? Number(r.quantity_kg).toFixed(3) : null,
          notes:               r.notes,
          observed_by_name:    r.observed_by_name,
        })),
        total_observed_kg:       totalObservedStockKg.toFixed(3),
        observed_products_count: productsWithStock.length,
        total_products_count:    stockRows.length,
      },
      finances: {
        today_total_sales:          Number(salesRow?.total_sales || 0).toFixed(2),
        today_collections_received: Number(paymentsRow?.total_collected || 0).toFixed(2),
        today_credit_sales:         Number(salesRow?.credit_sales || 0).toFixed(2),
        today_paid_sales:           Number(salesRow?.paid_sales || 0).toFixed(2),
        today_sales_count:          parseInt(salesRow?.sales_count || 0, 10),
        today_payments_count:       parseInt(paymentsRow?.payments_count || 0, 10),
      },
      outstanding: {
        total_outstanding_amount: Number(outstandingRow?.total_outstanding_amount || 0).toFixed(2),
        owing_customers_count:    parseInt(outstandingRow?.owing_customers_count || 0, 10),
        total_customers:          parseInt(outstandingRow?.total_customers || 0, 10),
      },
      recent_activity: {
        loads:    recentLoads,
        sales:    recentSales,
        payments: recentPayments,
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
