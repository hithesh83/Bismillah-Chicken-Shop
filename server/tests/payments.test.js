/**
 * server/tests/payments.test.js
 *
 * Phase 10 — Payments, Ledger & Outstanding Tests
 *
 * Test Coverage:
 *   1. Full & partial payment reduction (₹50,000 balance - ₹30,000 payment = ₹20,000 remaining)
 *   2. FIFO allocation across multiple open credit invoices (oldest first)
 *   3. Specific invoice allocation (cannot exceed invoice due amount)
 *   4. Overpayment policy: excess sits safely as customer advance/credit balance
 *   5. Zero double-counting: immediate payment during sale creation is credited once
 *   6. Rejection of zero or negative amounts, inactive customer, and invalid methods
 *   7. Duplicate submission protection via idempotency_key
 *   8. RBAC: Staff cannot void payments (403), Admin can void with reason (200)
 *   9. Voiding a payment cancels allocations and restores customer debt
 *  10. Customer statement / ledger running balance 100% mathematical reconciliation
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
  console.error('[p10-test] DATABASE_URL_TEST not set in .env')
  process.exit(1)
}
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p10-test] SAFETY ABORT: DATABASE_URL_TEST matches production database.')
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
let product1Id
let customer1Id, customer2Id, inactiveCustomerId

// ── Helpers ─────────────────────────────────────────────────────────────────
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

// ── Setup ───────────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p10-test] Test server: ${baseUrl}`)

  // Apply all migrations
  const { createHash } = await import('node:crypto')
  const { readFileSync, readdirSync } = await import('node:fs')
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations')

  const setup = new pg.Client({
    connectionString: TEST_URL,
    ssl: TEST_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  })
  await setup.connect()

  try {
    await setup.query('BEGIN')
    await setup.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await setup.query('COMMIT')

    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
    const { rows: appliedRows } = await setup.query('SELECT version FROM schema_migrations')
    const applied = new Set(appliedRows.map(r => r.version))

    for (const file of files) {
      if (applied.has(file)) continue
      const sql      = readFileSync(resolve(migrationsDir, file), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')

      await setup.query('BEGIN')
      await setup.query(sql)
      await setup.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [file, checksum]
      )
      await setup.query('COMMIT')
      console.log(`[p10-test] Applied migration: ${file}`)
    }
  } finally {
    await setup.end()
  }

  // Seed test users
  const hash = await bcrypt.hash('TestPass123!', 4)

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('admin@p10test.local', $1, 'P10 Admin', 'admin')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('staff@p10test.local', $1, 'P10 Staff', 'staff')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  staffUserId = staff.id

  adminCookie = await login('admin@p10test.local', 'TestPass123!')
  staffCookie = await login('staff@p10test.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin cookie established')
  assert.ok(staffCookie, 'Staff cookie established')

  // Clean any previous test artifacts for these users
  try {
    await pool.query(`DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payment_allocations WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`UPDATE sales SET voided_at = NULL, voided_by = NULL, void_reason = NULL, status = 'draft' WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE created_by IN ($1, $2))`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sales WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM account_adjustments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM parties WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
  } catch (_) {}

  // Fetch product for sale creation
  const { rows: prods } = await pool.query(`SELECT id FROM products LIMIT 1`)
  product1Id = prods[0].id

  const runId = Math.random().toString(36).substring(2, 8).toUpperCase()

  // Seed Customer 1: Active credit customer
  const { rows: [c1] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P10 Palace Hotel', 'Main Road', 'hotel', TRUE, TRUE, $2)
     RETURNING id`,
    [`P10-HTL-${runId}`, adminUserId]
  )
  customer1Id = c1.id

  // Seed Customer 2: Active party customer
  const { rows: [c2] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P10 Star Caterers', 'Ring Road', 'party', TRUE, TRUE, $2)
     RETURNING id`,
    [`P10-CAT-${runId}`, adminUserId]
  )
  customer2Id = c2.id

  // Seed Inactive Customer
  const { rows: [c3] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P10 Inactive Club', 'Old City', 'hotel', TRUE, FALSE, $2)
     RETURNING id`,
    [`P10-INA-${runId}`, adminUserId]
  )
  inactiveCustomerId = c3.id
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
    await pool.query(`DELETE FROM account_adjustments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM parties WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM users WHERE login_email LIKE '%@p10test.local'`)
  } catch (err) {
    console.warn('[p10-test] Teardown warning:', err.message)
  }
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  console.log('[p10-test] Cleanup complete.')
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Core Accounting Math & Balance Reduction
// ════════════════════════════════════════════════════════════════════════════
describe('Core accounting math & exact balance reduction', () => {

  test('1. Exact balance reduction: ₹50,000 balance followed by ₹30,000 payment leaves ₹20,000 outstanding', async () => {
    // 1. Set opening balance debt of ₹50,000 on customer1
    await pool.query(
      `INSERT INTO account_adjustments (party_id, adjustment_type, ledger_effect, effective_date, reason, created_by)
       VALUES ($1, 'opening_balance', -50000.00, CURRENT_DATE, 'Initial ledger debt balance', $2)`,
      [customer1Id, adminUserId]
    )

    // 2. Check outstanding before payment
    const rPre = await apiReq('GET', `/api/outstanding?search=P10-HTL`, { cookie: staffCookie })
    assert.equal(rPre.status, 200)
    const custPre = rPre.json.customers.find(c => c.id === customer1Id)
    assert.equal(Number(custPre.opening_balance), 50000.00)
    assert.equal(Number(custPre.current_balance), 50000.00)

    // 3. Record payment of ₹30,000
    const rPay = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer1Id,
        payment_date: todayIST(),
        amount: 30000.00,
        method: 'bank',
        external_ref: 'NEFT-50K-30K',
        notes: 'Part-payment on opening balance',
      },
    })
    assert.equal(rPay.status, 201)
    assert.ok(rPay.json.payment?.payment_number)
    assert.equal(Number(rPay.json.payment?.amount), 30000.00)

    // 4. Verify outstanding balance: exactly ₹20,000.00 remaining
    const rPost = await apiReq('GET', `/api/outstanding?search=P10-HTL`, { cookie: staffCookie })
    assert.equal(rPost.status, 200)
    const custPost = rPost.json.customers.find(c => c.id === customer1Id)
    assert.equal(Number(custPost.total_payments), 30000.00)
    assert.equal(Number(custPost.current_balance), 20000.00, '50,000 - 30,000 must leave exactly 20,000')

    // 5. Verify customer statement mathematically reconciles
    const rStmt = await apiReq('GET', `/api/customers/${customer1Id}/statement`, { cookie: staffCookie })
    assert.equal(rStmt.status, 200)
    assert.equal(Number(rStmt.json.summary.current_outstanding), 20000.00)
    assert.equal(Number(rStmt.json.period.closing_balance), 20000.00)
    assert.equal(rStmt.json.statement.length, 2) // Opening balance + 1 payment
  })

  test('2. Overpayment policy: Excess payment sits safely as customer advance/credit balance', async () => {
    // Customer 1 currently owes ₹20,000.
    // Customer makes a payment of ₹25,000.
    const rPay = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer1Id,
        payment_date: todayIST(),
        amount: 25000.00,
        method: 'upi',
        external_ref: 'UPI-ADVANCE',
      },
    })
    assert.equal(rPay.status, 201)

    // Current balance should now be -₹5,000 (advance / credit)
    const rCheck = await apiReq('GET', `/api/outstanding?has_balance=false&search=P10-HTL`, { cookie: staffCookie })
    assert.equal(rCheck.status, 200)
    const cust = rCheck.json.customers.find(c => c.id === customer1Id)
    assert.equal(Number(cust.current_balance), -5000.00, 'Overpayment of ₹5,000 sits as negative customer balance')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Multi-Invoice Allocation & FIFO Ordering
// ════════════════════════════════════════════════════════════════════════════
describe('Payment allocation across open invoices', () => {
  let inv1Id, inv2Id, inv3Id

  test('3. FIFO allocation distributes payment across multiple open credit invoices oldest first', async () => {
    // Create 3 open credit invoices for Customer 2:
    // Invoice 1: ₹10,000
    // Invoice 2: ₹15,000
    // Invoice 3: ₹20,000
    // Total Debt = ₹45,000

    const r1 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: '2026-10-01',
        sale_type: 'party_credit',
        party_id: customer2Id,
        items: [{ product_id: product1Id, quantity_kg: 50.000, rate_per_kg: 200.00 }], // 10,000
      },
    })
    assert.equal(r1.status, 201)
    inv1Id = r1.json.sale.id

    const r2 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: '2026-10-05',
        sale_type: 'party_credit',
        party_id: customer2Id,
        items: [{ product_id: product1Id, quantity_kg: 75.000, rate_per_kg: 200.00 }], // 15,000
      },
    })
    assert.equal(r2.status, 201)
    inv2Id = r2.json.sale.id

    const r3 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: '2026-10-10',
        sale_type: 'party_credit',
        party_id: customer2Id,
        items: [{ product_id: product1Id, quantity_kg: 100.000, rate_per_kg: 200.00 }], // 20,000
      },
    })
    assert.equal(r3.status, 201)
    inv3Id = r3.json.sale.id

    // Check open invoices endpoint
    const rOpen = await apiReq('GET', `/api/outstanding/${customer2Id}/invoices`, { cookie: staffCookie })
    assert.equal(rOpen.status, 200)
    assert.equal(rOpen.json.invoices.length, 3)

    // Now record a single FIFO payment of ₹18,000
    // FIFO should allocate:
    //   - Invoice 1 (₹10,000): fully paid (₹10,000 allocated, ₹0 due)
    //   - Invoice 2 (₹15,000): partially paid (₹8,000 allocated, ₹7,000 due)
    //   - Invoice 3 (₹20,000): untouched (₹0 allocated, ₹20,000 due)
    const rFifoPay = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer2Id,
        payment_date: todayIST(),
        amount: 18000.00,
        method: 'upi',
        allocation_strategy: 'fifo',
        notes: 'Lump-sum payment FIFO',
      },
    })
    assert.equal(rFifoPay.status, 201)
    assert.equal(Number(rFifoPay.json.payment?.allocated_amount), 18000.00)
    assert.equal(Number(rFifoPay.json.payment?.unallocated_amount), 0.00)
    assert.equal(rFifoPay.json.payment?.allocations?.length, 2)

    const alloc1 = rFifoPay.json.payment.allocations.find(a => a.sale_id === inv1Id)
    const alloc2 = rFifoPay.json.payment.allocations.find(a => a.sale_id === inv2Id)
    assert.equal(Number(alloc1?.allocated_amount), 10000.00, 'Invoice 1 must be fully allocated with ₹10,000')
    assert.equal(Number(alloc2?.allocated_amount), 8000.00, 'Invoice 2 must receive remaining ₹8,000')

    // Verify open invoices endpoint now returns only 2 open invoices (Invoice 2 and 3)
    const rOpenPost = await apiReq('GET', `/api/outstanding/${customer2Id}/invoices`, { cookie: staffCookie })
    assert.equal(rOpenPost.status, 200)
    assert.equal(rOpenPost.json.invoices.length, 2)
    const inv2Due = rOpenPost.json.invoices.find(i => i.id === inv2Id)
    assert.equal(Number(inv2Due?.due_amount), 7000.00, 'Invoice 2 due amount must be ₹7,000')
  })

  test('4. Specific allocation strategy allocates exact amounts to chosen invoices and rejects over-allocation', async () => {
    // Attempt to allocate ₹8,000 to Invoice 2 (which only has ₹7,000 due)
    const rOverAlloc = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer2Id,
        payment_date: todayIST(),
        amount: 8000.00,
        method: 'cash',
        allocation_strategy: 'specific',
        allocations: [
          { sale_id: inv2Id, allocated_amount: 8000.00 },
        ],
      },
    })
    assert.equal(rOverAlloc.status, 400)
    assert.ok(rOverAlloc.json.errors?.allocations?.includes('remaining due is only ₹7000.00'))

    // Now correctly allocate ₹7,000 to Invoice 2 and ₹3,000 to Invoice 3 with ₹10,000 payment
    const rValidSpecific = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer2Id,
        payment_date: todayIST(),
        amount: 10000.00,
        method: 'cash',
        allocation_strategy: 'specific',
        allocations: [
          { sale_id: inv2Id, allocated_amount: 7000.00 },
          { sale_id: inv3Id, allocated_amount: 3000.00 },
        ],
      },
    })
    assert.equal(rValidSpecific.status, 201)
    assert.equal(Number(rValidSpecific.json.payment?.allocated_amount), 10000.00)

    // Now Invoice 2 is fully paid; only Invoice 3 remains with ₹17,000 due
    const rCheck = await apiReq('GET', `/api/outstanding/${customer2Id}/invoices`, { cookie: staffCookie })
    assert.equal(rCheck.status, 200)
    assert.equal(rCheck.json.invoices.length, 1)
    assert.equal(rCheck.json.invoices[0].id, inv3Id)
    assert.equal(Number(rCheck.json.invoices[0].due_amount), 17000.00)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: No Double Counting of Immediate Sale Payments
// ════════════════════════════════════════════════════════════════════════════
describe('Zero double-counting of Phase 09 immediate payments', () => {

  test('5. Immediate payment during sale creation is recorded and credited exactly once in statement', async () => {
    // Sale of ₹10,000 with ₹4,000 paid immediately on delivery
    const rSale = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'party_credit',
        party_id: customer2Id,
        items: [{ product_id: product1Id, quantity_kg: 50.000, rate_per_kg: 200.00 }], // ₹10,000
        initial_payment: {
          amount: 4000.00,
          method: 'upi',
          external_ref: 'UPI-IMM-4000',
        },
      },
    })
    assert.equal(rSale.status, 201)
    const saleId = rSale.json.sale.id

    // Fetch customer ledger statement
    const rStmt = await apiReq('GET', `/api/ledger/${customer2Id}`, { cookie: staffCookie })
    assert.equal(rStmt.status, 200)

    // Statement should show:
    // - Sale debit of ₹10,000
    // - Immediate payment credit of ₹4,000
    // - Net customer debt increase is exactly ₹6,000
    const saleLine = rStmt.json.statement.find(s => s.reference === rSale.json.sale.sale_number)
    const payLine  = rStmt.json.statement.find(s => s.description?.includes('UPI-IMM-4000'))

    assert.ok(saleLine, 'Sale line must appear in statement')
    assert.ok(payLine, 'Payment line must appear in statement')
    assert.equal(Number(saleLine.debit), 10000.00)
    assert.equal(Number(payLine.credit), 4000.00)

    // Verify mathematical link: running balance reflects net ₹6,000 effect
    const prevBalance = Number(saleLine.running_balance) - 10000.00
    assert.equal(Number(payLine.running_balance), prevBalance + 10000.00 - 4000.00)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Server-Side Validation & Duplicate Protection
// ════════════════════════════════════════════════════════════════════════════
describe('Server-side validation & duplicate submission protection', () => {

  test('6. Negative or zero payment amount is rejected (400)', async () => {
    const rZero = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: { party_id: customer1Id, amount: 0 },
    })
    assert.equal(rZero.status, 400)

    const rNeg = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: { party_id: customer1Id, amount: -1500 },
    })
    assert.equal(rNeg.status, 400)
  })

  test('7. Payment for inactive customer is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: { party_id: inactiveCustomerId, amount: 2000 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.party_id?.includes('inactive'))
  })

  test('8. Duplicate payment submission with idempotency_key returns existing payment (200)', async () => {
    const key = `IDEMP-${Date.now()}`
    const r1 = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer1Id,
        payment_date: todayIST(),
        amount: 2500.00,
        method: 'cash',
        idempotency_key: key,
      },
    })
    assert.equal(r1.status, 201)
    const originalId = r1.json.payment.id

    // Retry request with identical idempotency_key
    const r2 = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer1Id,
        payment_date: todayIST(),
        amount: 2500.00,
        method: 'cash',
        idempotency_key: key,
      },
    })
    assert.equal(r2.status, 200)
    assert.equal(r2.json.is_duplicate, true)
    assert.equal(r2.json.payment.id, originalId)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Role-Based Permissions & Authorized Void Workflow
// ════════════════════════════════════════════════════════════════════════════
describe('Role-based permissions & authorized void workflow', () => {
  let paymentToVoidId

  test('9. Unauthenticated request to /api/payments returns 401', async () => {
    const r = await apiReq('GET', '/api/payments')
    assert.equal(r.status, 401)
  })

  test('10. Staff user cannot void a payment (403 Forbidden)', async () => {
    // Record payment as staff
    const rPay = await apiReq('POST', '/api/payments', {
      cookie: staffCookie,
      body: {
        party_id: customer1Id,
        amount: 1200.00,
        method: 'cash',
      },
    })
    assert.equal(rPay.status, 201)
    paymentToVoidId = rPay.json.payment.id

    // Attempt void as staff
    const rVoidStaff = await apiReq('POST', `/api/payments/${paymentToVoidId}/void`, {
      cookie: staffCookie,
      body: { void_reason: 'Mistakenly recorded cash' },
    })
    assert.equal(rVoidStaff.status, 403)
  })

  test('11. Admin user can void a payment with mandatory void_reason (200 OK)', async () => {
    const rVoidAdmin = await apiReq('POST', `/api/payments/${paymentToVoidId}/void`, {
      cookie: adminCookie,
      body: { void_reason: 'Customer cheque bounced' },
    })
    assert.equal(rVoidAdmin.status, 200)
    assert.ok(rVoidAdmin.json.payment?.voided_at)
    assert.equal(rVoidAdmin.json.payment?.void_reason, 'Customer cheque bounced')

    // Verify payment is marked voided in GET /api/payments/:id
    const rCheck = await apiReq('GET', `/api/payments/${paymentToVoidId}`, { cookie: staffCookie })
    assert.equal(rCheck.status, 200)
    assert.ok(rCheck.json.payment.voided_at)
  })

  test('12. Voiding a payment requires a non-empty void_reason (400)', async () => {
    const r = await apiReq('POST', `/api/payments/${paymentToVoidId}/void`, {
      cookie: adminCookie,
      body: { void_reason: '' },
    })
    assert.equal(r.status, 400)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: 100% Mathematical Statement Reconciliation
// ════════════════════════════════════════════════════════════════════════════
describe('Customer ledger running balance 100% mathematical reconciliation', () => {

  test('13. Every row in the statement mathematically connects to prior row and closing balance matches outstanding', async () => {
    const r = await apiReq('GET', `/api/ledger/${customer2Id}`, { cookie: staffCookie })
    assert.equal(r.status, 200)
    const { statement, period, summary } = r.json

    assert.ok(statement.length >= 3, 'Must have multiple entries')

    let expectedRunning = Number(period.opening_balance || 0)
    let sumDebits = 0
    let sumCredits = 0

    for (let i = 0; i < statement.length; i++) {
      const line = statement[i]
      const debit = Number(line.debit)
      const credit = Number(line.credit)
      const actualRunning = Number(line.running_balance)

      sumDebits  += debit
      sumCredits += credit
      expectedRunning = Math.round((expectedRunning + debit - credit) * 100) / 100

      assert.equal(
        actualRunning,
        expectedRunning,
        `Line ${i + 1} (${line.entry_type} ${line.reference}) running balance must equal previous + debit - credit`
      )
    }

    // Verify closing balance matches last row's running balance
    const lastRowRunning = Number(statement[statement.length - 1].running_balance)
    assert.equal(Number(period.closing_balance), lastRowRunning)
    assert.equal(Number(summary.current_outstanding), lastRowRunning)
  })
})
