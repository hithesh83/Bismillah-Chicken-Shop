/**
 * server/tests/products.test.js
 *
 * Phase 05 — Products and Daily Prices test suite.
 * Uses Node.js built-in test runner (node:test).
 *
 * SAFETY:
 *   - Uses DATABASE_URL_TEST (local bismillah_test DB) — never production
 *   - Starts Express app on a random port
 *   - All test data uses emails/seed_keys scoped to '@p5test.local'
 *   - Full cleanup in after() hook
 *
 * Scenarios:
 *   Products:
 *     1.  Admin can list all products (includes seed products)
 *     2.  Staff can list active products
 *     3.  Admin can create a new product
 *     4.  Empty product name is rejected (400)
 *     5.  Invalid category is rejected (400)
 *     6.  Admin can deactivate a product
 *     7.  Deactivated product excluded from active list
 *     8.  Admin can re-activate a product
 *     9.  Staff cannot create a product (403)
 *     10. Staff cannot deactivate a product (403)
 *     11. Unauthenticated request returns 401
 *
 *   Daily Prices:
 *     12. Admin can set a price for a product+date
 *     13. Duplicate product+date is rejected with 409
 *     14. Zero price is rejected (400)
 *     15. Negative price is rejected (400)
 *     16. Invalid date format is rejected (400)
 *     17. Staff cannot set a price (403)
 *     18. GET /today returns today's prices
 *     19. GET /history returns price history in newest-first order
 *     20. Past price entry cannot be deleted (409)
 *     21. Future price entry can be deleted
 *     22. New price does not alter existing price entries (historical preservation)
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
if (!TEST_URL) { console.error('[p5-test] DATABASE_URL_TEST not set.'); process.exit(1) }
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p5-test] SAFETY ABORT: DATABASE_URL_TEST matches a production URL.')
  process.exit(1)
}

// Override DATABASE_URL before importing app so pool.js uses the test DB
process.env.DATABASE_URL = TEST_URL

const { default: app } = await import('../src/app.js')
const { Pool } = pg

const pool = new Pool({
  connectionString: TEST_URL,
  ssl: TEST_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 3,
})

let server, baseUrl
// IDs seeded during setup
let adminUserId, staffUserId, testProductId

// ── Helpers ───────────────────────────────────────────────────────────────
async function apiReq(method, path, { body, cookie } = {}) {
  const url = new URL(path, baseUrl)
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
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

// IST today helper (matches server logic)
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function futureDateIST(daysAhead = 1) {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function pastDateIST(daysBack = 1) {
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ── Setup / teardown ──────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p5-test] Test server: ${baseUrl}`)

  // Apply migrations
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
  await setup.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT NOT NULL
  )`)
  const { rows } = await setup.query('SELECT version FROM schema_migrations')
  const applied = new Set(rows.map(r => r.version))
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (applied.has(f)) continue
    const sql = readFileSync(resolve(migrationsDir, f), 'utf8')
    const cksum = createHash('sha256').update(sql).digest('hex')
    await setup.query('BEGIN')
    await setup.query(sql)
    await setup.query('INSERT INTO schema_migrations (version,checksum) VALUES ($1,$2)', [f, cksum])
    await setup.query('COMMIT')
  }
  await setup.end()

  // Seed admin user
  const hash = await bcrypt.hash('TestAdmin123!', 4)
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (display_name, login_email, password_hash, role)
     VALUES ('P5 Admin', 'admin@p5test.local', $1, 'admin')
     ON CONFLICT (login_email) DO UPDATE SET password_hash = $1, role = 'admin'
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  // Seed staff user
  const staffHash = await bcrypt.hash('TestStaff123!', 4)
  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (display_name, login_email, password_hash, role)
     VALUES ('P5 Staff', 'staff@p5test.local', $1, 'staff')
     ON CONFLICT (login_email) DO UPDATE SET password_hash = $1, role = 'staff'
     RETURNING id`,
    [staffHash]
  )
  staffUserId = staff.id

  // Clean any leftover test prices for these users
  await pool.query(`DELETE FROM daily_prices WHERE created_by IN ($1,$2)`, [adminUserId, staffUserId])
  // Clean any leftover custom test products
  await pool.query(`DELETE FROM products WHERE seed_key LIKE 'p5test_%'`)

  console.log('[p5-test] Ready.\n')
})

after(async () => {
  await pool.query(`DELETE FROM daily_prices WHERE created_by IN ($1,$2)`, [adminUserId, staffUserId])
  await pool.query(`DELETE FROM products WHERE seed_key LIKE 'p5test_%'`)
  await pool.query(`DELETE FROM users WHERE login_email LIKE '%@p5test.local'`)
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  console.log('[p5-test] Server closed.')
})

// ══════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════════════════════════════════════

describe('Scenario 1: Admin lists all products', async () => {
  test('returns 6 seed products when status=all', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('GET', '/api/products?status=all', { cookie })
    assert.equal(r.status, 200)
    assert.ok(r.json.count >= 6, 'should have at least 6 seed products')
    assert.ok(Array.isArray(r.json.products))
  })
})

describe('Scenario 2: Staff lists active products', async () => {
  test('staff can GET /api/products and sees only active products', async () => {
    const cookie = await login('staff@p5test.local', 'TestStaff123!')
    const r = await apiReq('GET', '/api/products', { cookie })
    assert.equal(r.status, 200)
    assert.ok(r.json.products.every(p => p.is_active), 'all returned products should be active')
  })
})

describe('Scenario 3: Admin creates a new product', async () => {
  test('POST /api/products creates product and returns 201', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/products', {
      cookie,
      body: { name: 'P5 Test Product', category: 'cut', notes: 'created in test' },
    })
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.product.name, 'P5 Test Product')
    assert.equal(r.json.product.category, 'cut')
    assert.ok(r.json.product.id)
    testProductId = r.json.product.id

    // Patch seed_key so after() cleanup finds it
    await pool.query(`UPDATE products SET seed_key = 'p5test_main' WHERE id = $1`, [testProductId])
  })
})

describe('Scenario 4: Empty name is rejected', async () => {
  test('returns 400 when name is blank', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/products', {
      cookie,
      body: { name: '   ', category: 'cut' },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.name)
  })
})

describe('Scenario 5: Invalid category is rejected', async () => {
  test('returns 400 when category is not whole|cut|offal', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/products', {
      cookie,
      body: { name: 'ValidName', category: 'invalid_cat' },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.category)
  })
})

describe('Scenario 6: Admin deactivates a product', async () => {
  test('PATCH /status sets is_active=false', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('PATCH', `/api/products/${testProductId}/status`, {
      cookie,
      body: { is_active: false },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.product.is_active, false)
  })
})

describe('Scenario 7: Deactivated product excluded from active list', async () => {
  test('deactivated product not returned in default (active) listing', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('GET', '/api/products', { cookie })  // default: status=active
    assert.equal(r.status, 200)
    const found = r.json.products.find(p => p.id === testProductId)
    assert.equal(found, undefined, 'deactivated product should not appear in active list')
  })
})

describe('Scenario 8: Admin re-activates a product', async () => {
  test('PATCH /status sets is_active=true again', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('PATCH', `/api/products/${testProductId}/status`, {
      cookie,
      body: { is_active: true },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.product.is_active, true)
  })
})

describe('Scenario 9: Staff cannot create a product', async () => {
  test('returns 403 Forbidden for staff role', async () => {
    const cookie = await login('staff@p5test.local', 'TestStaff123!')
    const r = await apiReq('POST', '/api/products', {
      cookie,
      body: { name: 'Staff Product Attempt', category: 'cut' },
    })
    assert.equal(r.status, 403)
    assert.equal(r.json.error, 'Forbidden')
  })
})

describe('Scenario 10: Staff cannot deactivate a product', async () => {
  test('returns 403 Forbidden for staff role on status patch', async () => {
    const cookie = await login('staff@p5test.local', 'TestStaff123!')
    const r = await apiReq('PATCH', `/api/products/${testProductId}/status`, {
      cookie,
      body: { is_active: false },
    })
    assert.equal(r.status, 403)
  })
})

describe('Scenario 11: Unauthenticated request to products', async () => {
  test('GET /api/products without cookie returns 401', async () => {
    const r = await apiReq('GET', '/api/products')
    assert.equal(r.status, 401)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// DAILY PRICES
// ══════════════════════════════════════════════════════════════════════════

describe('Scenario 12: Admin sets a price', async () => {
  test('POST /api/daily-prices creates a price record', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/daily-prices', {
      cookie,
      body: {
        product_id:     testProductId,
        effective_date: todayIST(),
        rate_per_kg:    250.50,
      },
    })
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.json)}`)
    assert.equal(Number(r.json.price.rate_per_kg), 250.50)
    // Server returns YYYY-MM-DD via TO_CHAR
    assert.equal(r.json.price.effective_date, todayIST())
  })
})

describe('Scenario 13: Duplicate product+date is rejected', async () => {
  test('second price for same product+date returns 409', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/daily-prices', {
      cookie,
      body: {
        product_id:     testProductId,
        effective_date: todayIST(),
        rate_per_kg:    300,
      },
    })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'Conflict')
  })
})

describe('Scenario 14: Zero price is rejected', async () => {
  test('rate_per_kg = 0 returns 400', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/daily-prices', {
      cookie,
      body: { product_id: testProductId, effective_date: futureDateIST(2), rate_per_kg: 0 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.rate_per_kg)
  })
})

describe('Scenario 15: Negative price is rejected', async () => {
  test('rate_per_kg = -50 returns 400', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/daily-prices', {
      cookie,
      body: { product_id: testProductId, effective_date: futureDateIST(3), rate_per_kg: -50 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.rate_per_kg)
  })
})

describe('Scenario 16: Invalid date format is rejected', async () => {
  test('effective_date = "not-a-date" returns 400', async () => {
    const cookie = await login('admin@p5test.local', 'TestAdmin123!')
    const r = await apiReq('POST', '/api/daily-prices', {
      cookie,
      body: { product_id: testProductId, effective_date: 'not-a-date', rate_per_kg: 250 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.effective_date)
  })
})

describe('Scenario 17: Staff cannot set a price', async () => {
  test('returns 403 for staff role on POST /api/daily-prices', async () => {
    const cookie = await login('staff@p5test.local', 'TestStaff123!')
    const r = await apiReq('POST', '/api/daily-prices', {
      cookie,
      body: { product_id: testProductId, effective_date: futureDateIST(4), rate_per_kg: 200 },
    })
    assert.equal(r.status, 403)
  })
})

describe('Scenario 18: GET /today returns today\'s prices', async () => {
  test('includes the price we just set for testProductId', async () => {
    const cookie = await login('staff@p5test.local', 'TestStaff123!')
    const r = await apiReq('GET', '/api/daily-prices/today', { cookie })
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json.prices))
    const found = r.json.prices.find(p => p.product_id === testProductId)
    assert.ok(found, 'today\'s price for testProductId should appear')
    assert.equal(Number(found.rate_per_kg), 250.50)
  })
})

describe('Scenario 19: GET history returns newest-first order', async () => {
  test('price history for testProductId includes today\'s entry', async () => {
    // Add a future price entry first
    const adminCookie = await login('admin@p5test.local', 'TestAdmin123!')
    await apiReq('POST', '/api/daily-prices', {
      cookie: adminCookie,
      body: { product_id: testProductId, effective_date: futureDateIST(5), rate_per_kg: 260 },
    })

    const cookie = await login('staff@p5test.local', 'TestStaff123!')
    const r = await apiReq('GET', `/api/daily-prices/${testProductId}/history`, { cookie })
    assert.equal(r.status, 200)
    assert.ok(r.json.history.length >= 2, 'should have at least today + future entry')
    // First entry should be the latest (future) date
    assert.ok(
      r.json.history[0].effective_date >= r.json.history[1].effective_date,
      'history should be newest-first'
    )
  })
})

describe('Scenario 20: Past price cannot be deleted', async () => {
  test('DELETE on a past-dated entry returns 409', async () => {
    const adminCookie = await login('admin@p5test.local', 'TestAdmin123!')
    // Insert a past-dated price
    const { rows: [past] } = await pool.query(
      `INSERT INTO daily_prices (product_id, effective_date, rate_per_kg, created_by)
       VALUES ($1, $2, 230.00, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [testProductId, pastDateIST(2), adminUserId]
    )
    // ON CONFLICT DO NOTHING may return no row if already inserted; find it
    let pastId
    if (past?.id) {
      pastId = past.id
    } else {
      const { rows: [existing] } = await pool.query(
        `SELECT id FROM daily_prices WHERE product_id=$1 AND effective_date=$2`,
        [testProductId, pastDateIST(2)]
      )
      pastId = existing?.id
    }
    assert.ok(pastId, 'past price entry should exist in DB')

    const r = await apiReq('DELETE', `/api/daily-prices/${pastId}`, { cookie: adminCookie })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'Conflict')
  })
})

describe('Scenario 21: Future price can be deleted', async () => {
  test('DELETE on a future-dated entry returns 200', async () => {
    const adminCookie = await login('admin@p5test.local', 'TestAdmin123!')
    // Insert a far-future price
    const { rows: [future] } = await pool.query(
      `INSERT INTO daily_prices (product_id, effective_date, rate_per_kg, created_by)
       VALUES ($1, $2, 999.00, $3)
       RETURNING id`,
      [testProductId, futureDateIST(30), adminUserId]
    )

    const r = await apiReq('DELETE', `/api/daily-prices/${future.id}`, { cookie: adminCookie })
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.json)}`)
  })
})

describe('Scenario 22: New price does not alter existing price entries', async () => {
  test('adding a new price for a different date leaves existing prices unchanged', async () => {
    const adminCookie = await login('admin@p5test.local', 'TestAdmin123!')

    // Read today's price before adding new one
    const histBefore = await apiReq('GET', `/api/daily-prices/${testProductId}/history`, { cookie: adminCookie })
    const todayEntry = histBefore.json.history.find(h => h.effective_date === todayIST())
    assert.ok(todayEntry, 'today price entry should exist')
    const originalRate = todayEntry.rate_per_kg

    // Add new price for a different future date
    await apiReq('POST', '/api/daily-prices', {
      cookie: adminCookie,
      body: { product_id: testProductId, effective_date: futureDateIST(10), rate_per_kg: 999 },
    })

    // Verify today's price unchanged
    const histAfter = await apiReq('GET', `/api/daily-prices/${testProductId}/history`, { cookie: adminCookie })
    const todayAfter = histAfter.json.history.find(h => h.effective_date === todayIST())
    assert.equal(todayAfter.rate_per_kg, originalRate, 'today\'s price must not change after adding a new date price')
  })
})
