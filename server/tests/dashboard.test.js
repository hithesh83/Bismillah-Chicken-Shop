/**
 * server/tests/dashboard.test.js
 *
 * Phase 11 — Real Dashboard Automated Verification Suite
 *
 * Test Scenarios:
 *   1. Role-based access enforcement (401 unauthenticated, 200 staff & admin)
 *   2. Zero loads today (graceful handling without NaN or division by zero)
 *   3. Multiple chicken loads on same day: Weighted aggregate wastage formula
 *      ((sum live - sum dressed) / sum live) * 100 vs simple average
 *   4. Latest manual remaining stock retrieval without sales deduction
 *   5. Distinct Financial Metrics & Mathematical Accuracy:
 *      Separation of Total Sales, Collections Received, Credit Sales, and Customer Outstanding
 *   6. Timezone date-boundary filtering (today's records vs yesterday's records)
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
  console.error('[p11-test] DATABASE_URL_TEST not set in .env')
  process.exit(1)
}
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p11-test] SAFETY ABORT: DATABASE_URL_TEST matches production database.')
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
let customer1Id, customer2Id, customer3Id

async function apiReq(method, path, { body, cookie } = {}) {
  const url = new URL(path, baseUrl)
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json
  try { json = await res.json() } catch { json = null }
  return { status: res.status, json, headers: res.headers }
}

function getCookie(headers) {
  return (headers.get('set-cookie') ?? '').match(/^(bcs_token=[^;]+)/)?.[1] ?? null
}

async function login(email, password) {
  const r = await apiReq('POST', '/api/auth/login', { body: { email, password } })
  return getCookie(r.headers)
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function yesterdayIST() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ── Global Setup ────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(res => server.listen(0, '127.0.0.1', res))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p11-test] Test server: ${baseUrl}`)

  // Seed test users
  const hash = await bcrypt.hash('TestPass123!', 4)

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('admin@p11test.local', $1, 'P11 Admin', 'admin')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('staff@p11test.local', $1, 'P11 Staff', 'staff')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  staffUserId = staff.id

  adminCookie = await login('admin@p11test.local', 'TestPass123!')
  staffCookie = await login('staff@p11test.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin session established')
  assert.ok(staffCookie, 'Staff session established')

  // Clean prior test artifacts for these users
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
     VALUES ($1, 'P11 Royal Restaurant', 'North Road', 'hotel', TRUE, TRUE, $2)
     RETURNING id`,
    [`P11-HOT-${runId}`, adminUserId]
  )
  customer1Id = c1.id

  // Seed Customer 2
  const { rows: [c2] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P11 Grand Caterers', 'East Road', 'party', TRUE, TRUE, $2)
     RETURNING id`,
    [`P11-CAT-${runId}`, adminUserId]
  )
  customer2Id = c2.id

  // Seed Customer 3
  const { rows: [c3] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P11 City Diner', 'South Road', 'hotel', TRUE, TRUE, $2)
     RETURNING id`,
    [`P11-DIN-${runId}`, adminUserId]
  )
  customer3Id = c3.id
})

// ── Global Teardown ─────────────────────────────────────────────────────────
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
    await pool.query(`DELETE FROM users WHERE login_email LIKE '%@p11test.local'`)
  } catch (err) {
    console.warn('[p11-test] Teardown warning:', err.message)
  }
  await pool.end()
  await new Promise(res => server.close(res))
  console.log('[p11-test] Cleanup complete.')
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Authentication & Role Permissions
// ════════════════════════════════════════════════════════════════════════════
describe('Role-based access enforcement on dashboard endpoints', () => {
  test('1. Unauthenticated request to /api/dashboard returns 401 Unauthorized', async () => {
    const res = await apiReq('GET', '/api/dashboard')
    assert.equal(res.status, 401)
  })

  test('2. Staff user can access /api/dashboard (200 OK)', async () => {
    const res = await apiReq('GET', '/api/dashboard', { cookie: staffCookie })
    assert.equal(res.status, 200)
    assert.equal(res.json.user.role, 'staff')
    assert.ok(res.json.loads)
    assert.ok(res.json.finances)
  })

  test('3. Admin user can access /api/dashboard (200 OK)', async () => {
    const res = await apiReq('GET', '/api/dashboard', { cookie: adminCookie })
    assert.equal(res.status, 200)
    assert.equal(res.json.user.role, 'admin')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Chicken Loads Math & Aggregate Wastage
// ════════════════════════════════════════════════════════════════════════════
describe('Chicken loads aggregation and weighted wastage formula', () => {
  test('4. Zero loads today: returns 0 kg and null wastage without division-by-zero or NaN', async () => {
    // Choose a future date where no loads exist
    const emptyDate = '2035-12-31'
    const res = await apiReq('GET', `/api/dashboard?date=${emptyDate}`, { cookie: staffCookie })
    assert.equal(res.status, 200)
    assert.equal(res.json.loads.today_loads_count, 0)
    assert.equal(res.json.loads.today_live_weight_kg, '0.000')
    assert.equal(res.json.loads.today_dressed_weight_kg, '0.000')
    assert.equal(res.json.loads.today_wastage_kg, '0.000')
    assert.equal(res.json.loads.today_aggregate_wastage_pct, null)
  })

  test('5. Multiple loads on same day: proves weighted aggregate wastage vs simple average', async () => {
    const testDate = '2026-10-18'

    // Load 1: 100 kg live, 80 kg dressed (wastage = 20.0000%)
    const r1 = await apiReq('POST', '/api/chicken-loads', {
      cookie: staffCookie,
      body: {
        load_date: testDate,
        live_weight_kg: 100.000,
        dressed_weight_kg: 80.000,
        supplier_ref: 'SUP-P11-L1',
      },
    })
    assert.equal(r1.status, 201)
    assert.equal(Number(r1.json.load.wastage_pct).toFixed(4), '20.0000')

    // Load 2: 1000 kg live, 700 kg dressed (wastage = 30.0000%)
    const r2 = await apiReq('POST', '/api/chicken-loads', {
      cookie: staffCookie,
      body: {
        load_date: testDate,
        live_weight_kg: 1000.000,
        dressed_weight_kg: 700.000,
        supplier_ref: 'SUP-P11-L2',
      },
    })
    assert.equal(r2.status, 201)
    assert.equal(Number(r2.json.load.wastage_pct).toFixed(4), '30.0000')

    // Simple average would be: (20.0000 + 30.0000) / 2 = 25.0000%
    // Authoritative weighted formula:
    // Total Live = 100 + 1000 = 1100 kg
    // Total Dressed = 80 + 700 = 780 kg
    // Wastage Kg = 1100 - 780 = 320 kg
    // Aggregate Wastage % = ((1100 - 780) / 1100) * 100 = 29.090909...% -> 29.0909%

    const rDash = await apiReq('GET', `/api/dashboard?date=${testDate}`, { cookie: staffCookie })
    assert.equal(rDash.status, 200)

    assert.equal(rDash.json.loads.today_loads_count, 2)
    assert.equal(rDash.json.loads.today_live_weight_kg, '1100.000')
    assert.equal(rDash.json.loads.today_dressed_weight_kg, '780.000')
    assert.equal(rDash.json.loads.today_wastage_kg, '320.000')

    // Must match weighted aggregate wastage formula:
    assert.equal(rDash.json.loads.today_aggregate_wastage_pct, '29.0909')

    // Must NOT match simple average (25.0000%):
    assert.notEqual(rDash.json.loads.today_aggregate_wastage_pct, '25.0000')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Manual Stock Observations Only (No Sales Deduction)
// ════════════════════════════════════════════════════════════════════════════
describe('Manual physical stock observations only', () => {
  test('6. Displays latest manually recorded physical observation without sales deduction', async () => {
    // 1. Record observation 1 for product 1: 50.000 kg
    const rObs1 = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: product1Id,
        quantity_kg: 50.000,
        notes: 'Morning observation',
      },
    })
    assert.equal(rObs1.status, 201)

    // 2. Record later observation 2 for product 1: 65.500 kg
    const rObs2 = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: product1Id,
        quantity_kg: 65.500,
        notes: 'Mid-day physical weigh-in',
      },
    })
    assert.equal(rObs2.status, 201)

    // 3. Record confirmed sales for product 1 of 20.000 kg
    const rSale = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 20.000, rate_per_kg: 200.00 }],
        initial_payment: { amount: 4000.00, method: 'cash' },
      },
    })
    assert.equal(rSale.status, 201)

    // 4. Fetch dashboard stock
    const rDash = await apiReq('GET', '/api/dashboard', { cookie: staffCookie })
    assert.equal(rDash.status, 200)

    const prodStock = rDash.json.stock.latest_observations.find(p => p.product_id === product1Id)
    assert.ok(prodStock, 'Product must appear in stock observations')

    // Must strictly be the latest manual observation (65.500 kg)
    assert.equal(prodStock.quantity_kg, '65.500')

    // Must NOT be inferred or deducted by sales (e.g., 65.5 - 20 = 45.5 is rejected)
    assert.notEqual(prodStock.quantity_kg, '45.500')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Distinct Financial Metrics & Exact Mathematical Reconciliation
// ════════════════════════════════════════════════════════════════════════════
describe('Distinct financial metrics: Sales, Collections, Credit Sales, Outstanding', () => {
  test('7. Strictly separates Total Sales, Collections Received, Credit Sales, and Customer Outstanding without double counting', async () => {
    const finDate = '2026-10-19'

    // Customer 1 opening balance debt of ₹15,000
    await pool.query(
      `INSERT INTO account_adjustments (party_id, adjustment_type, ledger_effect, effective_date, reason, created_by)
       VALUES ($1, 'opening_balance', -15000.00, $2, 'Initial ledger debt balance', $3)`,
      [customer1Id, finDate, adminUserId]
    )

    // Transaction A: Walk-in cash sale of ₹2,000 (fully paid at sale)
    const rSale1 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: finDate,
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 10.000, rate_per_kg: 200.00 }], // ₹2,000
        initial_payment: { amount: 2000.00, method: 'cash' },
      },
    })
    assert.equal(rSale1.status, 201)

    // Transaction B: Customer 1 Credit sale of ₹10,000 with immediate payment of ₹4,000
    const rSale2 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: finDate,
        sale_type: 'party_credit',
        party_id: customer1Id,
        items: [{ product_id: product1Id, quantity_kg: 50.000, rate_per_kg: 200.00 }], // ₹10,000
        initial_payment: { amount: 4000.00, method: 'upi', external_ref: 'UPI-FIN-4K' },
      },
    })
    assert.equal(rSale2.status, 201)

    // Transaction C: Customer 2 Credit sale of ₹5,000 with zero upfront payment
    const rSale3 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: finDate,
        sale_type: 'party_credit',
        party_id: customer2Id,
        items: [{ product_id: product2Id, quantity_kg: 25.000, rate_per_kg: 200.00 }], // ₹5,000
      },
    })
    assert.equal(rSale3.status, 201)

    // Transaction D: Customer 3 pays standalone receipt of ₹3,000
    const rPay = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer3Id,
        payment_date: finDate,
        amount: 3000.00,
        method: 'bank',
        external_ref: 'NEFT-STANDALONE-3K',
      },
    })
    assert.equal(rPay.status, 201)

    // Query Dashboard for finDate
    const rDash = await apiReq('GET', `/api/dashboard?date=${finDate}`, { cookie: staffCookie })
    assert.equal(rDash.status, 200)

    const fin = rDash.json.finances

    // 1. Today's Total Sales:
    //    Sale 1 (2,000) + Sale 2 (10,000) + Sale 3 (5,000) = ₹17,000.00
    assert.equal(fin.today_total_sales, '17000.00')
    assert.equal(fin.today_sales_count, 3)

    // 2. Today's Collections Received:
    //    Immediate payments (2,000 + 4,000) + Standalone payment (3,000) = ₹9,000.00
    //    Strictly cash collected, zero double counting!
    assert.equal(fin.today_collections_received, '9000.00')
    assert.equal(fin.today_payments_count, 3)

    // 3. Today's Credit Sales:
    //    Unpaid/credited portion of today's sales:
    //    Sale 1: 0
    //    Sale 2: 10,000 - 4,000 = 6,000
    //    Sale 3: 5,000 - 0 = 5,000
    //    Total = 11,000.00
    assert.equal(fin.today_credit_sales, '11000.00')

    // Mathematical verification:
    // Total Sales (17,000) = Paid portion (6,000) + Credit portion (11,000)
    assert.equal(
      Number(fin.today_total_sales),
      Number(fin.today_paid_sales) + Number(fin.today_credit_sales)
    )

    // 4. Distinct Customer Outstanding:
    //    Customer 1: opening 15,000 + credit sale 10,000 - payment 4,000 = 21,000
    //    Customer 2: credit sale 5,000 = 5,000
    //    Customer 3: payment 3,000 (advance) = -3,000
    //    Net outstanding = 21,000 + 5,000 - 3,000 = 23,000
    //    Ensure total_outstanding_amount reflects all active customer balances
    assert.ok(Number(rDash.json.outstanding.total_outstanding_amount) >= 23000.00)
    assert.ok(rDash.json.outstanding.owing_customers_count >= 2)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Timezone Date-Boundary Filtering
// ════════════════════════════════════════════════════════════════════════════
describe('Timezone date-boundary filtering (today vs yesterday)', () => {
  test('8. Date boundary filtering keeps yesterday records out of today metrics', async () => {
    const yDate = '2028-11-20'
    const tDate = '2028-11-21'

    // Seed load for yesterday
    await apiReq('POST', '/api/chicken-loads', {
      cookie: staffCookie,
      body: {
        load_date: yDate,
        live_weight_kg: 500.000,
        dressed_weight_kg: 380.000,
        supplier_ref: 'SUP-YEST',
      },
    })

    // Seed sale for yesterday
    await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: yDate,
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 10.000, rate_per_kg: 200.00 }],
        initial_payment: { amount: 2000.00, method: 'cash' },
      },
    })

    // Seed load for today
    await apiReq('POST', '/api/chicken-loads', {
      cookie: staffCookie,
      body: {
        load_date: tDate,
        live_weight_kg: 300.000,
        dressed_weight_kg: 220.000,
        supplier_ref: 'SUP-TODAY',
      },
    })

    // Seed sale for today
    await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: tDate,
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 15.000, rate_per_kg: 200.00 }],
        initial_payment: { amount: 3000.00, method: 'cash' },
      },
    })

    // Query dashboard for today
    const rToday = await apiReq('GET', `/api/dashboard?date=${tDate}`, { cookie: staffCookie })
    assert.equal(rToday.status, 200)
    assert.equal(rToday.json.loads.today_live_weight_kg, '300.000')
    assert.equal(rToday.json.loads.today_dressed_weight_kg, '220.000')
    assert.equal(rToday.json.finances.today_total_sales, '3000.00')

    // Query dashboard for yesterday
    const rYest = await apiReq('GET', `/api/dashboard?date=${yDate}`, { cookie: staffCookie })
    assert.equal(rYest.status, 200)
    assert.equal(rYest.json.loads.today_live_weight_kg, '500.000')
    assert.equal(rYest.json.loads.today_dressed_weight_kg, '380.000')
    assert.equal(rYest.json.finances.today_total_sales, '2000.00')
  })
})
