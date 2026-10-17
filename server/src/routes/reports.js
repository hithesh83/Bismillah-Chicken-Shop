/**
 * server/src/routes/reports.js
 *
 * Reports and Exports API — Phase 12.
 *
 * Core Capabilities:
 *   1. Periods: Daily, Weekly, Monthly, and Custom Date Ranges with accurate
 *      Asia/Kolkata date and timezone boundaries.
 *   2. Chicken Processing: Live vs dressed weights, weighted aggregate wastage %,
 *      and individual load breakdowns.
 *   3. Manual Physical Stock: Recorded stock observations within period.
 *   4. Sales & Product Performance: Product-wise volume and revenue using
 *      actual historical charged rates from sale_items.
 *   5. Sales by Customer Category: Walk-In, Hotels/Parties, Regular Credit.
 *   6. Collections Received: Total money received grouped by payment method
 *      (Cash, UPI, Bank, Other) without double-counting.
 *   7. Point-in-Time Period-End Outstanding: Balances calculated strictly as of
 *      period end, ignoring subsequent transactions.
 *   8. Daily Trends: Day-by-day sales and collections trajectory.
 *   9. CSV Exports: Full tabular export matching UI totals 100%.
 *  10. RBAC: Enforces Admin/Manager authorization; rejects unauthorized roles (Staff).
 */

import { Router }                    from 'express'
import { query }                     from '../db/pool.js'
import { requireAuth, requireRole }   from '../auth/middleware.js'

const router = Router()

/**
 * Returns today's date in YYYY-MM-DD in Asia/Kolkata timezone.
 */
export function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

/**
 * Resolves period start and end dates in YYYY-MM-DD from request parameters.
 */
export function resolveDateRange({ period = 'daily', date, from, to, month }) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  const monthRegex = /^\d{4}-\d{2}$/

  // 1. Explicit Custom Range
  if (period === 'custom' || (from && to)) {
    const s = dateRegex.test(from) ? from : todayIST()
    const e = dateRegex.test(to) ? to : s
    const [startDate, endDate] = s <= e ? [s, e] : [e, s]
    return {
      period: 'custom',
      startDate,
      endDate,
      label: `Custom: ${startDate} to ${endDate}`,
    }
  }

  // 2. Monthly Period
  if (period === 'monthly') {
    let targetMonth = monthRegex.test(month) ? month : null
    if (!targetMonth) {
      const baseDate = dateRegex.test(date) ? date : todayIST()
      targetMonth = baseDate.slice(0, 7) // 'YYYY-MM'
    }
    const [yearStr, monthStr] = targetMonth.split('-')
    const year = parseInt(yearStr, 10)
    const m = parseInt(monthStr, 10)

    const startDate = `${targetMonth}-01`
    const lastDay = new Date(year, m, 0).getDate()
    const endDate = `${targetMonth}-${String(lastDay).padStart(2, '0')}`

    return {
      period: 'monthly',
      startDate,
      endDate,
      label: `Monthly: ${targetMonth}`,
    }
  }

  // 3. Weekly Period (Monday to Sunday)
  if (period === 'weekly') {
    const baseDateStr = dateRegex.test(date) ? date : todayIST()
    const [y, m, d] = baseDateStr.split('-').map(Number)
    const base = new Date(Date.UTC(y, m - 1, d))

    // ISO day: 1 = Mon, ..., 7 = Sun
    const dayOfWeek = base.getUTCDay() || 7
    const monday = new Date(base)
    monday.setUTCDate(base.getUTCDate() - dayOfWeek + 1)

    const sunday = new Date(monday)
    sunday.setUTCDate(monday.getUTCDate() + 6)

    const startDate = monday.toISOString().slice(0, 10)
    const endDate   = sunday.toISOString().slice(0, 10)

    return {
      period: 'weekly',
      startDate,
      endDate,
      label: `Weekly: ${startDate} to ${endDate}`,
    }
  }

  // 4. Daily Period (Default)
  const targetDate = dateRegex.test(date) ? date : todayIST()
  return {
    period: 'daily',
    startDate: targetDate,
    endDate:   targetDate,
    label:     `Daily: ${targetDate}`,
  }
}

/**
 * Core query function that fetches comprehensive report data for a given date range.
 */
export async function getReportData({ startDate, endDate }) {
  // ── 1. Chicken Loads & Weighted Aggregate Wastage ─────────────────────────
  // Subquery picks latest correction for each load if corrected; otherwise the original.
  const loadsSummarySql = `
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
      WHERE cl.load_date >= $1 AND cl.load_date <= $2
      ORDER BY COALESCE(cl.corrects_load_id, cl.id), cl.created_at DESC
    ) eff
  `
  const { rows: [loadsSum] } = await query(loadsSummarySql, [startDate, endDate])

  const liveKg    = Number(loadsSum?.total_live_weight_kg || 0)
  const dressedKg = Number(loadsSum?.total_dressed_weight_kg || 0)
  const wastageKg = Math.max(0, liveKg - dressedKg)
  const loadsCount = parseInt(loadsSum?.total_loads_count || 0, 10)

  // Weighted formula: ((SUM(live) - SUM(dressed)) / SUM(live)) * 100
  // Cleanly returns null when liveKg = 0 (prevents NaN or division by zero)
  const aggregateWastagePct = liveKg > 0
    ? (((liveKg - dressedKg) / liveKg) * 100).toFixed(4)
    : null

  // Individual loads breakdown in period
  const individualLoadsSql = `
    SELECT
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
      u.display_name AS created_by_name
    FROM chicken_loads cl
    JOIN users u ON u.id = cl.created_by
    WHERE cl.load_date >= $1 AND cl.load_date <= $2
      AND cl.is_correction = FALSE
    ORDER BY cl.load_date ASC, cl.created_at ASC
  `
  const { rows: loadsList } = await query(individualLoadsSql, [startDate, endDate])

  // ── 2. Manual Physical Stock Observations in Period ───────────────────────
  const stockSql = `
    SELECT
      se.id,
      p.id AS product_id,
      p.name AS product_name,
      p.category AS product_category,
      se.quantity_kg,
      se.observed_at,
      se.notes,
      se.is_correction,
      u.display_name AS created_by_name
    FROM stock_entries se
    JOIN products p ON p.id = se.product_id
    JOIN users u ON u.id = se.created_by
    WHERE (se.observed_at AT TIME ZONE 'Asia/Kolkata')::DATE >= $1
      AND (se.observed_at AT TIME ZONE 'Asia/Kolkata')::DATE <= $2
    ORDER BY se.observed_at DESC
  `
  const { rows: stockObservations } = await query(stockSql, [startDate, endDate])

  const totalObservedKg = stockObservations.reduce((acc, r) => acc + Number(r.quantity_kg || 0), 0)
  const uniqueProductsInStock = new Set(stockObservations.map(r => r.product_id)).size

  // ── 3. Sales Summaries ────────────────────────────────────────────────────
  const salesSummarySql = `
    SELECT
      COALESCE(SUM(s.total_amount), 0::NUMERIC(12,2)) AS total_sales,
      COUNT(s.id)::INT                                AS sales_count,
      COALESCE(SUM(
        GREATEST(0, s.total_amount - COALESCE((
          SELECT SUM(pa.allocated_amount)
          FROM payment_allocations pa
          JOIN payments pay ON pay.id = pa.payment_id
          WHERE pa.sale_id = s.id
            AND pa.voided_at IS NULL
            AND (pay.payment_timestamp = s.sale_timestamp OR pay.notes LIKE 'Initial payment for sale %')
        ), 0))
      ), 0::NUMERIC(12,2)) AS credit_sales,
      COALESCE(SUM(
        LEAST(s.total_amount, COALESCE((
          SELECT SUM(pa.allocated_amount)
          FROM payment_allocations pa
          JOIN payments pay ON pay.id = pa.payment_id
          WHERE pa.sale_id = s.id
            AND pa.voided_at IS NULL
            AND (pay.payment_timestamp = s.sale_timestamp OR pay.notes LIKE 'Initial payment for sale %')
        ), 0))
      ), 0::NUMERIC(12,2)) AS paid_sales
    FROM sales s
    WHERE s.sale_date >= $1 AND s.sale_date <= $2
      AND s.status = 'confirmed'
      AND s.voided_at IS NULL
  `
  const { rows: [salesSum] } = await query(salesSummarySql, [startDate, endDate])

  // ── 4. Sales by Product (Historical charged rates from sale_items) ─────────
  const productSalesSql = `
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.category AS product_category,
      COALESCE(SUM(si.quantity_kg), 0::NUMERIC(10,3)) AS total_quantity_kg,
      COALESCE(SUM(si.line_total), 0::NUMERIC(12,2))   AS total_revenue,
      CASE
        WHEN COALESCE(SUM(si.quantity_kg), 0) > 0
        THEN ROUND(SUM(si.line_total) / SUM(si.quantity_kg), 2)
        ELSE 0.00
      END AS average_rate_per_kg
    FROM products p
    JOIN sale_items si ON si.product_id = p.id
    JOIN sales s ON s.id = si.sale_id
    WHERE s.sale_date >= $1 AND s.sale_date <= $2
      AND s.status = 'confirmed'
      AND s.voided_at IS NULL
    GROUP BY p.id, p.name, p.category
    ORDER BY total_revenue DESC, total_quantity_kg DESC
  `
  const { rows: productSales } = await query(productSalesSql, [startDate, endDate])

  // ── 5. Sales by Customer Category ─────────────────────────────────────────
  const categorySalesSql = `
    SELECT
      CASE
        WHEN s.sale_type = 'walkin' THEN 'walkin'
        WHEN p.party_type IN ('hotel', 'party') THEN 'hotel_party'
        ELSE 'retail'
      END AS category_key,
      CASE
        WHEN s.sale_type = 'walkin' THEN 'Walk-In Customers'
        WHEN p.party_type IN ('hotel', 'party') THEN 'Hotels & Caterers'
        ELSE 'Regular Credit Customers'
      END AS category_label,
      COUNT(s.id)::INT                               AS sales_count,
      COALESCE(SUM(s.total_amount), 0::NUMERIC(12,2)) AS total_amount
    FROM sales s
    LEFT JOIN parties p ON p.id = s.party_id
    WHERE s.sale_date >= $1 AND s.sale_date <= $2
      AND s.status = 'confirmed'
      AND s.voided_at IS NULL
    GROUP BY category_key, category_label
    ORDER BY total_amount DESC
  `
  const { rows: categorySales } = await query(categorySalesSql, [startDate, endDate])

  const totalPeriodSales = Number(salesSum?.total_sales || 0)
  const categoryBreakdown = categorySales.map(c => ({
    category_key:   c.category_key,
    category_label: c.category_label,
    sales_count:    parseInt(c.sales_count, 10),
    total_amount:   Number(c.total_amount).toFixed(2),
    percentage:     totalPeriodSales > 0
      ? ((Number(c.total_amount) / totalPeriodSales) * 100).toFixed(2)
      : '0.00',
  }))

  // ── 6. Collections / Payments Received in Period ──────────────────────────
  // Actual money received during period, grouped by method
  const collectionsSummarySql = `
    SELECT
      p.method,
      COALESCE(SUM(p.amount), 0::NUMERIC(12,2)) AS total_amount,
      COUNT(p.id)::INT                          AS payments_count
    FROM payments p
    WHERE p.payment_date >= $1 AND p.payment_date <= $2
      AND p.voided_at IS NULL
    GROUP BY p.method
    ORDER BY total_amount DESC
  `
  const { rows: collectionsByMethod } = await query(collectionsSummarySql, [startDate, endDate])

  const totalCollectedInPeriod = collectionsByMethod.reduce(
    (acc, m) => acc + Number(m.total_amount || 0),
    0
  )
  const totalPaymentsCount = collectionsByMethod.reduce(
    (acc, m) => acc + parseInt(m.payments_count || 0, 10),
    0
  )

  // Recent payments list in period
  const paymentsListSql = `
    SELECT
      p.id,
      p.payment_number,
      TO_CHAR(p.payment_date, 'YYYY-MM-DD') AS payment_date,
      p.payment_timestamp,
      p.amount,
      p.method,
      p.external_ref,
      p.notes,
      party.name AS party_name,
      party.party_code,
      u.display_name AS recorded_by_name
    FROM payments p
    LEFT JOIN parties party ON party.id = p.party_id
    LEFT JOIN users u ON u.id = p.created_by
    WHERE p.payment_date >= $1 AND p.payment_date <= $2
      AND p.voided_at IS NULL
    ORDER BY p.payment_date DESC, p.created_at DESC
  `
  const { rows: paymentsList } = await query(paymentsListSql, [startDate, endDate])

  // ── 7. Point-in-Time Period-End Outstanding Balances ──────────────────────
  // Balances evaluated strictly as of endDate (ignores subsequent transactions)
  const periodEndOutstandingSql = `
    SELECT
      p.id AS party_id,
      p.party_code,
      p.name AS customer_name,
      p.party_type,
      p.phone,
      -- Opening balance effective on or before period end
      COALESCE((
        SELECT -aa.ledger_effect
        FROM account_adjustments aa
        WHERE aa.party_id = p.id
          AND aa.adjustment_type = 'opening_balance'
          AND aa.effective_date <= $1
          AND aa.voided_at IS NULL
        LIMIT 1
      ), 0::NUMERIC(12,2)) AS opening_balance,
      -- Credit sales on or before period end
      COALESCE((
        SELECT SUM(s.total_amount)
        FROM sales s
        WHERE s.party_id = p.id
          AND s.sale_type = 'party_credit'
          AND s.status = 'confirmed'
          AND s.sale_date <= $1
          AND s.voided_at IS NULL
      ), 0::NUMERIC(12,2)) AS credit_sales_through_end,
      -- Payments received on or before period end
      COALESCE((
        SELECT SUM(pay.amount)
        FROM payments pay
        WHERE pay.party_id = p.id
          AND pay.payment_date <= $1
          AND pay.voided_at IS NULL
      ), 0::NUMERIC(12,2)) AS payments_through_end,
      -- Other adjustments effective on or before period end
      COALESCE((
        SELECT SUM(-aa.ledger_effect)
        FROM account_adjustments aa
        WHERE aa.party_id = p.id
          AND aa.adjustment_type != 'opening_balance'
          AND aa.effective_date <= $1
          AND aa.voided_at IS NULL
      ), 0::NUMERIC(12,2)) AS adjustments_through_end
    FROM parties p
    WHERE p.is_active = TRUE
    ORDER BY p.name ASC
  `
  const { rows: custBalances } = await query(periodEndOutstandingSql, [endDate])

  let totalPeriodEndOutstanding = 0
  let owingCustomersCount = 0

  const customersList = custBalances.map(c => {
    const ob    = Number(c.opening_balance || 0)
    const sales = Number(c.credit_sales_through_end || 0)
    const pays  = Number(c.payments_through_end || 0)
    const adjs  = Number(c.adjustments_through_end || 0)
    const periodEndBalance = Number((ob + sales - pays + adjs).toFixed(2))

    totalPeriodEndOutstanding += periodEndBalance
    if (periodEndBalance > 0.005) {
      owingCustomersCount++
    }

    return {
      party_id:                 c.party_id,
      party_code:               c.party_code,
      customer_name:            c.customer_name,
      party_type:               c.party_type,
      phone:                    c.phone,
      opening_balance:          ob.toFixed(2),
      credit_sales_through_end: sales.toFixed(2),
      payments_through_end:     pays.toFixed(2),
      adjustments_through_end:  adjs.toFixed(2),
      period_end_balance:       periodEndBalance.toFixed(2),
    }
  })

  // Sort customers with highest period-end debt first
  customersList.sort((a, b) => Number(b.period_end_balance) - Number(a.period_end_balance))

  // ── 8. Daily Trends (Sales, Collections, and Loads) ───────────────────────
  const dailyTrendsSql = `
    WITH date_series AS (
      SELECT generate_series($1::DATE, $2::DATE, '1 day'::interval)::DATE AS day_date
    ),
    day_sales AS (
      SELECT
        s.sale_date,
        COALESCE(SUM(s.total_amount), 0) AS total_sales,
        COALESCE(SUM(
          GREATEST(0, s.total_amount - COALESCE((
            SELECT SUM(pa.allocated_amount)
            FROM payment_allocations pa
            WHERE pa.sale_id = s.id AND pa.voided_at IS NULL
          ), 0))
        ), 0) AS credit_sales
      FROM sales s
      WHERE s.sale_date >= $1 AND s.sale_date <= $2
        AND s.status = 'confirmed' AND s.voided_at IS NULL
      GROUP BY s.sale_date
    ),
    day_payments AS (
      SELECT
        p.payment_date,
        COALESCE(SUM(p.amount), 0) AS total_collected
      FROM payments p
      WHERE p.payment_date >= $1 AND p.payment_date <= $2
        AND p.voided_at IS NULL
      GROUP BY p.payment_date
    ),
    day_loads AS (
      SELECT
        eff.load_date,
        COALESCE(SUM(eff.live_weight_kg), 0) AS live_weight_kg,
        COALESCE(SUM(eff.dressed_weight_kg), 0) AS dressed_weight_kg
      FROM (
        SELECT DISTINCT ON (COALESCE(cl.corrects_load_id, cl.id))
          cl.id,
          cl.live_weight_kg,
          cl.dressed_weight_kg,
          cl.load_date
        FROM chicken_loads cl
        WHERE cl.load_date >= $1 AND cl.load_date <= $2
        ORDER BY COALESCE(cl.corrects_load_id, cl.id), cl.created_at DESC
      ) eff
      GROUP BY eff.load_date
    )
    SELECT
      TO_CHAR(ds.day_date, 'YYYY-MM-DD') AS date,
      COALESCE(dsale.total_sales, 0)::NUMERIC(12,2)     AS sales_amount,
      COALESCE(dsale.credit_sales, 0)::NUMERIC(12,2)    AS credit_sales_amount,
      COALESCE(dpay.total_collected, 0)::NUMERIC(12,2)  AS collections_amount,
      COALESCE(dload.live_weight_kg, 0)::NUMERIC(10,3)  AS live_weight_kg,
      COALESCE(dload.dressed_weight_kg, 0)::NUMERIC(10,3) AS dressed_weight_kg
    FROM date_series ds
    LEFT JOIN day_sales dsale ON dsale.sale_date = ds.day_date
    LEFT JOIN day_payments dpay ON dpay.payment_date = ds.day_date
    LEFT JOIN day_loads dload ON dload.load_date = ds.day_date
    ORDER BY ds.day_date ASC
  `
  const { rows: trendsRows } = await query(dailyTrendsSql, [startDate, endDate])

  const dailyTrends = trendsRows.map(r => {
    const lLive = Number(r.live_weight_kg || 0)
    const lDressed = Number(r.dressed_weight_kg || 0)
    const wastage = lLive > 0 ? (((lLive - lDressed) / lLive) * 100).toFixed(2) : null
    return {
      date:                r.date,
      sales_amount:        Number(r.sales_amount).toFixed(2),
      credit_sales_amount: Number(r.credit_sales_amount).toFixed(2),
      collections_amount:  Number(r.collections_amount).toFixed(2),
      live_weight_kg:      lLive.toFixed(3),
      dressed_weight_kg:   lDressed.toFixed(3),
      wastage_pct:         wastage,
    }
  })

  return {
    chicken_loads: {
      total_loads:                 loadsCount,
      total_live_weight_kg:        liveKg.toFixed(3),
      total_dressed_weight_kg:     dressedKg.toFixed(3),
      total_wastage_kg:            wastageKg.toFixed(3),
      aggregate_wastage_pct:       aggregateWastagePct,
      loads_list:                  loadsList,
    },
    stock_observations: {
      count:                       stockObservations.length,
      total_observed_kg:           totalObservedKg.toFixed(3),
      unique_products_count:       uniqueProductsInStock,
      observations_list:           stockObservations,
    },
    sales_summary: {
      total_sales:                 Number(salesSum?.total_sales || 0).toFixed(2),
      paid_sales:                  Number(salesSum?.paid_sales || 0).toFixed(2),
      credit_sales:                Number(salesSum?.credit_sales || 0).toFixed(2),
      sales_count:                 parseInt(salesSum?.sales_count || 0, 10),
    },
    sales_by_product: productSales.map(p => ({
      product_id:          p.product_id,
      product_name:        p.product_name,
      product_category:    p.product_category,
      total_quantity_kg:   Number(p.total_quantity_kg).toFixed(3),
      total_revenue:       Number(p.total_revenue).toFixed(2),
      average_rate_per_kg: Number(p.average_rate_per_kg).toFixed(2),
    })),
    sales_by_customer_category: categoryBreakdown,
    collections: {
      total_collections:           totalCollectedInPeriod.toFixed(2),
      payments_count:              totalPaymentsCount,
      by_method: collectionsByMethod.map(m => ({
        method:       m.method,
        total_amount: Number(m.total_amount).toFixed(2),
        count:        parseInt(m.payments_count, 10),
      })),
      payments_list: paymentsList,
    },
    period_end_outstanding: {
      as_of_date:                  endDate,
      total_period_end_outstanding: totalPeriodEndOutstanding.toFixed(2),
      owing_customers_count:       owingCustomersCount,
      total_active_customers:      customersList.length,
      customers_list:              customersList,
    },
    daily_trends: dailyTrends,
  }
}

/**
 * Escapes fields for CSV output according to RFC 4180.
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return ''
  const str = String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Formats report data as RFC 4180 CSV with clear section blocks and reconciled totals.
 */
export function generateReportCsv(report) {
  const lines = []

  // Header Title
  lines.push(['BISMILLAH CHICKEN SHOP — MANAGEMENT REPORT'].map(escapeCsv).join(','))
  lines.push(['Period:', report.period.label].map(escapeCsv).join(','))
  lines.push(['Date Range:', `${report.period.startDate} to ${report.period.endDate}`].map(escapeCsv).join(','))
  lines.push(['Generated At (IST):', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })].map(escapeCsv).join(','))
  lines.push([])

  // ── Section 1: Financial & Sales Summary ──
  lines.push(['=== FINANCIAL & SALES SUMMARY ==='].map(escapeCsv).join(','))
  lines.push(['Metric', 'Amount (INR)'].map(escapeCsv).join(','))
  lines.push(['Total Sales Invoiced', report.sales_summary.total_sales].map(escapeCsv).join(','))
  lines.push(['Sales Paid Immediately', report.sales_summary.paid_sales].map(escapeCsv).join(','))
  lines.push(['Credit Sales (Unpaid)', report.sales_summary.credit_sales].map(escapeCsv).join(','))
  lines.push(['Total Collections Received', report.collections.total_collections].map(escapeCsv).join(','))
  lines.push(['Period-End Outstanding Balance', report.period_end_outstanding.total_period_end_outstanding].map(escapeCsv).join(','))
  lines.push([])

  // ── Section 2: Chicken Loads & Wastage ──
  lines.push(['=== CHICKEN PROCESSING & WASTAGE ==='].map(escapeCsv).join(','))
  lines.push(['Total Loads Received', report.chicken_loads.total_loads].map(escapeCsv).join(','))
  lines.push(['Total Live Weight (kg)', report.chicken_loads.total_live_weight_kg].map(escapeCsv).join(','))
  lines.push(['Total Dressed Output (kg)', report.chicken_loads.total_dressed_weight_kg].map(escapeCsv).join(','))
  lines.push(['Total Wastage (kg)', report.chicken_loads.total_wastage_kg].map(escapeCsv).join(','))
  lines.push(['Weighted Aggregate Wastage %', report.chicken_loads.aggregate_wastage_pct !== null ? `${report.chicken_loads.aggregate_wastage_pct}%` : 'N/A'].map(escapeCsv).join(','))
  lines.push([])

  if (report.chicken_loads.loads_list.length > 0) {
    lines.push(['Load Number', 'Date', 'Supplier', 'Live Weight (kg)', 'Dressed Weight (kg)', 'Wastage %', 'Remaining Stock (kg)', 'Recorded By'].map(escapeCsv).join(','))
    for (const load of report.chicken_loads.loads_list) {
      lines.push([
        load.load_number,
        load.load_date,
        load.supplier_ref || '—',
        load.live_weight_kg,
        load.dressed_weight_kg,
        load.wastage_pct != null ? `${Number(load.wastage_pct).toFixed(2)}%` : '—',
        load.remaining_stock_kg || '—',
        load.created_by_name || '—',
      ].map(escapeCsv).join(','))
    }
    lines.push([
      'TOTAL',
      '',
      '',
      report.chicken_loads.total_live_weight_kg,
      report.chicken_loads.total_dressed_weight_kg,
      report.chicken_loads.aggregate_wastage_pct !== null ? `${report.chicken_loads.aggregate_wastage_pct}%` : 'N/A',
      '',
      '',
    ].map(escapeCsv).join(','))
    lines.push([])
  }

  // ── Section 3: Product Sales Breakdown ──
  lines.push(['=== SALES BY PRODUCT ==='].map(escapeCsv).join(','))
  lines.push(['Product Name', 'Category', 'Quantity Sold (kg)', 'Total Revenue (INR)', 'Avg Rate/kg (INR)'].map(escapeCsv).join(','))
  for (const prod of report.sales_by_product) {
    lines.push([
      prod.product_name,
      prod.product_category,
      prod.total_quantity_kg,
      prod.total_revenue,
      prod.average_rate_per_kg,
    ].map(escapeCsv).join(','))
  }
  const sumProdQty = report.sales_by_product.reduce((acc, p) => acc + Number(p.total_quantity_kg), 0).toFixed(3)
  const sumProdRev = report.sales_by_product.reduce((acc, p) => acc + Number(p.total_revenue), 0).toFixed(2)
  lines.push(['TOTAL', '', sumProdQty, sumProdRev, ''].map(escapeCsv).join(','))
  lines.push([])

  // ── Section 4: Collections by Payment Method ──
  lines.push(['=== COLLECTIONS BY PAYMENT METHOD ==='].map(escapeCsv).join(','))
  lines.push(['Payment Method', 'Receipt Count', 'Total Collected (INR)'].map(escapeCsv).join(','))
  for (const m of report.collections.by_method) {
    lines.push([
      m.method.toUpperCase(),
      m.count,
      m.total_amount,
    ].map(escapeCsv).join(','))
  }
  lines.push(['TOTAL', report.collections.payments_count, report.collections.total_collections].map(escapeCsv).join(','))
  lines.push([])

  // ── Section 5: Customer Period-End Outstanding Balances ──
  lines.push([`=== CUSTOMER OUTSTANDING (AS OF ${report.period_end_outstanding.as_of_date}) ===`].map(escapeCsv).join(','))
  lines.push(['Party Code', 'Customer Name', 'Type', 'Opening Balance', 'Credit Sales in Period', 'Payments in Period', 'Adjustments in Period', 'Period-End Balance (INR)'].map(escapeCsv).join(','))
  for (const cust of report.period_end_outstanding.customers_list) {
    lines.push([
      cust.party_code,
      cust.customer_name,
      cust.party_type,
      cust.opening_balance,
      cust.credit_sales_through_end,
      cust.payments_through_end,
      cust.adjustments_through_end,
      cust.period_end_balance,
    ].map(escapeCsv).join(','))
  }
  lines.push(['TOTAL OUTSTANDING', '', '', '', '', '', '', report.period_end_outstanding.total_period_end_outstanding].map(escapeCsv).join(','))
  lines.push([])

  return lines.join('\r\n')
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/reports
// Returns JSON structured report for the selected period
// Role: Admin and Manager only (Staff rejected with 403)
// ══════════════════════════════════════════════════════════════════════════
router.get('/', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const range = resolveDateRange(req.query)
    const reportData = await getReportData(range)

    return res.json({
      period: range,
      ...reportData,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// GET /api/reports/export
// Streams CSV file download with 100% total reconciliation against UI
// Role: Admin and Manager only (Staff rejected with 403)
// ══════════════════════════════════════════════════════════════════════════
router.get('/export', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const range = resolveDateRange(req.query)
    const reportData = await getReportData(range)
    const csvContent = generateReportCsv({ period: range, ...reportData })

    const filename = `bismillah-report-${range.startDate}-to-${range.endDate}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.status(200).send(csvContent)
  } catch (err) {
    next(err)
  }
})

export default router
