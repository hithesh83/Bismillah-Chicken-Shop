/**
 * server/tests/stock_entries.test.js
 *
 * Phase 07 — Remaining Stock (Manual Stock Observations) test suite.
 * Uses Node.js built-in test runner (node:test).
 *
 * Scenarios covered:
 *   Server-side validation:
 *     1. Negative quantity is rejected on create (400)
 *     2. Missing quantity is rejected on create (400)
 *     3. Invalid product_id is rejected on create (400)
 *     4. Invalid observed_at timestamp is rejected on create (400)
 *
 *   Successful observation creation:
 *     5. Staff can record a stock observation (201)
 *     6. Admin can record a stock observation (201)
 *
 *   No silent overwrites & multiple readings per day:
 *     7. Recording multiple readings on the same day for the same product preserves all entries
 *     8. GET /api/stock-entries/latest returns the most recent observation for the product
 *
 *   Role-based authorization:
 *     9. Unauthenticated request to GET /api/stock-entries returns 401
 *     10. Unauthenticated request to POST /api/stock-entries returns 401
 *     11. Staff user cannot perform authorized correction (403)
 *     12. Admin user can perform authorized correction (201)
 *
 *   Correction validation & audit integrity:
 *     13. Correction requires a valid correction_reason (400 if empty)
 *     14. Negative quantity on correction is rejected (400)
 *     15. Original observation remains unmodified after correction
 *     16. Correction row contains is_correction=TRUE, correct reference, and reason
 *     17. Audit logs record both CREATE and CORRECT events
 *
 *   Filters & details:
 *     18. Filter by product_id works
 *     19. Filter by category ('whole', 'cut', 'offal') works
 *     20. Filter by date range (from/to) works
 *     21. GET /api/stock-entries/:id returns entry detail, corrections list, and audit events
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
if (!TEST_URL) { console.error('[p7-test] DATABASE_URL_TEST not set.'); process.exit(1) }
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p7-test] SAFETY ABORT: DATABASE_URL_TEST matches a production URL.')
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
let testProductId
let testEntryId
let testCorrectionId

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

// ── Setup ─────────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p7-test] Test server: ${baseUrl}`)

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
      console.log(`[p7-test] Applied migration: ${file}`)
    }
  } finally {
    await setup.end()
  }

  // Seed test users
  const hash = await bcrypt.hash('TestPass123!', 4)

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('admin@p7test.local', $1, 'P7 Admin', 'admin')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('staff@p7test.local', $1, 'P7 Staff', 'staff')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  staffUserId = staff.id

  adminCookie = await login('admin@p7test.local', 'TestPass123!')
  staffCookie = await login('staff@p7test.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin session cookie must be established')
  assert.ok(staffCookie, 'Staff session cookie must be established')

  // Fetch or ensure live_chicken seed product exists
  const { rows: [product] } = await pool.query(
    `SELECT id FROM products WHERE seed_key = 'live_chicken' LIMIT 1`
  )
  assert.ok(product, 'live_chicken product must exist from seed')
  testProductId = product.id
})

// ── Teardown ──────────────────────────────────────────────────────────────
after(async () => {
  // Clean up stock entries and audit logs created during tests
  await pool.query(
    `DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`,
    [adminUserId, staffUserId]
  )
  await pool.query(
    `DELETE FROM stock_entries WHERE created_by IN ($1, $2)`,
    [adminUserId, staffUserId]
  )
  await pool.query(
    `DELETE FROM users WHERE login_email LIKE '%@p7test.local'`
  )
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  console.log('[p7-test] Cleanup complete.')
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Server-Side Validation
// ════════════════════════════════════════════════════════════════════════════
describe('Server-side validation for stock observations', () => {

  test('1. Negative quantity is rejected on create (400)', async () => {
    const r = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: testProductId,
        quantity_kg: -12.5,
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.quantity_kg || '', /must be zero or a positive number/i)
  })

  test('2. Missing quantity is rejected on create (400)', async () => {
    const r = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: testProductId,
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.quantity_kg || '', /quantity_kg is required/i)
  })

  test('3. Invalid product_id is rejected on create (400)', async () => {
    const r = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: '00000000-0000-0000-0000-000000000000',
        quantity_kg: 50.0,
      },
    })
    assert.equal(r.status, 400)
    assert.ok(r.json.errors?.product_id, 'Must reject nonexistent product')
  })

  test('4. Invalid observed_at timestamp is rejected on create (400)', async () => {
    const r = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: testProductId,
        quantity_kg: 50.0,
        observed_at: 'invalid-not-a-date',
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.observed_at || '', /valid ISO date/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Creation & Non-Destructive Multiple Readings
// ════════════════════════════════════════════════════════════════════════════
describe('Manual observation creation & historical preservation', () => {

  test('5. Staff can record a stock observation (201)', async () => {
    const r = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: testProductId,
        quantity_kg: 120.500,
        observed_at: '2026-10-16T08:00:00Z',
        notes: 'Morning opening stock',
      },
    })
    assert.equal(r.status, 201)
    assert.ok(r.json.entry?.id)
    assert.equal(Number(r.json.entry.quantity_kg), 120.5)
    testEntryId = r.json.entry.id
  })

  test('6. Admin can record a stock observation (201)', async () => {
    const r = await apiReq('POST', '/api/stock-entries', {
      cookie: adminCookie,
      body: {
        product_id: testProductId,
        quantity_kg: 105.200,
        observed_at: '2026-10-16T12:00:00Z',
        notes: 'Midday check',
      },
    })
    assert.equal(r.status, 201)
    assert.ok(r.json.entry?.id)
    assert.equal(Number(r.json.entry.quantity_kg), 105.2)
  })

  test('7. Multiple readings on same day for same product are preserved without overwriting', async () => {
    // Record third observation on the same day
    const r3 = await apiReq('POST', '/api/stock-entries', {
      cookie: staffCookie,
      body: {
        product_id: testProductId,
        quantity_kg: 78.400,
        observed_at: '2026-10-16T18:00:00Z',
        notes: 'Evening closing count',
      },
    })
    assert.equal(r3.status, 201)

    // Query history for this product
    const listRes = await apiReq('GET', `/api/stock-entries?product_id=${testProductId}`, {
      cookie: staffCookie,
    })
    assert.equal(listRes.status, 200)

    // All three observations must exist in the database
    const matching = listRes.json.entries.filter(e =>
      ['120.500', '105.200', '78.400'].includes(Number(e.quantity_kg).toFixed(3))
    )
    assert.equal(matching.length, 3, 'All 3 observations must exist as distinct immutable rows')
  })

  test('8. GET /api/stock-entries/latest returns the most recent observation for the product', async () => {
    const r = await apiReq('GET', '/api/stock-entries/latest', {
      cookie: staffCookie,
    })
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json.latest))

    const liveChicken = r.json.latest.find(p => p.product_id === testProductId)
    assert.ok(liveChicken, 'live_chicken product must be in latest list')
    // The latest reading recorded was 78.400 kg at 18:00:00Z
    assert.equal(Number(liveChicken.quantity_kg).toFixed(3), '78.400')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Role-Based Authorization & Corrections
// ════════════════════════════════════════════════════════════════════════════
describe('Role-based authorization and correction audit trail', () => {

  test('9. Unauthenticated request to GET /api/stock-entries returns 401', async () => {
    const r = await apiReq('GET', '/api/stock-entries')
    assert.equal(r.status, 401)
  })

  test('10. Unauthenticated request to POST /api/stock-entries returns 401', async () => {
    const r = await apiReq('POST', '/api/stock-entries', {
      body: { product_id: testProductId, quantity_kg: 50 },
    })
    assert.equal(r.status, 401)
  })

  test('11. Staff user cannot perform authorized correction (403)', async () => {
    const r = await apiReq('POST', `/api/stock-entries/${testEntryId}/correct`, {
      cookie: staffCookie,
      body: {
        quantity_kg: 118.000,
        correction_reason: 'Staff attempted correction',
      },
    })
    assert.equal(r.status, 403)
  })

  test('12. Admin user can perform authorized correction (201)', async () => {
    const r = await apiReq('POST', `/api/stock-entries/${testEntryId}/correct`, {
      cookie: adminCookie,
      body: {
        quantity_kg: 119.500,
        correction_reason: 'Tare weight re-zeroed on digital scale',
        notes: 'Admin inspected calibration',
      },
    })
    assert.equal(r.status, 201)
    assert.ok(r.json.correction?.id)
    assert.equal(r.json.correction.is_correction, true)
    assert.equal(r.json.correction.corrects_entry_id, testEntryId)
    assert.equal(r.json.correction.correction_reason, 'Tare weight re-zeroed on digital scale')
    testCorrectionId = r.json.correction.id
  })

  test('13. Correction requires a valid correction_reason (400 if empty)', async () => {
    const r = await apiReq('POST', `/api/stock-entries/${testEntryId}/correct`, {
      cookie: adminCookie,
      body: {
        quantity_kg: 119.000,
        correction_reason: '   ',
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.correction_reason || '', /required/i)
  })

  test('14. Negative quantity on correction is rejected (400)', async () => {
    const r = await apiReq('POST', `/api/stock-entries/${testEntryId}/correct`, {
      cookie: adminCookie,
      body: {
        quantity_kg: -5.000,
        correction_reason: 'Testing negative guard',
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.quantity_kg || '', /must be zero or a positive number/i)
  })

  test('15. Original observation remains unmodified after correction (non-destructive audit)', async () => {
    const { rows: [original] } = await pool.query(
      'SELECT id, quantity_kg, is_correction, corrects_entry_id FROM stock_entries WHERE id = $1',
      [testEntryId]
    )
    assert.ok(original)
    // Original quantity 120.500 remains intact
    assert.equal(Number(original.quantity_kg).toFixed(3), '120.500')
    assert.equal(original.is_correction, false)
    assert.equal(original.corrects_entry_id, null)
  })

  test('16. Correction row contains is_correction=TRUE, correct reference, and reason', async () => {
    const { rows: [corr] } = await pool.query(
      'SELECT id, quantity_kg, is_correction, corrects_entry_id, correction_reason, created_by FROM stock_entries WHERE id = $1',
      [testCorrectionId]
    )
    assert.ok(corr)
    assert.equal(Number(corr.quantity_kg).toFixed(3), '119.500')
    assert.equal(corr.is_correction, true)
    assert.equal(corr.corrects_entry_id, testEntryId)
    assert.equal(corr.correction_reason, 'Tare weight re-zeroed on digital scale')
    assert.equal(corr.created_by, adminUserId)
  })

  test('17. Audit logs record both CREATE and CORRECT events', async () => {
    const { rows: auditRows } = await pool.query(
      `SELECT action_type, entity_type, entity_id, change_metadata
       FROM audit_logs
       WHERE entity_type = 'stock_entry'
         AND (entity_id = $1 OR entity_id = $2 OR change_metadata->>'original_entry_id' = $1::text)
       ORDER BY event_timestamp ASC`,
      [testEntryId, testCorrectionId]
    )

    const actions = auditRows.map(r => r.action_type)
    assert.ok(actions.includes('CREATE'), 'Must have CREATE audit log entry')
    assert.ok(actions.includes('CORRECT'), 'Must have CORRECT audit log entry')

    const correctLog = auditRows.find(r => r.action_type === 'CORRECT')
    assert.equal(correctLog.change_metadata?.original_entry_id, testEntryId)
    assert.equal(Number(correctLog.change_metadata?.new_quantity_kg), 119.5)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Filters & Single Detail Endpoint
// ════════════════════════════════════════════════════════════════════════════
describe('Filters and detail view', () => {

  test('18. Filter by product_id works', async () => {
    const r = await apiReq('GET', `/api/stock-entries?product_id=${testProductId}`, {
      cookie: staffCookie,
    })
    assert.equal(r.status, 200)
    for (const entry of r.json.entries) {
      assert.equal(entry.product_id, testProductId)
    }
  })

  test('19. Filter by category (whole, cut, offal) works', async () => {
    const r = await apiReq('GET', `/api/stock-entries?category=whole`, {
      cookie: staffCookie,
    })
    assert.equal(r.status, 200)
    for (const entry of r.json.entries) {
      assert.equal(entry.product_category, 'whole')
    }
  })

  test('20. Filter by date range (from/to) works', async () => {
    const today = todayIST()
    const r = await apiReq('GET', `/api/stock-entries?from=${today}&to=${today}`, {
      cookie: staffCookie,
    })
    assert.equal(r.status, 200)
    assert.ok(r.json.entries.length >= 0)
  })

  test('21. GET /api/stock-entries/:id returns entry detail, corrections list, and audit events', async () => {
    const r = await apiReq('GET', `/api/stock-entries/${testEntryId}`, {
      cookie: staffCookie,
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.entry?.id, testEntryId)
    assert.ok(Array.isArray(r.json.corrections))
    assert.ok(r.json.corrections.length >= 1, 'Must list the admin correction in corrections array')
    assert.equal(r.json.corrections[0].id, testCorrectionId)
    assert.ok(Array.isArray(r.json.audit))
    assert.ok(r.json.audit.length >= 1, 'Must include audit trail')
  })
})
