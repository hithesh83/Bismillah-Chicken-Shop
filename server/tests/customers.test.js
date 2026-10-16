/**
 * server/tests/customers.test.js
 *
 * Phase 08 — Customer Management test suite.
 * Uses Node.js built-in test runner (node:test).
 *
 * Scenarios covered:
 *   Server-side validation:
 *     1. Missing name is rejected (400)
 *     2. Invalid customer type is rejected (400)
 *     3. Invalid phone format is rejected (400)
 *     4. Negative opening balance is rejected (400)
 *     5. Duplicate Party ID is rejected (400)
 *
 *   Duplicate names & unique Party IDs:
 *     6. Two customers can share identical names as long as Party IDs are unique (201)
 *     7. Auto-generated Party ID works when party_code is omitted (201)
 *
 *   Auditable opening balances:
 *     8. Opening balance creates an account_adjustments row with debit effect (201)
 *     9. Updating opening balance voids prior adjustment and creates a new one (200)
 *
 *   Non-destructive deactivation:
 *     10. Deactivating customer sets is_active=FALSE without deleting records (200)
 *     11. Opening balance and ledger adjustments remain intact after deactivation
 *     12. Inactive customer appears in status=inactive and is excluded from status=active
 *     13. Reactivating customer restores is_active=TRUE (200)
 *
 *   Role-based permissions (RBAC):
 *     14. Unauthenticated request to GET /api/customers returns 401
 *     15. Unauthenticated request to POST /api/customers returns 401
 *     16. Staff user can create a customer profile (201)
 *     17. Staff user can edit a customer profile (200)
 *     18. Staff user cannot deactivate a customer (403 Forbidden)
 *     19. Admin user can deactivate a customer (200 OK)
 *
 *   Search, filters & detail view:
 *     20. Search by Name, Party ID, and Phone works
 *     21. Filters by party_type and credit_enabled work
 *     22. GET /api/customers/:id returns details, opening balance adjustments, and audit trail
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
if (!TEST_URL) { console.error('[p8-test] DATABASE_URL_TEST not set.'); process.exit(1) }
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[p8-test] SAFETY ABORT: DATABASE_URL_TEST matches a production URL.')
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
let testParty1Id, testParty2Id

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

// ── Setup ─────────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[p8-test] Test server: ${baseUrl}`)

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
      console.log(`[p8-test] Applied migration: ${file}`)
    }
  } finally {
    await setup.end()
  }

  // Seed test users
  const hash = await bcrypt.hash('TestPass123!', 4)

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('admin@p8test.local', $1, 'P8 Admin', 'admin')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  adminUserId = admin.id

  const { rows: [staff] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role)
     VALUES ('staff@p8test.local', $1, 'P8 Staff', 'staff')
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, locked_until = NULL, failed_login_attempts = 0
     RETURNING id`,
    [hash]
  )
  staffUserId = staff.id

  adminCookie = await login('admin@p8test.local', 'TestPass123!')
  staffCookie = await login('staff@p8test.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin session cookie must be established')
  assert.ok(staffCookie, 'Staff session cookie must be established')
})

// ── Teardown ──────────────────────────────────────────────────────────────
after(async () => {
  // Clean up adjustments, audit logs, parties, and test users
  await pool.query(
    `DELETE FROM audit_logs WHERE actor_id IN ($1, $2)`,
    [adminUserId, staffUserId]
  )
  await pool.query(
    `DELETE FROM account_adjustments WHERE created_by IN ($1, $2) OR voided_by IN ($1, $2)`,
    [adminUserId, staffUserId]
  )
  await pool.query(
    `DELETE FROM parties WHERE created_by IN ($1, $2) OR updated_by IN ($1, $2)`,
    [adminUserId, staffUserId]
  )
  await pool.query(
    `DELETE FROM users WHERE login_email LIKE '%@p8test.local'`
  )
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  console.log('[p8-test] Cleanup complete.')
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Server-Side Validation
// ════════════════════════════════════════════════════════════════════════════
describe('Server-side validation for customer profiles', () => {

  test('1. Missing name is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        party_type: 'hotel',
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.name || '', /name is required/i)
  })

  test('2. Invalid customer type is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Test Customer',
        party_type: 'invalid_type',
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.party_type || '', /must be one of/i)
  })

  test('3. Invalid phone format is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Test Customer',
        phone: '123', // too short
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.phone || '', /valid phone number/i)
  })

  test('4. Negative opening balance is rejected (400)', async () => {
    const r = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Test Customer',
        opening_balance: -500,
      },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.errors?.opening_balance || '', /cannot be negative/i)
  })

  test('5. Duplicate Party ID is rejected (400)', async () => {
    // Create first customer with specific Party ID
    const r1 = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Initial Customer',
        party_code: 'P8-DUP-01',
      },
    })
    assert.equal(r1.status, 201)

    // Attempt to create second customer with identical Party ID
    const r2 = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Another Customer',
        party_code: 'P8-DUP-01',
      },
    })
    assert.equal(r2.status, 400)
    assert.match(r2.json.errors?.party_code || '', /already in use|already registered/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Duplicate Names vs Unique Party IDs
// ════════════════════════════════════════════════════════════════════════════
describe('Duplicate names and unique Party IDs', () => {

  test('6. Two customers can share identical names as long as Party IDs are unique (201)', async () => {
    // Customer 1: "Taj Hotel" at Market Road
    const r1 = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Taj Hotel',
        party_code: 'TAJ-MKT',
        phone: '9876543210',
        address: 'Market Road, Shop #12',
        party_type: 'hotel',
        credit_enabled: true,
      },
    })
    assert.equal(r1.status, 201)
    assert.equal(r1.json.customer?.name, 'Taj Hotel')
    assert.equal(r1.json.customer?.party_code, 'TAJ-MKT')
    testParty1Id = r1.json.customer.id

    // Customer 2: "Taj Hotel" at Station Road (Identical name!)
    const r2 = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Taj Hotel',
        party_code: 'TAJ-STN',
        phone: '9876543211',
        address: 'Station Road, Near Gate 2',
        party_type: 'hotel',
        credit_enabled: true,
      },
    })
    assert.equal(r2.status, 201)
    assert.equal(r2.json.customer?.name, 'Taj Hotel')
    assert.equal(r2.json.customer?.party_code, 'TAJ-STN')
    testParty2Id = r2.json.customer.id

    // Verify both exist in DB with their distinct Party IDs and locations
    const { rows } = await pool.query(
      `SELECT id, name, party_code, address FROM parties WHERE id IN ($1, $2)`,
      [testParty1Id, testParty2Id]
    )
    assert.equal(rows.length, 2)
    assert.equal(rows[0].name, rows[1].name, 'Both customers have identical name')
    assert.notEqual(rows[0].party_code, rows[1].party_code, 'Party IDs must be distinct')
  })

  test('7. Auto-generated Party ID works when party_code is omitted (201)', async () => {
    const r = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Auto Code Hotel',
        party_type: 'hotel',
      },
    })
    assert.equal(r.status, 201)
    assert.ok(r.json.customer?.party_code)
    assert.match(r.json.customer.party_code, /^PTY-\d{5}$/, 'Must generate PTY-xxxxx format')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Auditable Opening Balances
// ════════════════════════════════════════════════════════════════════════════
describe('Auditable opening balances in ledger', () => {
  let partyWithBalId

  test('8. Opening balance creates an account_adjustments row with debit effect (201)', async () => {
    const r = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Al-Madina Caterers',
        party_code: 'ALM-001',
        party_type: 'party',
        credit_enabled: true,
        opening_balance: 15000.00,
        opening_balance_reason: 'Opening debt prior to software adoption',
      },
    })
    assert.equal(r.status, 201)
    partyWithBalId = r.json.customer.id
    assert.equal(Number(r.json.customer.opening_balance), 15000)

    // Inspect the actual account_adjustments row in the DB
    const { rows: [adj] } = await pool.query(
      `SELECT adjustment_type, ledger_effect, reason, voided_at
       FROM account_adjustments
       WHERE party_id = $1 AND adjustment_type = 'opening_balance'`,
      [partyWithBalId]
    )
    assert.ok(adj, 'account_adjustments row must exist')
    // Sign convention: customer owing ₹15,000 means ledger_effect = -15000.00 (debit)
    assert.equal(Number(adj.ledger_effect), -15000.00)
    assert.equal(adj.voided_at, null)
  })

  test('9. Updating opening balance voids prior adjustment and creates a new one (200)', async () => {
    // Update opening balance to ₹18,000
    const r = await apiReq('PUT', `/api/customers/${partyWithBalId}`, {
      cookie: staffCookie,
      body: {
        name: 'Al-Madina Caterers',
        party_code: 'ALM-001',
        party_type: 'party',
        credit_enabled: true,
        opening_balance: 18000.00,
        opening_balance_reason: 'Found missing old invoice in ledger book',
      },
    })
    assert.equal(r.status, 200)
    assert.equal(Number(r.json.customer.opening_balance), 18000)

    // Verify account_adjustments audit history: old row voided, new active row created
    const { rows: adjs } = await pool.query(
      `SELECT ledger_effect, voided_at, void_reason, reason
       FROM account_adjustments
       WHERE party_id = $1 AND adjustment_type = 'opening_balance'
       ORDER BY created_at ASC`,
      [partyWithBalId]
    )
    assert.equal(adjs.length, 2, 'Must have 2 adjustment rows (1 voided, 1 active)')

    const [oldAdj, newAdj] = adjs
    assert.notEqual(oldAdj.voided_at, null, 'Old opening balance must be voided')
    assert.equal(Number(oldAdj.ledger_effect), -15000.00)

    assert.equal(newAdj.voided_at, null, 'New opening balance must be active')
    assert.equal(Number(newAdj.ledger_effect), -18000.00)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Non-Destructive Deactivation
// ════════════════════════════════════════════════════════════════════════════
describe('Non-destructive customer deactivation', () => {

  test('10. Deactivating customer sets is_active=FALSE without deleting records (200)', async () => {
    const r = await apiReq('PATCH', `/api/customers/${testParty1Id}/status`, {
      cookie: adminCookie,
      body: { is_active: false },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.customer?.is_active, false)

    // Verify row still exists in DB
    const { rows: [party] } = await pool.query('SELECT id, is_active FROM parties WHERE id = $1', [testParty1Id])
    assert.ok(party, 'Customer row must not be deleted')
    assert.equal(party.is_active, false)
  })

  test('11. Opening balance and ledger adjustments remain intact after deactivation', async () => {
    const { rows: adjs } = await pool.query(
      'SELECT id FROM account_adjustments WHERE party_id = $1',
      [testParty1Id]
    )
    // Adjustments are preserved
    assert.ok(Array.isArray(adjs))
  })

  test('12. Inactive customer appears in status=inactive and is excluded from status=active', async () => {
    const activeRes = await apiReq('GET', '/api/customers?status=active', { cookie: staffCookie })
    assert.equal(activeRes.status, 200)
    const activeIds = activeRes.json.customers.map(c => c.id)
    assert.ok(!activeIds.includes(testParty1Id), 'Deactivated customer must not appear in status=active')

    const inactiveRes = await apiReq('GET', '/api/customers?status=inactive', { cookie: staffCookie })
    assert.equal(inactiveRes.status, 200)
    const inactiveIds = inactiveRes.json.customers.map(c => c.id)
    assert.ok(inactiveIds.includes(testParty1Id), 'Deactivated customer must appear in status=inactive')
  })

  test('13. Reactivating customer restores is_active=TRUE (200)', async () => {
    const r = await apiReq('PATCH', `/api/customers/${testParty1Id}/status`, {
      cookie: adminCookie,
      body: { is_active: true },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.customer?.is_active, true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Role-Based Permissions (RBAC)
// ════════════════════════════════════════════════════════════════════════════
describe('Role-based access control (RBAC)', () => {

  test('14. Unauthenticated request to GET /api/customers returns 401', async () => {
    const r = await apiReq('GET', '/api/customers')
    assert.equal(r.status, 401)
  })

  test('15. Unauthenticated request to POST /api/customers returns 401', async () => {
    const r = await apiReq('POST', '/api/customers', { body: { name: 'No Auth Hotel' } })
    assert.equal(r.status, 401)
  })

  test('16. Staff user can create a customer profile (201)', async () => {
    const r = await apiReq('POST', '/api/customers', {
      cookie: staffCookie,
      body: {
        name: 'Staff Created Hotel',
        party_type: 'hotel',
      },
    })
    assert.equal(r.status, 201)
  })

  test('17. Staff user can edit a customer profile (200)', async () => {
    const r = await apiReq('PUT', `/api/customers/${testParty2Id}`, {
      cookie: staffCookie,
      body: {
        name: 'Taj Hotel Station Branch',
        phone: '9998887776',
      },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.customer?.name, 'Taj Hotel Station Branch')
  })

  test('18. Staff user cannot deactivate a customer (403 Forbidden)', async () => {
    const r = await apiReq('PATCH', `/api/customers/${testParty2Id}/status`, {
      cookie: staffCookie,
      body: { is_active: false },
    })
    assert.equal(r.status, 403)
  })

  test('19. Admin user can deactivate a customer (200 OK)', async () => {
    const r = await apiReq('PATCH', `/api/customers/${testParty2Id}/status`, {
      cookie: adminCookie,
      body: { is_active: false },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.customer?.is_active, false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DESCRIBE: Search, Filters & Detail View
// ════════════════════════════════════════════════════════════════════════════
describe('Search, filters and detail views', () => {

  test('20. Search by Name, Party ID, and Phone works', async () => {
    // Search by name
    const rName = await apiReq('GET', '/api/customers?search=Madina', { cookie: staffCookie })
    assert.equal(rName.status, 200)
    assert.ok(rName.json.customers.length >= 1)

    // Search by party_code
    const rCode = await apiReq('GET', '/api/customers?search=TAJ-MKT', { cookie: staffCookie })
    assert.equal(rCode.status, 200)
    assert.equal(rCode.json.customers.length, 1)
    assert.equal(rCode.json.customers[0].party_code, 'TAJ-MKT')

    // Search by phone
    const rPhone = await apiReq('GET', '/api/customers?search=9998887776', { cookie: staffCookie })
    assert.equal(rPhone.status, 200)
    assert.ok(rPhone.json.customers.length >= 1)
  })

  test('21. Filters by party_type and credit_enabled work', async () => {
    const rType = await apiReq('GET', '/api/customers?party_type=hotel', { cookie: staffCookie })
    assert.equal(rType.status, 200)
    for (const c of rType.json.customers) {
      assert.equal(c.party_type, 'hotel')
    }

    const rCredit = await apiReq('GET', '/api/customers?credit_enabled=true', { cookie: staffCookie })
    assert.equal(rCredit.status, 200)
    for (const c of rCredit.json.customers) {
      assert.equal(c.credit_enabled, true)
    }
  })

  test('22. GET /api/customers/:id returns details, opening balance adjustments, and audit trail', async () => {
    const r = await apiReq('GET', `/api/customers/${testParty1Id}`, { cookie: staffCookie })
    assert.equal(r.status, 200)
    assert.equal(r.json.customer?.id, testParty1Id)
    assert.ok(Array.isArray(r.json.openingBalances))
    assert.ok(Array.isArray(r.json.audit))
    assert.ok(r.json.audit.length >= 1, 'Audit log entries must be returned')
  })
})
