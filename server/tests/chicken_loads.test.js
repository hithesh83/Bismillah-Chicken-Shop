/**
 * server/tests/chicken_loads.test.js
 *
 * Phase 06 — Chicken Loads test suite.
 * Uses Node.js built-in test runner (node:test).
 *
 * SAFETY:
 *   - Uses DATABASE_URL_TEST (local bismillah_test DB) — never production
 *   - Starts Express app on a random port
 *   - All test data scoped to '@p6test.local' emails
 *   - Full cleanup in after() hook
 *
 * Scenarios covered (must all pass before Phase 06 is complete):
 *
 *   Wastage calculation:
 *     1.  Exact wastage: 500 kg live / 380 kg dressed = 24.0000% (spec requirement)
 *     2.  Wastage with rounding: 300 kg live / 200 kg dressed = 33.3333%
 *
 *   Zero / negative weight guards:
 *     3.  Zero live weight is rejected (400) — prevents division-by-zero
 *     4.  Negative live weight is rejected (400)
 *     5.  Negative dressed weight is rejected (400)
 *     6.  Negative remaining stock is rejected (400)
 *     7.  Dressed weight exceeding live weight is rejected (400)
 *
 *   Successful creation:
 *     8.  Admin can create a load (201)
 *     9.  Staff can create a load (201)
 *     10. Load date validation — missing date is rejected (400)
 *     11. Created load appears in GET list
 *     12. GET /:id returns correct load detail + empty audit initially (wait — audit is written on create)
 *
 *   Remaining stock:
 *     13. Staff can update remaining stock via PATCH /:id/stock (200)
 *     14. Negative remaining stock on PATCH is rejected (400)
 *     15. Missing remaining_stock_kg on PATCH is rejected (400)
 *
 *   Role enforcement:
 *     16. Unauthenticated request to GET / returns 401
 *     17. Unauthenticated request to POST / returns 401
 *     18. Admin-only correction: Staff cannot POST /:id/correct (403)
 *     19. Admin can POST /:id/correct with valid data (201)
 *     20. Correction requires non-empty correction_reason (400)
 *
 *   Audit trail:
 *     21. GET /:id shows CREATE audit entry after load creation
 *     22. GET /:id shows UPDATE audit entry after stock update
 *     23. GET /:id shows CORRECT audit entry after admin correction
 *
 *   Filters:
 *     24. ?from and ?to date filters work correctly
 *     25. ?load_number partial search filter works
 */

// Load .env from project root (two levels up from server/tests/)
import dotenv from 'dotenv'
dotenv.config({ path: new URL('../../.env', import.meta.url) })

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import bcrypt from 'bcryptjs'
import pg from 'pg'

// ── Safety guard ──────────────────────────────────────────────────────────
const TEST_URL = process.env.DATABASE_URL_TEST
if (!TEST_URL) { console.error('[p6-test] DATABASE_URL_TEST not set.'); process.exit(1) }
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p6-test] SAFETY ABORT: DATABASE_URL_TEST matches a production URL.')
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
let adminUserId, staffUserId
let adminCookie, staffCookie
let testLoadId         // created in test 8, used in later tests
let correctionLoadId   // created in test 19

// ── Helpers ───────────────────────────────────────────────────────────────
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

function pastDateIST(daysBack = 7) {
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function futureDateIST(daysAhead = 3) {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

// ── Setup ─────────────────────────────────────────────────────────────────
before(async () => {
  // Start server on random port
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p6-test] Test server: ${baseUrl}`)

  // Apply migrations to the test database
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
    // Ensure the tracking table exists (uses 'version' column, matching migrate.js)
    await setup.query('BEGIN')
    await setup.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT        PRIMARY KEY,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await setup.query('COMMIT')

    // Apply each migration file if not already applied
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort()

    const { rows: appliedRows } = await setup.query('SELECT version FROM schema_migrations')
    const applied = new Set(appliedRows.map(r => r.version))

    for (const file of files) {
      if (applied.has(file)) continue   // already applied

      const sql      = readFileSync(resolve(migrationsDir, file), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')

      await setup.query('BEGIN')
      await setup.query(sql)
      await setup.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [file, checksum]
      )
      await setup.query('COMMIT')
      console.log(`[p6-test] Applied migration: ${file}`)
    }
  } finally {
    await setup.end()
  }

  // Seed test users (login_email is the column name; no is_locked column)
  const hash = await bcrypt.hash('TestPass123!', 4)  // low rounds for speed in tests

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('admin@p6test.local', $1, 'P6 Admin', 'admin')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('staff@p6test.local', $1, 'P6 Staff', 'staff')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  staffUserId = staff.id

  // Log in both users to get session cookies
  adminCookie = await login('admin@p6test.local', 'TestPass123!')
  staffCookie = await login('staff@p6test.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin cookie must be set')
  assert.ok(staffCookie, 'Staff cookie must be set')
})

// ── Teardown ──────────────────────────────────────────────────────────────
after(async () => {
  // Remove all chicken_loads and audit entries created by the test users
  if (correctionLoadId) {
    await pool.query('DELETE FROM audit_logs WHERE entity_id = $1', [correctionLoadId])
    await pool.query('DELETE FROM chicken_loads WHERE id = $1', [correctionLoadId])
  }
  if (testLoadId) {
    await pool.query('DELETE FROM audit_logs WHERE entity_id = $1', [testLoadId])
    await pool.query('DELETE FROM chicken_loads WHERE id = $1', [testLoadId])
  }
  // Remove any remaining loads created by test users (wastage calc tests, etc.)
  await pool.query(
    `DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`,
    [adminUserId, staffUserId]
  )
  await pool.query(
    `DELETE FROM chicken_loads WHERE created_by IN ($1, $2)`,
    [adminUserId, staffUserId]
  )
  await pool.query(
    `DELETE FROM users WHERE login_email LIKE '%@p6test.local'`
  )
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  console.log('[p6-test] Cleanup complete.')
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Wastage Calculation
// ════════════════════════════════════════════════════════════════════════════
describe('Wastage calculation', () => {

  test('1. Exact wastage: 500 kg live / 380 kg dressed = 24.0000%', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:        todayIST(),
        live_weight_kg:   500,
        dressed_weight_kg: 380,
      },
    })
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.json)}`)
    const load = r.json.load
    // wastage = ((500 - 380) / 500) * 100 = 24.0000
    assert.equal(
      Number(load.wastage_pct).toFixed(4),
      '24.0000',
      `Expected wastage_pct = 24.0000, got ${load.wastage_pct}`
    )
    // Clean up this specific test load so it doesn't pollute later filter tests
    await pool.query('DELETE FROM audit_logs WHERE entity_id = $1', [load.id])
    await pool.query('DELETE FROM chicken_loads WHERE id = $1', [load.id])
  })

  test('2. Wastage with rounding: 300 kg live / 200 kg dressed = 33.3333%', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:        todayIST(),
        live_weight_kg:   300,
        dressed_weight_kg: 200,
      },
    })
    assert.equal(r.status, 201)
    // wastage = ((300 - 200) / 300) * 100 = 33.3333...
    assert.equal(Number(r.json.load.wastage_pct).toFixed(4), '33.3333')
    await pool.query('DELETE FROM audit_logs WHERE entity_id = $1', [r.json.load.id])
    await pool.query('DELETE FROM chicken_loads WHERE id = $1', [r.json.load.id])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Zero / Negative Weight Guards
// ════════════════════════════════════════════════════════════════════════════
describe('Zero and negative weight guards', () => {

  test('3. Zero live weight is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: todayIST(), live_weight_kg: 0, dressed_weight_kg: 0 },
    })
    assert.equal(r.status, 400, `Expected 400 for zero live weight, got ${r.status}`)
    assert.ok(r.json.errors?.live_weight_kg, 'Should have error on live_weight_kg field')
  })

  test('4. Negative live weight is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: todayIST(), live_weight_kg: -100, dressed_weight_kg: 50 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.live_weight_kg)
  })

  test('5. Negative dressed weight is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: todayIST(), live_weight_kg: 500, dressed_weight_kg: -50 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.dressed_weight_kg)
  })

  test('6. Negative remaining stock is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:         todayIST(),
        live_weight_kg:    500,
        dressed_weight_kg: 380,
        remaining_stock_kg: -10,
      },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.remaining_stock_kg)
  })

  test('7. Dressed weight exceeding live weight is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { load_date: todayIST(), live_weight_kg: 300, dressed_weight_kg: 400 },
    })
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`)
    assert.ok(r.json.errors?.dressed_weight_kg, 'Should have error on dressed_weight_kg field')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Successful Creation
// ════════════════════════════════════════════════════════════════════════════
describe('Successful load creation', () => {

  test('8. Admin can create a load (201)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: {
        load_date:         pastDateIST(3),
        supplier_ref:      'SUP-001',
        live_weight_kg:    400,
        dressed_weight_kg: 320,
        remaining_stock_kg: 300,
        notes:             'P6 admin test load',
      },
    })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.ok(r.json.load?.id, 'Should return load with id')
    assert.ok(r.json.load?.load_number?.startsWith('LD-'), 'load_number should start with LD-')
    // Save id for later tests
    testLoadId = r.json.load.id
    console.log(`  [p6-test] Created test load: ${r.json.load.load_number} (id=${testLoadId})`)
  })

  test('9. Staff can create a load (201)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: staffCookie,
      body: {
        load_date:         pastDateIST(2),
        live_weight_kg:    250,
        dressed_weight_kg: 200,
        notes:             'P6 staff test load',
      },
    })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.ok(r.json.load?.id)
    // Clean up staff load right away
    const staffLoadId = r.json.load.id
    await pool.query('DELETE FROM audit_logs WHERE entity_id = $1', [staffLoadId])
    await pool.query('DELETE FROM chicken_loads WHERE id = $1', [staffLoadId])
  })

  test('10. Missing load_date is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      cookie: adminCookie,
      body: { live_weight_kg: 500, dressed_weight_kg: 380 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.load_date)
  })

  test('11. Created load appears in GET list', async () => {
    const r = await apiReq('GET', '/api/chicken-loads', { cookie: adminCookie })
    assert.equal(r.status, 200)
    const ids = r.json.loads.map(l => l.id)
    assert.ok(ids.includes(testLoadId), 'Test load should appear in GET list')
  })

  test('12. GET /:id returns correct load detail with CREATE audit entry', async () => {
    const r = await apiReq('GET', `/api/chicken-loads/${testLoadId}`, { cookie: adminCookie })
    assert.equal(r.status, 200)
    assert.equal(r.json.load.id, testLoadId)
    assert.ok(Array.isArray(r.json.corrections))
    assert.ok(Array.isArray(r.json.audit))
    // The CREATE audit entry was written in the same transaction as load creation
    const createEntry = r.json.audit.find(a => a.action_type === 'CREATE')
    assert.ok(createEntry, 'Should have a CREATE audit entry')
    assert.equal(createEntry.actor_name, 'P6 Admin')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Remaining Stock
// ════════════════════════════════════════════════════════════════════════════
describe('Remaining stock manual updates', () => {

  test('13. Staff can update remaining stock via PATCH /:id/stock (200)', async () => {
    const r = await apiReq('PATCH', `/api/chicken-loads/${testLoadId}/stock`, {
      cookie: staffCookie,
      body: { remaining_stock_kg: 150.5, notes: 'counted after morning sales' },
    })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(Number(r.json.load.remaining_stock_kg).toFixed(3), '150.500')
  })

  test('14. Negative remaining stock on PATCH is rejected (400)', async () => {
    const r = await apiReq('PATCH', `/api/chicken-loads/${testLoadId}/stock`, {
      cookie: staffCookie,
      body: { remaining_stock_kg: -5 },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.remaining_stock_kg)
  })

  test('15. Missing remaining_stock_kg on PATCH is rejected (400)', async () => {
    const r = await apiReq('PATCH', `/api/chicken-loads/${testLoadId}/stock`, {
      cookie: staffCookie,
      body: {},
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.remaining_stock_kg)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Role enforcement
// ════════════════════════════════════════════════════════════════════════════
describe('Role enforcement', () => {

  test('16. Unauthenticated GET / returns 401', async () => {
    const r = await apiReq('GET', '/api/chicken-loads')
    assert.equal(r.status, 401)
  })

  test('17. Unauthenticated POST / returns 401', async () => {
    const r = await apiReq('POST', '/api/chicken-loads', {
      body: { load_date: todayIST(), live_weight_kg: 100, dressed_weight_kg: 80 },
    })
    assert.equal(r.status, 401)
  })

  test('18. Staff cannot POST /:id/correct (403)', async () => {
    const r = await apiReq('POST', `/api/chicken-loads/${testLoadId}/correct`, {
      cookie: staffCookie,
      body: {
        load_date:         todayIST(),
        live_weight_kg:    410,
        dressed_weight_kg: 330,
        correction_reason: 'staff trying to correct',
      },
    })
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`)
  })

  test('19. Admin can POST /:id/correct with valid data (201)', async () => {
    const r = await apiReq('POST', `/api/chicken-loads/${testLoadId}/correct`, {
      cookie: adminCookie,
      body: {
        load_date:         pastDateIST(3),
        live_weight_kg:    410,
        dressed_weight_kg: 328,
        correction_reason: 'Scale recalibrated — corrected live weight',
      },
    })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.ok(r.json.correction?.id)
    assert.equal(r.json.correction.is_correction, true)
    correctionLoadId = r.json.correction.id
  })

  test('20. Correction requires non-empty correction_reason (400)', async () => {
    const r = await apiReq('POST', `/api/chicken-loads/${testLoadId}/correct`, {
      cookie: adminCookie,
      body: {
        load_date:         todayIST(),
        live_weight_kg:    410,
        dressed_weight_kg: 328,
        correction_reason: '   ', // whitespace only
      },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.correction_reason)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Audit trail
// ════════════════════════════════════════════════════════════════════════════
describe('Audit trail', () => {

  test('21. GET /:id shows CREATE audit entry after load creation', async () => {
    const r = await apiReq('GET', `/api/chicken-loads/${testLoadId}`, { cookie: adminCookie })
    assert.equal(r.status, 200)
    const createEntry = r.json.audit.find(a => a.action_type === 'CREATE')
    assert.ok(createEntry, 'CREATE audit entry should exist')
    const meta = createEntry.change_metadata
    assert.ok(meta.load_number, 'Audit metadata should contain load_number')
    assert.equal(Number(meta.live_weight_kg), 400)
    assert.equal(Number(meta.dressed_weight_kg), 320)
  })

  test('22. GET /:id shows UPDATE audit entry after stock update', async () => {
    const r = await apiReq('GET', `/api/chicken-loads/${testLoadId}`, { cookie: adminCookie })
    assert.equal(r.status, 200)
    const updateEntry = r.json.audit.find(a => a.action_type === 'UPDATE')
    assert.ok(updateEntry, 'UPDATE audit entry should exist')
    const meta = updateEntry.change_metadata
    assert.equal(meta.field, 'remaining_stock_kg')
    assert.equal(Number(meta.after), 150.5)
  })

  test('23. GET /:id shows CORRECT audit entry after admin correction', async () => {
    const r = await apiReq('GET', `/api/chicken-loads/${testLoadId}`, { cookie: adminCookie })
    assert.equal(r.status, 200)
    const correctEntry = r.json.audit.find(a => a.action_type === 'CORRECT')
    assert.ok(correctEntry, 'CORRECT audit entry should exist')
    const meta = correctEntry.change_metadata
    assert.ok(meta.correction_reason, 'Audit metadata should include correction_reason')
    assert.ok(meta.correction_load_id, 'Audit metadata should include correction_load_id')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Filters
// ════════════════════════════════════════════════════════════════════════════
describe('Filters and search', () => {

  test('24. Date range filter (?from & ?to) works', async () => {
    const from = pastDateIST(10)
    const to   = pastDateIST(1)
    const r    = await apiReq('GET', `/api/chicken-loads?from=${from}&to=${to}`, {
      cookie: adminCookie,
    })
    assert.equal(r.status, 200)
    // All returned loads should fall within the range
    for (const load of r.json.loads) {
      assert.ok(
        load.load_date >= from && load.load_date <= to,
        `Load date ${load.load_date} should be between ${from} and ${to}`
      )
    }
  })

  test('25. ?load_number partial search returns correct results', async () => {
    // First get the load_number of our test load
    const detailRes = await apiReq('GET', `/api/chicken-loads/${testLoadId}`, {
      cookie: adminCookie,
    })
    const loadNumber = detailRes.json.load.load_number  // e.g. 'LD-00042'

    // Search by partial load number (last 3 digits)
    const partial = loadNumber.slice(-3)  // e.g. '042'
    const r = await apiReq('GET', `/api/chicken-loads?load_number=${partial}`, {
      cookie: adminCookie,
    })
    assert.equal(r.status, 200)
    const ids = r.json.loads.map(l => l.id)
    assert.ok(ids.includes(testLoadId), 'Test load should appear in filtered results')
  })
})
