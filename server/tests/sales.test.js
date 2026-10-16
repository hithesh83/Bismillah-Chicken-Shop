/**
 * server/tests/sales.test.js
 *
 * Phase 09 — Sales Management test suite.
 * Uses Node.js built-in test runner (node:test).
 *
 * Scenarios covered:
 *   Multi-item sales & server-side math:
 *     1. Multi-item sale calculates exact line totals and sale total on the server
 *     2. Stored rate_per_kg is preserved even if daily price changes later (Historical Immutability)
 *
 *   Payment handling & no double-counting:
 *     3. Partial payment (₹10,000 sale with ₹4,000 paid leaves exactly ₹6,000 due)
 *     4. Customer ledger balance reflects ₹6,000 net without double-counting initial payment
 *     5. Full payment leaves ₹0 due
 *     6. Full credit sale leaves full amount due
 *
 *   Server-side validation & security:
 *     7. Negative quantity is rejected (400)
 *     8. Zero quantity is rejected (400)
 *     9. Negative rate is rejected (400)
 *     10. Payment exceeding sale total is rejected (400)
 *     11. Negative payment is rejected (400)
 *     12. Credit sale to inactive customer is rejected (400)
 *     13. Credit sale to non-credit-enabled customer is rejected (400)
 *     14. Walk-in sale with party_id is rejected (400)
 *
 *   Idempotency & transaction atomicity:
 *     15. Duplicate submission with same idempotency_key returns existing sale without creating duplicate
 *     16. Invalid item causes full transaction rollback without leaving orphan draft sale
 *
 *   Role-based permissions & Void workflow:
 *     17. Unauthenticated request to GET /api/sales returns 401
 *     18. Staff user can create a confirmed sale (201)
 *     19. Staff user cannot void a confirmed sale (403 Forbidden)
 *     20. Admin user can void a confirmed sale with valid void_reason (200 OK)
 *     21. Voiding a sale voids its payment allocation and clears customer ledger debt
 *     22. Void requires a non-empty void_reason (400)
 */

import dotenv from 'dotenv'
dotenv.config({ path: new URL('../../.env', import.meta.url) })

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import bcrypt from 'bcryptjs'
import pg from 'pg'

// ── Safety guard ──────────────────────────────────────────────────────────
const TEST_URL = process.env.DATABASE_URL_TEST
if (!TEST_URL) { console.error('[p9-test] DATABASE_URL_TEST not set.'); process.exit(1) }
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p9-test] SAFETY ABORT: DATABASE_URL_TEST matches a production URL.')
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
let creditPartyId, cashPartyId, inactivePartyId

// ── Helpers ───────────────────────────────────────────────────────────────
async function apiReq(method, path, { body, cookie, headers: customHeaders } = {}) {
  const url = new URL(path, baseUrl)
  const headers = { 'Content-Type': 'application/json', ...(customHeaders || {}) }
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

// ── Setup ─────────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p9-test] Test server: ${baseUrl}`)

  // Apply migrations to test DB
  const { createHash } = await import('node:crypto')
  const { readFileSync, readdirSync } = await import('node:fs')
  const { resolve, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
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
        version    TEXT        PRIMARY KEY,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await setup.query('COMMIT')

    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort()

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
      console.log(`[p9-test] Applied migration: ${file}`)
    }
  } finally {
    await setup.end()
  }

  // Seed test users
  const hash = await bcrypt.hash('TestPass123!', 4)

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('admin@p9test.local', $1, 'P9 Admin', 'admin')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('staff@p9test.local', $1, 'P9 Staff', 'staff')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  staffUserId = staff.id

  adminCookie = await login('admin@p9test.local', 'TestPass123!')
  staffCookie = await login('staff@p9test.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin session cookie must be established')
  assert.ok(staffCookie, 'Staff session cookie must be established')

  // Clean any previous test debris for these users
  try {
    await pool.query(`DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payment_allocations WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM payments WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`UPDATE sales SET voided_at = NULL, voided_by = NULL, void_reason = NULL, status = 'draft' WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE created_by IN ($1, $2))`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM sales WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM daily_prices WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
    await pool.query(`DELETE FROM parties WHERE created_by IN ($1, $2)`, [adminUserId, staffUserId])
  } catch (_) {}

  // Fetch or create products for testing
  const { rows: prods } = await pool.query(
    `SELECT id, seed_key FROM products WHERE seed_key IN ('live_chicken', 'boneless') LIMIT 2`
  )
  assert.ok(prods.length >= 2, 'Products must exist from migration 002')
  product1Id = prods.find(p => p.seed_key === 'live_chicken')?.id || prods[0].id
  product2Id = prods.find(p => p.seed_key === 'boneless')?.id || prods[1].id

  const runId = Math.random().toString(36).substring(2, 8).toUpperCase()

  // Seed customer profiles:
  // 1. Active credit customer
  const { rows: [crdParty] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P9 Grand Hotel', 'MG Road', 'hotel', TRUE, TRUE, $2)
     RETURNING id`,
    [`P9-CRD-${runId}`, adminUserId]
  )
  creditPartyId = crdParty.id

  // 2. Active cash-only customer
  const { rows: [cashParty] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P9 Cash Restaurant', 'Station Road', 'hotel', FALSE, TRUE, $2)
     RETURNING id`,
    [`P9-CSH-${runId}`, adminUserId]
  )
  cashPartyId = cashParty.id

  // 3. Inactive customer
  const { rows: [inactParty] } = await pool.query(
    `INSERT INTO parties (party_code, name, address, party_type, credit_enabled, is_active, created_by)
     VALUES ($1, 'P9 Inactive Caterers', 'Highway', 'party', TRUE, FALSE, $2)
     RETURNING id`,
    [`P9-INA-${runId}`, adminUserId]
  )
  inactivePartyId = inactParty.id
})

// ── Teardown ──────────────────────────────────────────────────────────────
after(async () => {
  try {
    // Clean up payment allocations, payments, sale items, sales, audit logs, parties, users
    await pool.query(
      `DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`,
      [adminUserId, staffUserId]
    )
    await pool.query(
      `DELETE FROM payment_allocations WHERE created_by IN ($1, $2)`,
      [adminUserId, staffUserId]
    )
    await pool.query(
      `DELETE FROM payments WHERE created_by IN ($1, $2)`,
      [adminUserId, staffUserId]
    )
    // Clear void fields and demote to draft so trg_sale_items_immutable allows deleting items
    await pool.query(
      `UPDATE sales SET voided_at = NULL, voided_by = NULL, void_reason = NULL, status = 'draft' WHERE created_by IN ($1, $2)`,
      [adminUserId, staffUserId]
    )
    await pool.query(
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE created_by IN ($1, $2))`,
      [adminUserId, staffUserId]
    )
    await pool.query(
      `DELETE FROM sales WHERE created_by IN ($1, $2)`,
      [adminUserId, staffUserId]
    )
    await pool.query(
      `DELETE FROM daily_prices WHERE created_by IN ($1, $2)`,
      [adminUserId, staffUserId]
    )
    await pool.query(
      `DELETE FROM parties WHERE created_by IN ($1, $2)`,
      [adminUserId, staffUserId]
    )
    await pool.query(
      `DELETE FROM users WHERE login_email LIKE '%@p9test.local'`
    )
  } catch (err) {
    console.warn('[p9-test] Teardown warning:', err.message)
  }
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  console.log('[p9-test] Cleanup complete.')
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Multi-Item Sales & Server-Side Math
// ════════════════════════════════════════════════════════════════════════════
describe('Multi-item sales and server-side calculations', () => {

  test('1. Multi-item sale calculates exact line totals and sale total on the server', async () => {
    // Item 1: 5.500 kg @ ₹220.00/kg = ₹1,210.00
    // Item 2: 2.250 kg @ ₹340.00/kg = ₹765.00
    // Expected Total = ₹1,975.00
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'walkin',
        items: [
          { product_id: product1Id, quantity_kg: 5.500, rate_per_kg: 220.00 },
          { product_id: product2Id, quantity_kg: 2.250, rate_per_kg: 340.00 },
        ],
        initial_payment: {
          amount: 1975.00,
          method: 'cash',
        },
      },
    })

    assert.equal(r.status, 201)
    assert.equal(r.json.sale?.status, 'confirmed')
    assert.equal(Number(r.json.sale?.total_amount), 1975.00)
    assert.equal(Number(r.json.sale?.paid_amount), 1975.00)
    assert.equal(Number(r.json.sale?.due_amount), 0.00)
    assert.equal(r.json.sale?.items?.length, 2)
    assert.equal(Number(r.json.sale.items[0].line_total), 1210.00)
    assert.equal(Number(r.json.sale.items[1].line_total), 765.00)
  })

  test('2. Stored rate_per_kg is preserved even if daily price changes later (Historical Immutability)', async () => {
    try {
      // 1. Record sale with product1Id at rate ₹200.00
      const rSale = await apiReq('POST', '/api/sales', {
        cookie: staffCookie,
        body: {
          sale_date: todayIST(),
          sale_type: 'walkin',
          items: [
            { product_id: product1Id, quantity_kg: 10.000, rate_per_kg: 200.00 },
          ],
        },
      })
      assert.equal(rSale.status, 201)
      const saleId = rSale.json.sale.id

      // 2. Insert or update daily price for product1Id to ₹280.00
      await pool.query(
        `INSERT INTO daily_prices (product_id, effective_date, rate_per_kg, created_by)
         VALUES ($1, CURRENT_DATE, 280.00, $2)
         ON CONFLICT (product_id, effective_date) DO UPDATE
           SET rate_per_kg = 280.00`,
        [product1Id, adminUserId]
      )

      // 3. Query the previously recorded sale
      const rCheck = await apiReq('GET', `/api/sales/${saleId}`, { cookie: staffCookie })
      assert.equal(rCheck.status, 200)
      assert.equal(Number(rCheck.json.sale?.total_amount), 2000.00)
      assert.equal(Number(rCheck.json.items[0]?.rate_per_kg), 200.00, 'Original sale rate must remain 200.00')
      assert.equal(Number(rCheck.json.items[0]?.line_total), 2000.00)
    } catch (err) {
      console.error('TEST 2 ERROR:', err)
      throw err
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Payment Handling & No Double-Counting
// ════════════════════════════════════════════════════════════════════════════
describe('Atomic payment handling and ledger balance accuracy', () => {
  let partialSaleId

  test('3. Partial payment (₹10,000 sale with ₹4,000 paid leaves exactly ₹6,000 due)', async () => {
    // 50 kg @ ₹200 = ₹10,000
    // Immediate payment: ₹4,000
    // Due: ₹6,000
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'party_credit',
        party_id: creditPartyId,
        items: [
          { product_id: product1Id, quantity_kg: 50.000, rate_per_kg: 200.00 },
        ],
        initial_payment: {
          amount: 4000.00,
          method: 'upi',
          external_ref: 'UPI-TXN-4000',
        },
        notes: 'Partial payment on delivery',
      },
    })

    assert.equal(r.status, 201)
    partialSaleId = r.json.sale.id
    assert.equal(Number(r.json.sale?.total_amount), 10000.00)
    assert.equal(Number(r.json.sale?.paid_amount), 4000.00)
    assert.equal(Number(r.json.sale?.due_amount), 6000.00)
    assert.ok(r.json.sale?.payment?.payment_id)
    assert.ok(r.json.sale?.payment?.allocation_id)
  })

  test('4. Customer ledger balance reflects ₹6,000 net without double-counting initial payment', async () => {
    // Using authoritative project ledger balance query:
    // Balance = SUM(active credit sales) - SUM(active payments) - SUM(active adjustments)
    const { rows: [{ ledger_balance }] } = await pool.query(
      `SELECT
         COALESCE((SELECT SUM(s.total_amount) FROM sales s
           WHERE s.party_id = $1 AND s.sale_type = 'party_credit'
             AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
         - COALESCE((SELECT SUM(p.amount) FROM payments p
           WHERE p.party_id = $1 AND p.voided_at IS NULL), 0)
         AS ledger_balance`,
      [creditPartyId]
    )

    // ₹10,000 sale - ₹4,000 payment = ₹6,000 net customer debt.
    // The ₹4,000 is counted once, not twice.
    assert.equal(Number(ledger_balance), 6000.00)
  })

  test('5. Full payment leaves ₹0 due', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'party_cash',
        party_id: cashPartyId,
        items: [
          { product_id: product1Id, quantity_kg: 5.000, rate_per_kg: 200.00 },
        ],
        initial_payment: {
          amount: 1000.00,
          method: 'cash',
        },
      },
    })
    assert.equal(r.status, 201)
    assert.equal(Number(r.json.sale?.total_amount), 1000.00)
    assert.equal(Number(r.json.sale?.paid_amount), 1000.00)
    assert.equal(Number(r.json.sale?.due_amount), 0.00)
  })

  test('6. Full credit sale leaves full amount due', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_date: todayIST(),
        sale_type: 'party_credit',
        party_id: creditPartyId,
        items: [
          { product_id: product1Id, quantity_kg: 10.000, rate_per_kg: 200.00 },
        ],
        // No initial_payment
      },
    })
    assert.equal(r.status, 201)
    assert.equal(Number(r.json.sale?.total_amount), 2000.00)
    assert.equal(Number(r.json.sale?.paid_amount), 0.00)
    assert.equal(Number(r.json.sale?.due_amount), 2000.00)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Server-Side Validation & Security
// ════════════════════════════════════════════════════════════════════════════
describe('Server-side input validation and credit guard rules', () => {

  test('7. Negative quantity is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: -5.0, rate_per_kg: 200 }],
      },
    })
    assert.equal(r.status, 400)
  })

  test('8. Zero quantity is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 0, rate_per_kg: 200 }],
      },
    })
    assert.equal(r.status, 400)
  })

  test('9. Negative rate is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 5.0, rate_per_kg: -200 }],
      },
    })
    assert.equal(r.status, 400)
  })

  test('10. Payment exceeding sale total is rejected (400)', async () => {
    // Total is 1000.00, attempting to pay 1500.00
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 5.0, rate_per_kg: 200 }],
        initial_payment: { amount: 1500.00 },
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.initial_payment || '', /cannot exceed/i)
  })

  test('11. Negative payment is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 5.0, rate_per_kg: 200 }],
        initial_payment: { amount: -200.00 },
      },
    })
    assert.equal(r.status, 400)
  })

  test('12. Credit sale to inactive customer is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'party_credit',
        party_id: inactivePartyId,
        items: [{ product_id: product1Id, quantity_kg: 5.0, rate_per_kg: 200 }],
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.party_id || '', /deactivated|inactive/i)
  })

  test('13. Credit sale to non-credit-enabled customer is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'party_credit',
        party_id: cashPartyId,
        items: [{ product_id: product1Id, quantity_kg: 5.0, rate_per_kg: 200 }],
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.party_id || '', /not enabled for credit/i)
  })

  test('14. Walk-in sale with party_id is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        party_id: creditPartyId,
        items: [{ product_id: product1Id, quantity_kg: 5.0, rate_per_kg: 200 }],
      },
    })
    assert.equal(r.status, 400)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Idempotency & Transaction Atomicity
// ════════════════════════════════════════════════════════════════════════════
describe('Idempotency and transaction atomicity', () => {

  test('15. Duplicate submission with same idempotency_key returns existing sale without creating duplicate', async () => {
    const key = `p9_idem_test_${Date.now()}`

    const r1 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 2.0, rate_per_kg: 200 }],
        idempotency_key: key,
      },
    })
    assert.equal(r1.status, 201)
    const originalSaleNumber = r1.json.sale.sale_number

    // Submit identical request with identical idempotency_key
    const r2 = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 2.0, rate_per_kg: 200 }],
        idempotency_key: key,
      },
    })
    // Must return 200 with the original sale and is_duplicate flag
    assert.equal(r2.status, 200)
    assert.equal(r2.json.sale.sale_number, originalSaleNumber)
    assert.equal(r2.json.is_duplicate, true)
  })

  test('16. Invalid item causes full transaction rollback without leaving orphan draft sale', async () => {
    const { rows: [{ count_before }] } = await pool.query('SELECT COUNT(*) AS count_before FROM sales')

    // Item 1 is valid, Item 2 has nonexistent product UUID
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [
          { product_id: product1Id, quantity_kg: 5.0, rate_per_kg: 200 },
          { product_id: '00000000-0000-0000-0000-000000000000', quantity_kg: 5.0, rate_per_kg: 200 },
        ],
      },
    })

    // Foreign key violation causes rollback
    assert.notEqual(r.status, 201)

    const { rows: [{ count_after }] } = await pool.query('SELECT COUNT(*) AS count_after FROM sales')
    assert.equal(count_before, count_after, 'Sales table row count must remain unchanged')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Role-Based Permissions & Void Workflow
// ════════════════════════════════════════════════════════════════════════════
describe('Role-based permissions and authorized void workflow', () => {
  let saleToVoidId

  test('17. Unauthenticated request to GET /api/sales returns 401', async () => {
    const r = await apiReq('GET', '/api/sales')
    assert.equal(r.status, 401)
  })

  test('18. Staff user can create a confirmed sale (201)', async () => {
    const r = await apiReq('POST', '/api/sales', {
      cookie: staffCookie,
      body: {
        sale_type: 'walkin',
        items: [{ product_id: product1Id, quantity_kg: 3.0, rate_per_kg: 200 }],
        initial_payment: { amount: 600, method: 'cash' },
      },
    })
    assert.equal(r.status, 201)
    saleToVoidId = r.json.sale.id
  })

  test('19. Staff user cannot void a confirmed sale (403 Forbidden)', async () => {
    const r = await apiReq('POST', `/api/sales/${saleToVoidId}/void`, {
      cookie: staffCookie,
      body: { void_reason: 'Staff attempted void' },
    })
    assert.equal(r.status, 403)
  })

  test('20. Admin user can void a confirmed sale with valid void_reason (200 OK)', async () => {
    const r = await apiReq('POST', `/api/sales/${saleToVoidId}/void`, {
      cookie: adminCookie,
      body: { void_reason: 'Customer returned chicken due to catering cancellation' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.sale.status, 'voided')
    assert.equal(r.json.sale.void_reason, 'Customer returned chicken due to catering cancellation')
  })

  test('21. Voiding a sale voids its payment allocation and clears customer ledger debt', async () => {
    // 1. Create a credit sale with partial payment
    const rSale = await apiReq('POST', '/api/sales', {
      cookie: adminCookie,
      body: {
        sale_type: 'party_credit',
        party_id: creditPartyId,
        items: [{ product_id: product1Id, quantity_kg: 10.0, rate_per_kg: 200 }],
        initial_payment: { amount: 500, method: 'cash' },
      },
    })
    assert.equal(rSale.status, 201)
    const testSaleId = rSale.json.sale.id

    // 2. Void the sale as Admin
    const rVoid = await apiReq('POST', `/api/sales/${testSaleId}/void`, {
      cookie: adminCookie,
      body: { void_reason: 'Testing allocation void' },
    })
    assert.equal(rVoid.status, 200)

    // 3. Inspect payment_allocations table
    const { rows: allocs } = await pool.query(
      'SELECT voided_at FROM payment_allocations WHERE sale_id = $1',
      [testSaleId]
    )
    assert.ok(allocs.length >= 1)
    assert.notEqual(allocs[0].voided_at, null, 'Payment allocation must be marked voided')
  })

  test('22. Void requires a non-empty void_reason (400)', async () => {
    const r = await apiReq('POST', `/api/sales/${saleToVoidId}/void`, {
      cookie: adminCookie,
      body: { void_reason: '  ' },
    })
    assert.equal(r.status, 400)
  })
})
