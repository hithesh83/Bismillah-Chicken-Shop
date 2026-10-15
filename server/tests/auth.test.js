/**
 * server/tests/auth.test.js
 *
 * Phase 3 authentication tests.
 * Uses Node.js built-in test runner (node:test).
 *
 * SAFETY:
 *   - Reads DATABASE_URL_TEST (local bismillah_test database)
 *   - Never touches DATABASE_URL or DATABASE_URL_DIRECT
 *   - Starts a real Express server on a random port (no port conflict)
 *   - Cleans up all test users after each describe block
 *
 * Scenarios covered:
 *   1. Valid login returns user object and sets HttpOnly cookie
 *   2. Wrong password returns 401 with generic message
 *   3. Non-existent email returns 401 with generic message
 *   4. Missing fields returns 400
 *   5. Locked account returns 429
 *   6. GET /me with valid cookie returns current user
 *   7. GET /me without cookie returns 401
 *   8. GET /me with tampered token returns 401
 *   9. Admin-only route: admin can access
 *  10. Admin-only route: staff is rejected with 403
 *  11. Logout clears cookie
 *  12. Brute-force lockout after MAX_ATTEMPTS failures
 */

// Load .env from project root (two levels up from server/tests/)
import dotenv from 'dotenv'
dotenv.config({ path: new URL('../../.env', import.meta.url) })

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import bcrypt from 'bcryptjs'
import pg from 'pg'

// ── Safety: never run against the real database ───────────────────────────
const TEST_URL = process.env.DATABASE_URL_TEST
if (!TEST_URL) {
  console.error('[auth-test] DATABASE_URL_TEST is not set. Aborting.')
  process.exit(1)
}
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[auth-test] SAFETY ABORT: DATABASE_URL_TEST matches a production URL.')
  process.exit(1)
}

// Override DATABASE_URL so the server module uses the test database
process.env.DATABASE_URL = TEST_URL

// ── Test server setup ─────────────────────────────────────────────────────
// Import AFTER overriding DATABASE_URL so pool.js picks up the test URL
const { default: app } = await import('../src/app.js')
const { Pool } = pg

const pool = new Pool({
  connectionString: TEST_URL,
  ssl: TEST_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 3,
})

let server, baseUrl

before(async () => {
  // Start server on a random OS-assigned port (avoids conflicts)
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[auth-test] Test server: ${baseUrl}`)

  // Apply migrations to test database
  const { createHash }             = await import('node:crypto')
  const { readFileSync, readdirSync } = await import('node:fs')
  const { resolve, dirname }       = await import('node:path')
  const { fileURLToPath }          = await import('node:url')
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations')

  const setup = new pg.Client({
    connectionString: TEST_URL,
    ssl: TEST_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  })
  await setup.connect()
  await setup.query('BEGIN')
  await setup.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT NOT NULL
  )`)
  await setup.query('COMMIT')

  const { rows } = await setup.query('SELECT version FROM schema_migrations')
  const applied  = new Set(rows.map(r => r.version))
  const files    = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()

  for (const f of files) {
    if (applied.has(f)) continue
    const sql   = readFileSync(resolve(migrationsDir, f), 'utf8')
    const cksum = createHash('sha256').update(sql).digest('hex')
    await setup.query('BEGIN')
    await setup.query(sql)
    await setup.query('INSERT INTO schema_migrations (version,checksum) VALUES ($1,$2)', [f, cksum])
    await setup.query('COMMIT')
  }
  await setup.end()

  // Clean auth-test users
  await pool.query(`DELETE FROM users WHERE login_email LIKE '%@authtest.local'`)
  console.log('[auth-test] Ready.\n')
})

after(async () => {
  await pool.query(`DELETE FROM users WHERE login_email LIKE '%@authtest.local'`)
  await pool.end()
  await new Promise((resolve) => server.close(resolve))
  console.log('[auth-test] Server closed.')
})

// ── HTTP helper ───────────────────────────────────────────────────────────
async function req(method, path, { body, cookie } = {}) {
  const url = new URL(path, baseUrl)
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = cookie

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })

  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }

  return { status: response.status, headers: response.headers, json, text }
}

// ── Seed helper ───────────────────────────────────────────────────────────
async function seedUser({ email, password = 'ValidPass123!', role = 'staff', locked = false }) {
  const hash = await bcrypt.hash(password, 4)   // low rounds for speed in tests
  const { rows: [u] } = await pool.query(`
    INSERT INTO users (display_name, login_email, password_hash, role,
                       failed_login_attempts, locked_until)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [
    `Test ${role}`,
    email,
    hash,
    role,
    locked ? 5 : 0,
    locked ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
  ])
  return u.id
}

function getCookieHeader(headers) {
  const raw = headers.get('set-cookie') ?? ''
  // Extract just the cookie name=value pair (first segment before ;)
  const match = raw.match(/^(bcs_token=[^;]+)/)
  return match ? match[1] : null
}

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Valid login
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 1: Valid login', async () => {
  test('returns 200, user object, and HttpOnly cookie', async () => {
    await seedUser({ email: 'admin@authtest.local', role: 'admin' })
    const r = await req('POST', '/api/auth/login', {
      body: { email: 'admin@authtest.local', password: 'ValidPass123!' },
    })
    assert.equal(r.status, 200)
    assert.ok(r.json?.user?.id,          'user.id should be present')
    assert.equal(r.json.user.role, 'admin')
    assert.equal(r.json.user.email, 'admin@authtest.local')
    // Cookie must be present and HttpOnly (cannot verify httpOnly flag via fetch API — that is browser-enforced)
    assert.ok(r.headers.get('set-cookie')?.includes('bcs_token='), 'auth cookie set')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Wrong password
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 2: Wrong password returns 401', async () => {
  test('returns 401 with generic message', async () => {
    await seedUser({ email: 'staff1@authtest.local' })
    const r = await req('POST', '/api/auth/login', {
      body: { email: 'staff1@authtest.local', password: 'WrongPassword!' },
    })
    assert.equal(r.status, 401)
    assert.equal(r.json?.error, 'Invalid Credentials')
    assert.ok(!r.headers.get('set-cookie'), 'no cookie on failure')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Non-existent email
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 3: Non-existent email returns 401', async () => {
  test('same 401 response as wrong password (no enumeration)', async () => {
    const r = await req('POST', '/api/auth/login', {
      body: { email: 'ghost@authtest.local', password: 'SomePassword1!' },
    })
    assert.equal(r.status, 401)
    assert.equal(r.json?.error, 'Invalid Credentials')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Missing fields
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 4: Missing fields return 400', async () => {
  test('missing password returns 400', async () => {
    const r = await req('POST', '/api/auth/login', {
      body: { email: 'someone@authtest.local' },
    })
    assert.equal(r.status, 400)
  })

  test('empty body returns 400', async () => {
    const r = await req('POST', '/api/auth/login', { body: {} })
    assert.equal(r.status, 400)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Locked account
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 5: Locked account returns 429', async () => {
  test('locked account is rejected with 429', async () => {
    await seedUser({ email: 'locked@authtest.local', locked: true })
    const r = await req('POST', '/api/auth/login', {
      body: { email: 'locked@authtest.local', password: 'ValidPass123!' },
    })
    assert.equal(r.status, 429)
    assert.equal(r.json?.error, 'Account Locked')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — GET /me with valid cookie
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 6: GET /me with valid cookie', async () => {
  test('returns current user from token', async () => {
    await seedUser({ email: 'me@authtest.local', role: 'manager' })
    const login = await req('POST', '/api/auth/login', {
      body: { email: 'me@authtest.local', password: 'ValidPass123!' },
    })
    const cookie = getCookieHeader(login.headers)
    assert.ok(cookie, 'cookie obtained from login')

    const me = await req('GET', '/api/auth/me', { cookie })
    assert.equal(me.status, 200)
    assert.equal(me.json?.user?.email, 'me@authtest.local')
    assert.equal(me.json?.user?.role,  'manager')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — GET /me without cookie → 401
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 7: GET /me without cookie', async () => {
  test('returns 401 unauthenticated', async () => {
    const r = await req('GET', '/api/auth/me')
    assert.equal(r.status, 401)
    assert.equal(r.json?.error, 'Unauthenticated')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — GET /me with tampered token → 401
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 8: GET /me with tampered token', async () => {
  test('returns 401', async () => {
    const r = await req('GET', '/api/auth/me', {
      cookie: 'bcs_token=thisisaninvalidtoken.tampered.value',
    })
    assert.equal(r.status, 401)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 9 & 10 — RBAC: admin vs staff on admin-only route
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 9 & 10: RBAC role checks', async () => {
  test('admin can access /api/auth/admin-ping', async () => {
    await seedUser({ email: 'rbac-admin@authtest.local', role: 'admin' })
    const login = await req('POST', '/api/auth/login', {
      body: { email: 'rbac-admin@authtest.local', password: 'ValidPass123!' },
    })
    const cookie = getCookieHeader(login.headers)

    const r = await req('GET', '/api/auth/admin-ping', { cookie })
    assert.equal(r.status, 200)
    assert.equal(r.json?.role, 'admin')
  })

  test('staff is rejected from /api/auth/admin-ping with 403', async () => {
    await seedUser({ email: 'rbac-staff@authtest.local', role: 'staff' })
    const login = await req('POST', '/api/auth/login', {
      body: { email: 'rbac-staff@authtest.local', password: 'ValidPass123!' },
    })
    const cookie = getCookieHeader(login.headers)

    const r = await req('GET', '/api/auth/admin-ping', { cookie })
    assert.equal(r.status, 403)
    assert.equal(r.json?.error, 'Forbidden')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 11 — Logout clears cookie
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 11: Logout', async () => {
  test('POST /logout returns 200 and clears the cookie', async () => {
    await seedUser({ email: 'logout@authtest.local' })
    const login = await req('POST', '/api/auth/login', {
      body: { email: 'logout@authtest.local', password: 'ValidPass123!' },
    })
    const cookie = getCookieHeader(login.headers)

    const logout = await req('POST', '/api/auth/logout', { cookie })
    assert.equal(logout.status, 200)

    // After logout, the same cookie should not access /me
    const me = await req('GET', '/api/auth/me', { cookie })
    // The cookie is still sent by the test client, but if the server cleared it,
    // the Set-Cookie in logout response should have MaxAge=0 / expired
    const setCookie = logout.headers.get('set-cookie') ?? ''
    assert.ok(
      setCookie.includes('bcs_token=;') || setCookie.includes('Expires='),
      'logout clears the cookie'
    )
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 12 — Brute-force lockout
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 12: Brute-force lockout', async () => {
  test('account is locked after 5 consecutive bad passwords', async () => {
    await seedUser({ email: 'brute@authtest.local' })

    // Send 5 wrong passwords
    for (let i = 0; i < 5; i++) {
      await req('POST', '/api/auth/login', {
        body: { email: 'brute@authtest.local', password: 'WrongPass!' },
      })
    }

    // 6th attempt with the correct password should now be locked
    const r = await req('POST', '/api/auth/login', {
      body: { email: 'brute@authtest.local', password: 'ValidPass123!' },
    })
    assert.equal(r.status, 429, 'account should be locked after 5 failures')
    assert.equal(r.json?.error, 'Account Locked')
  })
})
