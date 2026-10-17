/**
 * server/tests/reports.test.js
 *
 * Phase 12 — Reports & Exports Automated Verification Suite
 *
 * Test Scenarios:
 *   1. Role-based access enforcement:
 *      401 on unauthenticated, 403 on Staff, 200 on Admin for both JSON & CSV endpoints.
 *   2. Empty periods:
 *      Returns zero/empty states cleanly without NaN or division-by-zero errors.
 *   3. Month boundaries and timezone cutoffs:
 *      Strictly includes dates within period and excludes dates outside period.
 *   4. Partial payments and separation of sales totals vs. collections by method:
 *      Strict separation between sales revenue and cash/UPI/bank collections.
 *   5. Product revenue accuracy when prices change over time:
 *      Uses immutable historical rates from sale_items.
 *   6. Historical period-end outstanding balance calculation:
 *      Transactions occurring *after* period end do not alter historical period-end balance.
 *   7. CSV export structure and total reconciliation:
 *      Exported CSV rows and summary totals match report API totals 100%.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

const TEST_URL = process.env.DATABASE_URL_TEST
if (!TEST_URL) {
  console.error('[p12-test] DATABASE_URL_TEST not set in .env')
  process.exit(1)
}
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p12-test] SAFETY ABORT: DATABASE_URL_TEST matches production database.')
  process.exit(1)
}

process.env.DATABASE_URL = TEST_URL

const { default: app } = await import('../src/app.js')
const { Pool } = pg

const pool = new Pool({
  connectionString: TEST_URL,
  ssl: TEST_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 3,
})

let server, baseUrl
let adminUserId, staffUserId
let adminCookie, staffCookie
let product1Id, product2Id
let customer1Id, customer2Id

async function apiReq(method, path, { body, cookie } = {}) {
  const url = new URL(path, baseUrl)
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  let text = null
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try { json = await res.json() } catch { json = null }
  } else {
    try { text = await res.text() } catch { text = null }
  }
  return { status: res.status, json, text, headers: res.headers }
}

function getCookie(headers) {
  return (headers.get('set-cookie') ?? '').match(/^(bcs_token=[^;]+)/)?.[1] ?? null
}

async function login(email, password) {
  const r = await apiReq('POST', '/api/auth/login', { body: { email, password } })
  return getCookie(r.headers)
}

// ── Setup ───────────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(res => server.listen(0, '127.0.0.1', res))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p12-test] Test server: ${baseUrl}`)

  // Seed test users
  const hash = await bcrypt.hash('TestPass123!', 4)

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('admin@p12test.local', $1, 'P12 Admin', 'admin')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('staff@p12test.local', $1, 'P12 Staff', 'staff')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  staffUserId = staff.id

  adminCookie = await login('admin@p12test.local', 'TestPass123!')
  staffCookie = await login('staff@p12test.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin session established')
  assert.ok(staffCookie, 'Staff session established')

  // Clean prior test artifacts
  try {
    await pool.query(`DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payment_allocations WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`UPDATE sales SET voided_at = NULL, voided_by = NULL, void_reason = NULL, status = 'draft' WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE created_by IN ($1, $2))`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sales WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM stock_entries WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM chicken_loads WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM account_adjustments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM parties WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
  } catch (_) {}

  // Fetch or seed active products
  const { rows: prods } = await pool.query(
    `SELECT id, name FROM products WHERE is_active = TRUE ORDER BY id LIMIT 2`
  )
  product1Id = prods[0].id
  product2Id = prods[1].id

  const runId = Math.random().toString(36).substring(2, 8).toUpperCase()

  // Seed Customer 1
  const { rows: [c1] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P12 Star Hotel', 'Central Avenue', 'hotel', TRUE, TRUE, $2)
     RETURNING id`,
    [`P12-HOT-${runId}`, adminUserId]
  )
  customer1Id = c1.id

  // Seed Customer 2
  const { rows: [c2] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P12 Apex Caterers', 'West Road', 'party', TRUE, TRUE, $2)
     RETURNING id`,
    [`P12-CAT-${runId}`, adminUserId]
  )
  customer2Id = c2.id
})

// ── Teardown ────────────────────────────────────────────────────────────────
after(async () => {
  try {
    await pool.query(`DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payment_allocations WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`UPDATE sales SET voided_at = NULL, voided_by = NULL, void_reason = NULL, status = 'draft' WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE created_by IN ($1, $2))`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sales WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM stock_entries WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM chicken_loads WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM account_adjustments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM parties WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM users WHERE login_email LIKE '%@p12test.local'`)
  } catch (err) {
    console.warn('[p12-test] Teardown warning:', err.message)
  }
  await pool.end()
  await new Promise(res => server.close(res))
  console.log('[p12-test] Cleanup complete.')
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Role-Based Authorization
// ════════════════════════════════════════════════════════════════════════════
describe('Authorization & Role Access on Reports and Exports', () => {
  test('1. Unauthenticated request to /api/reports returns 401 Unauthorized', async () => {
    const res = await apiReq('GET', '/api/reports')
    assert.equal(res.status, 401)
  })

  test('2. Unauthenticated request to /api/reports/export returns 401 Unauthorized', async () => {
    const res = await apiReq('GET', '/api/reports/export')
    assert.equal(res.status, 401)
  })

  test('3. Staff role is rejected from /api/reports (403 Forbidden)', async () => {
    const res = await apiReq('GET', '/api/reports', { cookie: staffCookie })
    assert.equal(res.status, 403)
    assert.match(res.json?.error || '', /Forbidden/i)
  })

  test('4. Staff role is rejected from /api/reports/export (403 Forbidden)', async () => {
    const res = await apiReq('GET', '/api/reports/export', { cookie: staffCookie })
    assert.equal(res.status, 403)
  })

  test('5. Admin role can access /api/reports (200 OK)', async () => {
    const res = await apiReq('GET', '/api/reports', { cookie: adminCookie })
    assert.equal(res.status, 200)
    assert.ok(res.json?.period)
    assert.ok(res.json?.chicken_loads)
    assert.ok(res.json?.sales_summary)
  })

  test('6. Admin role can access /api/reports/export (200 OK text/csv)', async () => {
    const res = await apiReq('GET', '/api/reports/export', { cookie: adminCookie })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/csv/)
    assert.ok(res.text?.includes('BISMILLAH CHICKEN SHOP'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Empty Period Clean Handling
// ════════════════════════════════════════════════════════════════════════════
describe('Empty period handling without division-by-zero or NaN', () => {
  test('7. Empty date range returns clean zeros and null wastage without error', async () => {
    const res = await apiReq('GET', '/api/reports?period=custom&from=2040-01-01&to=2040-01-07', { cookie: adminCookie })
    assert.equal(res.status, 200)

    const { chicken_loads, sales_summary, collections, stock_observations } = res.json

    assert.equal(chicken_loads.total_loads, 0)
    assert.equal(chicken_loads.total_live_weight_kg, '0.000')
    assert.equal(chicken_loads.total_dressed_weight_kg, '0.000')
    assert.equal(chicken_loads.total_wastage_kg, '0.000')
    assert.equal(chicken_loads.aggregate_wastage_pct, null)

    assert.equal(sales_summary.total_sales, '0.00')
    assert.equal(sales_summary.paid_sales, '0.00')
    assert.equal(sales_summary.credit_sales, '0.00')
    assert.equal(sales_summary.sales_count, 0)

    assert.equal(collections.total_collections, '0.00')
    assert.equal(collections.payments_count, 0)
    assert.equal(stock_observations.count, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Month Boundaries & Timezone Cutoffs
// ════════════════════════════════════════════════════════════════════════════
describe('Month boundaries and timezone cutoff accuracy', () => {
  test('8. Monthly report strictly includes dates in month and excludes outside dates', async () => {
    // Isolated test month: 2029-04
    const dPre  = '2029-03-31' // Day before
    const dIn1  = '2029-04-01' // First day
    const dIn2  = '2029-04-30' // Last day
    const dPost = '2029-05-01' // Day after

    // 1. Load before month
    await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: dPre, live_weight_kg: 100.0, dressed_weight_kg: 80.0 },
    })

    // 2. Load inside month (day 1)
    await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: dIn1, live_weight_kg: 200.0, dressed_weight_kg: 160.0 },
    })

    // 3. Load inside month (last day)
    await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: dIn2, live_weight_kg: 300.0, dressed_weight_kg: 240.0 },
    })

    // 4. Load after month
    await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: dPost, live_weight_kg: 400.0, dressed_weight_kg: 320.0 },
    })

    // Query report for month 2029-04
    const res = await apiReq('GET', '/api/reports?period=monthly&month=2029-04', { cookie: adminCookie })
    assert.equal(res.status, 200)

    assert.equal(res.json.period.startDate, '2029-04-01')
    assert.equal(res.json.period.endDate, '2029-04-30')

    // Live weight should be 200 + 300 = 500.000 kg (excludes 100 from March and 400 from May)
    assert.equal(res.json.chicken_loads.total_live_weight_kg, '500.000')
    assert.equal(res.json.chicken_loads.total_dressed_weight_kg, '400.000')
    assert.equal(res.json.chicken_loads.total_loads, 2)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Distinct Sales vs. Collections by Payment Method
// ════════════════════════════════════════════════════════════════════════════
describe('Partial payments and separation of sales totals vs. collections by method', () => {
  test('9. Strictly decouples sales revenue and collections by method without double-counting', async () => {
    const periodFrom = '2029-06-01'
    const periodTo   = '2029-06-10'

    // Sale 1: Walk-in Cash sale of ₹2,000 (fully paid at sale)
    const rSale1 = await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: '2029-06-02',
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 10.0, rate_per_kg: 200.0 }],
        initial_payment: { amount: 2000.0, method: 'cash' },
      },
    })
    assert.equal(rSale1.status, 201)

    // Sale 2: Customer 1 Credit sale of ₹10,000 with immediate UPI payment of ₹4,000
    const rSale2 = await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: '2029-06-03',
        sale_type: 'party_credit',
        party_id: customer1Id,
        items: [{ product_id: product1Id, quantity_kg: 50.0, rate_per_kg: 200.0 }],
        initial_payment: { amount: 4000.0, method: 'upi', external_ref: 'UPI-P12-4K' },
      },
    })
    assert.equal(rSale2.status, 201)

    // Sale 3: Customer 2 Credit sale of ₹6,000 with zero upfront payment
    const rSale3 = await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: '2029-06-04',
        sale_type: 'party_credit',
        party_id: customer2Id,
        items: [{ product_id: product2Id, quantity_kg: 30.0, rate_per_kg: 200.0 }],
      },
    })
    assert.equal(rSale3.status, 201)

    // Standalone Payment A: Bank payment of ₹5,000
    const rPay1 = await apiReq('POST', '/api/payments', {
      cookie: adminCookie,
      body: {
        party_id: customer1Id,
        payment_date: '2029-06-05',
        amount: 5000.0,
        method: 'bank',
        external_ref: 'NEFT-5000',
      },
    })
    assert.equal(rPay1.status, 201)

    // Standalone Payment B: Other payment of ₹1,000
    const rPay2 = await apiReq('POST', '/api/payments', {
      cookie: adminCookie,
      body: {
        party_id: customer2Id,
        payment_date: '2029-06-06',
        amount: 1000.0,
        method: 'other',
        external_ref: 'CHQ-1000',
      },
    })
    assert.equal(rPay2.status, 201)

    // Fetch report for custom period
    const res = await apiReq('GET', `/api/reports?period=custom&from=${periodFrom}&to=${periodTo}`, { cookie: adminCookie })
    assert.equal(res.status, 200)

    const { sales_summary, collections } = res.json

    // 1. Sales verification:
    // Total Sales: 2,000 + 10,000 + 6,000 = 18,000.00
    assert.equal(sales_summary.total_sales, '18000.00')
    assert.equal(sales_summary.paid_sales, '6000.00') // 2,000 cash + 4,000 upi upfront
    assert.equal(sales_summary.credit_sales, '12000.00') // 6,000 + 6,000 unpaid
    assert.equal(sales_summary.sales_count, 3)

    // 2. Collections verification:
    // Total Collections: 2,000 (cash) + 4,000 (upi) + 5,000 (bank) + 1,000 (other) = 12,000.00
    assert.equal(collections.total_collections, '12000.00')
    assert.equal(collections.payments_count, 4)

    // 3. Breakdown by payment method:
    const mCash  = collections.by_method.find(m => m.method === 'cash')
    const mUpi   = collections.by_method.find(m => m.method === 'upi')
    const mBank  = collections.by_method.find(m => m.method === 'bank')
    const mOther = collections.by_method.find(m => m.method === 'other')

    assert.equal(mCash?.total_amount, '2000.00')
    assert.equal(mUpi?.total_amount, '4000.00')
    assert.equal(mBank?.total_amount, '5000.00')
    assert.equal(mOther?.total_amount, '1000.00')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Historical Rate Preservation in Product Revenue
// ════════════════════════════════════════════════════════════════════════════
describe('Product revenue accuracy using historical sale_items rates', () => {
  test('10. Preserves actual charged rates on sale_items even if daily price changes', async () => {
    const rateDate1 = '2029-07-02'
    const rateDate2 = '2029-07-05'

    // Sale 1 on Day 1: 10 kg @ ₹200/kg = ₹2,000
    await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: rateDate1,
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 10.0, rate_per_kg: 200.0 }],
      },
    })

    // Sale 2 on Day 2: 10 kg @ ₹260/kg = ₹2,600 (rate changed)
    await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: rateDate2,
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 10.0, rate_per_kg: 260.0 }],
      },
    })

    const res = await apiReq('GET', '/api/reports?period=custom&from=2029-07-01&to=2029-07-10', { cookie: adminCookie })
    assert.equal(res.status, 200)

    const prod = res.json.sales_by_product.find(p => p.product_id === product1Id)
    assert.ok(prod, 'Product must appear in report')

    assert.equal(prod.total_quantity_kg, '20.000')
    assert.equal(prod.total_revenue, '4600.00') // 2,000 + 2,600
    assert.equal(prod.average_rate_per_kg, '230.00') // 4600 / 20 = 230
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Point-in-Time Period-End Outstanding Calculation
// ════════════════════════════════════════════════════════════════════════════
describe('Point-in-time period-end customer outstanding', () => {
  test('11. Period-end balance strictly includes transactions through period end and ignores subsequent ones', async () => {
    const periodEnd = '2029-08-31'
    const runId = Math.random().toString(36).substring(2, 8).toUpperCase()

    // Create an isolated customer strictly for this period-end test
    const { rows: [pEndCust] } = await pool.query(
      `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
       VALUES ($1, 'P12 PeriodEnd Customer', 'North Highway', 'hotel', TRUE, TRUE, $2)
       RETURNING id`,
      [`P12-END-${runId}`, adminUserId]
    )
    const testCustId = pEndCust.id

    // Set opening balance debt of ₹10,000 effective 2029-08-01
    await pool.query(
      `INSERT INTO account_adjustments (party_id, adjustment_type, ledger_effect, effective_date, reason, created_by)
       VALUES ($1, 'opening_balance', -10000.00, '2029-08-01', 'Initial balance', $2)`,
      [testCustId, adminUserId]
    )

    // Credit sale on 2029-08-15: ₹5,000 (within period)
    await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: '2029-08-15',
        sale_type: 'party_credit',
        party_id: testCustId,
        items: [{ product_id: product1Id, quantity_kg: 25.0, rate_per_kg: 200.0 }],
      },
    })

    // Payment on 2029-08-20: ₹3,000 (within period)
    await apiReq('POST', '/api/payments', {
      cookie: adminCookie,
      body: {
        party_id: testCustId,
        payment_date: '2029-08-20',
        amount: 3000.0,
        method: 'cash',
      },
    })

    // AT PERIOD END (2029-08-31):
    // Balance = 10,000 + 5,000 - 3,000 = ₹12,000.00

    // Now record SUBSEQUENT transactions in September (AFTER period end):
    // Subsequent credit sale on 2029-09-05: ₹8,000
    await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: '2029-09-05',
        sale_type: 'party_credit',
        party_id: testCustId,
        items: [{ product_id: product1Id, quantity_kg: 40.0, rate_per_kg: 200.0 }],
      },
    })

    // Subsequent payment on 2029-09-10: ₹4,000
    await apiReq('POST', '/api/payments', {
      cookie: adminCookie,
      body: {
        party_id: testCustId,
        payment_date: '2029-09-10',
        amount: 4000.0,
        method: 'bank',
      },
    })

    // Query report for August (period ending 2029-08-31)
    const res = await apiReq('GET', '/api/reports?period=custom&from=2029-08-01&to=2029-08-31', { cookie: adminCookie })
    assert.equal(res.status, 200)

    const cust = res.json.period_end_outstanding.customers_list.find(c => c.party_id === testCustId)
    assert.ok(cust, 'Test Customer must be present in period-end outstanding')

    // Must be strictly ₹12,000.00 as of 2029-08-31:
    assert.equal(cust.period_end_balance, '12000.00')
    assert.equal(cust.opening_balance, '10000.00')

    // Must NOT be the live balance (which would be 12,000 + 8,000 - 4,000 = 16,000.00)
    assert.notEqual(cust.period_end_balance, '16000.00')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: CSV Export & Reconciled Totals
// ════════════════════════════════════════════════════════════════════════════
describe('CSV Export reconciliation against Report API totals', () => {
  test('12. CSV export contains all sections and totals match JSON API totals 100%', async () => {
    const from = '2029-06-01'
    const to   = '2029-06-10'

    // 1. Fetch JSON report
    const rJson = await apiReq('GET', `/api/reports?period=custom&from=${from}&to=${to}`, { cookie: adminCookie })
    assert.equal(rJson.status, 200)

    // 2. Fetch CSV export
    const rCsv = await apiReq('GET', `/api/reports/export?period=custom&from=${from}&to=${to}`, { cookie: adminCookie })
    assert.equal(rCsv.status, 200)
    assert.match(rCsv.headers.get('content-type') || '', /text\/csv/)

    const csvText = rCsv.text

    // Check CSV structure headers
    assert.ok(csvText.includes('BISMILLAH CHICKEN SHOP — MANAGEMENT REPORT'))
    assert.ok(csvText.includes('=== FINANCIAL & SALES SUMMARY ==='))
    assert.ok(csvText.includes('=== CHICKEN PROCESSING & WASTAGE ==='))
    assert.ok(csvText.includes('=== SALES BY PRODUCT ==='))
    assert.ok(csvText.includes('=== COLLECTIONS BY PAYMENT METHOD ==='))
    assert.ok(csvText.includes('=== CUSTOMER OUTSTANDING'))

    // Reconcile total sales number
    assert.ok(csvText.includes(`Total Sales Invoiced,${rJson.json.sales_summary.total_sales}`))

    // Reconcile total collections number
    assert.ok(csvText.includes(`Total Collections Received,${rJson.json.collections.total_collections}`))

    // Reconcile period-end outstanding
    assert.ok(csvText.includes(`Period-End Outstanding Balance,${rJson.json.period_end_outstanding.total_period_end_outstanding}`))
  })
})
