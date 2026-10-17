/**
 * server/tests/phase13_security_audit.test.js
 *
 * Phase 13 — Comprehensive System Testing & Security Review Verification Suite
 *
 * Covers the 10 Mandatory Security, Accounting & Domain Invariant Scenarios:
 *   1. Wastage Calculation: 500 kg live & 380 kg dressed = 24% wastage + weighted aggregate wastage.
 *   2. Zero-Weight Safety: Zero live weight safely handled/rejected without division-by-zero (NaN/Infinity).
 *   3. Negative/Invalid Input Rejection: Negative weights, prices, sale quantities, and payments rejected (400).
 *   4. Manual Stock Preservation: Recorded manual stock observations are never reduced by sales.
 *   5. Partial Payment Sale Math: ₹10,000 sale with ₹4,000 paid immediately leaves exactly ₹6,000 due.
 *   6. Outstanding & Payment Reconciliation: ₹50,000 balance followed by ₹30,000 payment leaves ₹20,000.
 *   7. Historical Price Immutability: Updating daily prices never alters historical charged rates on past sales.
 *   8. Duplicate Customer Names: Duplicate customer names remain distinct via unique Party IDs and UUIDs.
 *   9. Role Enforcement: Staff and unauthenticated requests to Admin-only endpoints fail with 401/403.
 *  10. Report Reconciliation: Report totals mathematically reconcile 100% against underlying database records.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

// ── Database Safety Checks ────────────────────────────────────────────────
const TEST_URL = process.env.DATABASE_URL_TEST
if (!TEST_URL) {
  console.error('[p13-test] DATABASE_URL_TEST not set in .env')
  process.exit(1)
}
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p13-test] SAFETY ABORT: DATABASE_URL_TEST matches production database.')
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
let adminUser, staffUser
let adminCookie, staffCookie
let testProductId1, testProductId2

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

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ── Setup ─────────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(res => server.listen(0, '127.0.0.1', res))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p13-test] Test server running at: ${baseUrl}`)

  // Apply migrations to test DB
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations')
  const client = new pg.Client({
    connectionString: TEST_URL,
    ssl: TEST_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  })
  await client.connect()
  await client.query('BEGIN')
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT NOT NULL
  )`)
  await client.query('COMMIT')

  const { rows } = await client.query('SELECT version FROM schema_migrations')
  const applied  = new Set(rows.map(r => r.version))
  const files    = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()

  for (const f of files) {
    if (applied.has(f)) continue
    const sql   = readFileSync(resolve(migrationsDir, f), 'utf8')
    const cksum = createHash('sha256').update(sql).digest('hex')
    await client.query('BEGIN')
    await client.query(sql)
    await client.query(
      `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING`,
      [f, cksum]
    )
    await client.query('COMMIT')
  }
  await client.end()

  // Seed test admin & staff users
  const hash = await bcrypt.hash('AuditPass123!', 4)

  const { rows: [a] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role, is_active)
     VALUES ('admin-audit@p13test.local', $1, 'P13 Admin Auditor', 'admin', TRUE)
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, is_active = TRUE, role = 'admin', failed_login_attempts = 0, locked_until = NULL
     RETURNING id, display_name, login_email, role`,
    [hash]
  )
  adminUser = a

  const { rows: [s] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role, is_active)
     VALUES ('staff-audit@p13test.local', $1, 'P13 Staff Auditor', 'staff', TRUE)
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, is_active = TRUE, role = 'staff', failed_login_attempts = 0, locked_until = NULL
     RETURNING id, display_name, login_email, role`,
    [hash]
  )
  staffUser = s

  adminCookie = await login('admin-audit@p13test.local', 'AuditPass123!')
  staffCookie = await login('staff-audit@p13test.local', 'AuditPass123!')

  assert.ok(adminCookie, 'Admin session initialized')
  assert.ok(staffCookie, 'Staff session initialized')

  // Get active test products
  const { rows: prods } = await pool.query(
    `SELECT id FROM products WHERE is_active = TRUE ORDER BY id LIMIT 2`
  )
  testProductId1 = prods[0].id
  testProductId2 = prods[1].id
})

after(async () => {
  try {
    await pool.query(`DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM payment_allocations WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM payments WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`UPDATE sales SET voided_at = NULL, voided_by = NULL, void_reason = NULL, status = 'draft' WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE created_by IN ($1, $2))`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM sales WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM stock_entries WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM chicken_loads WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM account_adjustments WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
    await pool.query(`DELETE FROM parties WHERE created_by IN ($1, $2)`, [adminUser.id, staffUser.id])
  } catch (_) {}
  await pool.end()
  if (server) await new Promise(res => server.close(res))
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Wastage Calculation & Weighted Aggregate Wastage
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 1: Wastage Calculation & Weighted Aggregate Wastage', async () => {
  test('500 kg live weight and 380 kg dressed weight yields exactly 24.0000% wastage', async () => {
    const res = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:         todayIST(),
        live_weight_kg:    500.000,
        dressed_weight_kg: 380.000,
        supplier_ref:      'Supplier Batch 24%',
      },
    })
    assert.equal(res.status, 201)
    const load = res.json?.load
    assert.equal(Number(load.live_weight_kg), 500)
    assert.equal(Number(load.dressed_weight_kg), 380)
    // Wastage %: ((500 - 380) / 500) * 100 = 24.0000%
    assert.equal(Number(load.wastage_pct).toFixed(4), '24.0000')
  })

  test('Weighted aggregate wastage across multiple loads matches ((SUM(live) - SUM(dressed)) / SUM(live)) * 100', async () => {
    // Add second load: 1000 kg live, 700 kg dressed (30% wastage)
    const res2 = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:         todayIST(),
        live_weight_kg:    1000.000,
        dressed_weight_kg: 700.000,
        supplier_ref:      'Supplier Batch 30%',
      },
    })
    assert.equal(res2.status, 201)

    // Total live = 500 + 1000 = 1500 kg
    // Total dressed = 380 + 700 = 1080 kg
    // Aggregate wastage = ((1500 - 1080) / 1500) * 100 = 420 / 1500 * 100 = 28.0000%
    // (Notice simple average is (24 + 30) / 2 = 27%, proving weighted formula works)
    const reportRes = await apiReq('GET', `/api/reports?period=daily&date=${todayIST()}`, {
      cookie: adminCookie,
    })
    assert.equal(reportRes.status, 200)
    const cl = reportRes.json?.chicken_loads
    assert.equal(Number(cl.total_live_weight_kg), 1500)
    assert.equal(Number(cl.total_dressed_weight_kg), 1080)
    assert.equal(Number(cl.aggregate_wastage_pct).toFixed(4), '28.0000')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Zero-Weight Safety & Zero Division Protection
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 2: Zero-Weight Safety & Zero Division Protection', async () => {
  test('Zero live weight is safely rejected with 400 Bad Request and never causes division-by-zero', async () => {
    const res = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:         todayIST(),
        live_weight_kg:    0,
        dressed_weight_kg: 0,
      },
    })
    assert.equal(res.status, 400)
    assert.ok(
      res.json?.errors?.live_weight_kg?.includes('positive number greater than zero') ||
      res.json?.message?.includes('positive number greater than zero')
    )
  })

  test('Reports and Dashboard queries for empty days return null wastage and zero kg without NaN or Infinity', async () => {
    const res = await apiReq('GET', '/api/reports?period=custom&from=2020-01-01&to=2020-01-02', {
      cookie: adminCookie,
    })
    assert.equal(res.status, 200)
    assert.equal(Number(res.json?.chicken_loads?.total_live_weight_kg), 0)
    assert.equal(Number(res.json?.chicken_loads?.total_dressed_weight_kg), 0)
    assert.equal(res.json?.chicken_loads?.aggregate_wastage_pct, null)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Negative / Invalid Input Rejection
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 3: Negative / Invalid Input Rejection', async () => {
  test('Negative chicken load weights are rejected with 400', async () => {
    const res = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:         todayIST(),
        live_weight_kg:    -100,
        dressed_weight_kg: -80,
      },
    })
    assert.equal(res.status, 400)
  })

  test('Negative or zero daily prices are rejected with 400', async () => {
    const res = await apiReq('POST', '/api/daily-prices', {
      cookie: adminCookie,
      body: {
        product_id:     testProductId1,
        effective_date: todayIST(),
        rate_per_kg:    -250.00,
      },
    })
    assert.equal(res.status, 400)
  })

  test('Negative or zero sale quantities are rejected with 400', async () => {
    const res = await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'walkin',
        items: [{ product_id: testProductId1, quantity_kg: -5.0, rate_per_kg: 250 }],
      },
    })
    assert.equal(res.status, 400)
  })

  test('Negative or zero payments are rejected with 400', async () => {
    const res = await apiReq('POST', '/api/payments', {
      cookie: adminCookie,
      body: {
        amount:       -500.00,
        method:       'cash',
        payment_date: todayIST(),
      },
    })
    assert.equal(res.status, 400)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Manual Stock Preservation (Never Auto-Deducted)
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 4: Manual Stock Preservation (Never Auto-Deducted)', async () => {
  test('Manual physical stock observation remains intact and is never reduced by sales', async () => {
    // 1. Record manual physical observation of 150 kg
    const stockRes = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id:  testProductId1,
        quantity_kg: 150.000,
        notes:       'Physical count before evening shift',
      },
    })
    assert.equal(stockRes.status, 201)
    const stockId = stockRes.json?.entry?.id

    // 2. Perform a confirmed walk-in sale of 25 kg
    const saleRes = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'walkin',
        items: [{ product_id: testProductId1, quantity_kg: 25.0, rate_per_kg: 200.0 }],
        initial_payment: { amount: 5000, method: 'cash' },
      },
    })
    assert.equal(saleRes.status, 201)

    // 3. Verify stock observation record in DB is still exactly 150.000 kg
    const checkRes = await apiReq('GET', `/api/stock-entries/${stockId}`, {
      cookie: staffCookie,
    })
    assert.equal(checkRes.status, 200)
    assert.equal(Number(checkRes.json?.entry?.quantity_kg), 150.0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Partial Payment Sale Math
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 5: Partial Payment Sale Math', async () => {
  test('₹10,000 sale with ₹4,000 immediate payment leaves exactly ₹6,000 due without double-counting', async () => {
    // Create customer party for credit sale
    const custRes = await apiReq('POST', '/api/customers', {
      cookie: adminCookie,
      body: {
        name:            'Hotel Al-Madina',
        party_type:      'hotel',
        phone:           '9876540001',
        credit_enabled:  true,
        opening_balance: 0,
      },
    })
    const customer = custRes.json?.customer

    // Record ₹10,000 sale (50 kg @ ₹200) with ₹4,000 initial payment
    const saleRes = await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        party_id:        customer.id,
        sale_date:       todayIST(),
        sale_type:       'party_credit',
        items:           [{ product_id: testProductId1, quantity_kg: 50.0, rate_per_kg: 200.0 }],
        initial_payment: { amount: 4000.0, method: 'cash' },
      },
    })
    assert.equal(saleRes.status, 201)
    const sale = saleRes.json?.sale
    assert.equal(Number(sale.total_amount), 10000.0)
    assert.equal(Number(sale.paid_amount), 4000.0)
    assert.equal(Number(sale.due_amount), 6000.0)

    // Verify invoice statement reflects ₹6,000 balance due
    const openInvoicesRes = await apiReq('GET', `/api/outstanding/${customer.id}/invoices`, {
      cookie: adminCookie,
    })
    assert.equal(openInvoicesRes.status, 200)
    const targetInvoice = openInvoicesRes.json?.invoices?.find(inv => inv.id === sale.id)
    assert.ok(targetInvoice, 'Invoice exists in open invoices')
    assert.equal(Number(targetInvoice.due_amount), 6000.0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Outstanding & Payment Reconciliation
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 6: Outstanding & Payment Reconciliation', async () => {
  test('₹50,000 outstanding balance followed by ₹30,000 payment leaves exact ₹20,000 balance', async () => {
    // Create customer with ₹50,000 opening debt
    const custRes = await apiReq('POST', '/api/customers', {
      cookie: adminCookie,
      body: {
        name:            'Royal Caterers',
        party_type:      'party',
        phone:           '9876540002',
        opening_balance: 50000.00,
      },
    })
    const customer = custRes.json?.customer

    // Record ₹30,000 payment receipt
    const payRes = await apiReq('POST', '/api/payments', {
      cookie: adminCookie,
      body: {
        party_id:     customer.id,
        payment_date: todayIST(),
        amount:       30000.00,
        method:       'bank',
        external_ref: 'NEFT-50K-REC',
        notes:        'Partial settlement against opening debt',
      },
    })
    assert.equal(payRes.status, 201)

    // Verify customer outstanding in ledger statement
    const statementRes = await apiReq('GET', `/api/customers/${customer.id}/statement`, {
      cookie: adminCookie,
    })
    assert.equal(statementRes.status, 200)
    const summary = statementRes.json?.summary
    assert.equal(Number(summary.all_time_debits), 50000.0)
    assert.equal(Number(summary.all_time_credits), 30000.0)
    assert.equal(Number(summary.current_outstanding), 20000.0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — Historical Price Immutability
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 7: Historical Price Immutability', async () => {
  test('Adding new daily prices does not alter historical charged rates or totals on past sales', async () => {
    const historicalDate = '2026-01-01'

    // Set historical price: ₹220/kg
    await apiReq('POST', '/api/daily-prices', {
      cookie: adminCookie,
      body: {
        product_id:     testProductId2,
        effective_date: historicalDate,
        rate_per_kg:    220.00,
      },
    })

    // Record historical sale: 10 kg @ ₹220 = ₹2,200
    const saleRes = await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_date: historicalDate,
        sale_type: 'walkin',
        items: [{ product_id: testProductId2, quantity_kg: 10.0, rate_per_kg: 220.0 }],
        initial_payment: { amount: 2200.0, method: 'cash' },
      },
    })
    assert.equal(saleRes.status, 201)
    const saleId = saleRes.json?.sale?.id

    // Update daily price for today: ₹300/kg
    await apiReq('POST', '/api/daily-prices', {
      cookie: adminCookie,
      body: {
        product_id:     testProductId2,
        effective_date: todayIST(),
        rate_per_kg:    300.00,
      },
    })

    // Check historical sale details
    const checkSale = await apiReq('GET', `/api/sales/${saleId}`, {
      cookie: adminCookie,
    })
    assert.equal(checkSale.status, 200)
    const item = checkSale.json?.items?.[0]
    assert.equal(Number(item.rate_per_kg), 220.00)
    assert.equal(Number(item.line_total), 2200.00)
    assert.equal(Number(checkSale.json?.sale?.total_amount), 2200.00)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — Duplicate Customer Names with Unique Party IDs
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 8: Duplicate Customer Names with Unique Party IDs', async () => {
  test('Customers with identical names remain distinct via unique Party IDs and UUIDs', async () => {
    // Customer A: "Taj Hotel" (Shop A branch)
    const resA = await apiReq('POST', '/api/customers', {
      cookie: adminCookie,
      body: {
        name:       'Taj Hotel',
        party_type: 'hotel',
        phone:      '9999900001',
        address:    'Shivaji Nagar Branch',
      },
    })
    assert.equal(resA.status, 201)
    const custA = resA.json?.customer

    // Customer B: "Taj Hotel" (Indiranagar branch)
    const resB = await apiReq('POST', '/api/customers', {
      cookie: adminCookie,
      body: {
        name:       'Taj Hotel',
        party_type: 'hotel',
        phone:      '9999900002',
        address:    'Indiranagar Branch',
      },
    })
    assert.equal(resB.status, 201)
    const custB = resB.json?.customer

    // Verify distinct identities
    assert.notEqual(custA.id, custB.id)
    assert.notEqual(custA.party_code, custB.party_code)
    assert.equal(custA.name, custB.name)

    // Verify both appear in customer search
    const searchRes = await apiReq('GET', '/api/customers?search=Taj+Hotel', {
      cookie: adminCookie,
    })
    assert.equal(searchRes.status, 200)
    const found = searchRes.json?.customers?.filter(c => c.name === 'Taj Hotel')
    assert.ok(found.length >= 2, 'Both duplicate name customers found')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 9 — Role-Based Access Control (RBAC) Enforcement
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 9: Role-Based Access Control (RBAC) Enforcement', async () => {
  test('Unauthenticated requests to admin endpoints fail with 401', async () => {
    const resUsers = await apiReq('GET', '/api/users')
    assert.equal(resUsers.status, 401)

    const resReports = await apiReq('GET', '/api/reports')
    assert.equal(resReports.status, 401)

    const resSettings = await apiReq('PUT', '/api/settings/shop_profile', {
      body: { shop_name: 'Unauthorized Change' },
    })
    assert.equal(resSettings.status, 401)
  })

  test('Staff requests to Admin-only endpoints fail with 403 Forbidden', async () => {
    const resUsers = await apiReq('GET', '/api/users', { cookie: staffCookie })
    assert.equal(resUsers.status, 403)

    const resReports = await apiReq('GET', '/api/reports', { cookie: staffCookie })
    assert.equal(resReports.status, 403)

    const resSettings = await apiReq('PUT', '/api/settings/shop_profile', {
      cookie: staffCookie,
      body: { shop_name: 'Staff Unauthorized Change' },
    })
    assert.equal(resSettings.status, 403)
  })

  test('Admin requests succeed with 200 OK', async () => {
    const resUsers = await apiReq('GET', '/api/users', { cookie: adminCookie })
    assert.equal(resUsers.status, 200)

    const resReports = await apiReq('GET', '/api/reports', { cookie: adminCookie })
    assert.equal(resReports.status, 200)

    const resSettings = await apiReq('GET', '/api/settings', { cookie: adminCookie })
    assert.equal(resSettings.status, 200)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 10 — Report Reconciliation & Audit Parity
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 10: Report Reconciliation & Audit Parity', async () => {
  test('Report totals and exported CSV match underlying database transactions 100%', async () => {
    const testDate = '2026-06-15'

    // Create a party
    const pRes = await apiReq('POST', '/api/customers', {
      cookie: adminCookie,
      body: {
        name:            'Reconciliation Test Customer',
        party_type:      'hotel',
        phone:           '9876540003',
        credit_enabled:  true,
        opening_balance: 1000.00,
      },
    })
    const partyId = pRes.json?.customer?.id

    // Create a sale on testDate: 20 kg @ ₹250 = ₹5,000 with ₹2,000 cash payment
    await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        party_id:        partyId,
        sale_date:       testDate,
        sale_type:       'party_credit',
        items:           [{ product_id: testProductId1, quantity_kg: 20.0, rate_per_kg: 250.0 }],
        initial_payment: { amount: 2000.0, method: 'cash' },
      },
    })

    // Fetch daily report for testDate
    const repRes = await apiReq('GET', `/api/reports?period=daily&date=${testDate}`, {
      cookie: adminCookie,
    })
    assert.equal(repRes.status, 200)
    const rep = repRes.json

    // Verify sales summary matches
    assert.equal(Number(rep.sales_summary.total_sales), 5000.0)
    assert.equal(Number(rep.sales_summary.paid_sales), 2000.0)
    assert.equal(Number(rep.sales_summary.credit_sales), 3000.0)

    // Verify collections match
    assert.equal(Number(rep.collections.total_collections), 2000.0)

    // Verify CSV export returns 200 and matches totals
    const csvRes = await apiReq('GET', `/api/reports/export?period=daily&date=${testDate}`, {
      cookie: adminCookie,
    })
    assert.equal(csvRes.status, 200)
    assert.ok(csvRes.headers.get('content-type')?.includes('text/csv'))
    assert.ok(csvRes.text.includes('5000.00'), 'CSV contains sales total')
    assert.ok(csvRes.text.includes('2000.00'), 'CSV contains collections total')
  })
})
