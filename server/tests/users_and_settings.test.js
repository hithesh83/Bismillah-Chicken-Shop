/**
 * server/tests/users_and_settings.test.js
 *
 * User Management and Application Settings Automated Verification Suite.
 *
 * Scenarios:
 *   1. Unauthenticated requests to /api/users are rejected (401).
 *   2. Staff role access to /api/users is rejected (403).
 *   3. Manager role access to /api/users is rejected (403).
 *   4. Admin can list users with search and role filters.
 *   5. Admin can create new users (staff, manager, admin) with secure bcrypt hashing.
 *   6. Duplicate email and invalid inputs are rejected (409 / 400).
 *   7. Passwords and password hashes are NEVER exposed in API responses.
 *   8. Admin can update user profile (name, email).
 *   9. Admin can update user role, but CANNOT demote the last active admin.
 *  10. Admin can deactivate user, but CANNOT deactivate the last active admin.
 *  11. Deactivated user cannot authenticate (POST /login returns 401).
 *  12. Deactivated user with existing token cannot access protected routes (401).
 *  13. Admin can reactivate user and reset password.
 *  14. Authenticated user can change their own password via /api/auth/change-password.
 *  15. Administrative actions (create, update, role, status, reset) create audit logs.
 *  16. Unauthenticated requests to modify settings are rejected (401).
 *  17. Non-admin users cannot modify settings (403).
 *  18. Valid settings update persists and can be retrieved.
 *  19. Invalid settings payloads are rejected server-side (400).
 *  20. Security-sensitive settings modifications create audit log entries.
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
  console.error('[users-test] DATABASE_URL_TEST not set in .env')
  process.exit(1)
}
if (TEST_URL === process.env.DATABASE_URL || TEST_URL === process.env.DATABASE_URL_DIRECT) {
  console.error('[users-test] SAFETY ABORT: DATABASE_URL_TEST matches production database.')
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
let adminUser, managerUser, staffUser
let adminCookie, managerCookie, staffCookie

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

// ── Setup ─────────────────────────────────────────────────────────────────
before(async () => {
  server = http.createServer(app)
  await new Promise(res => server.listen(0, '127.0.0.1', res))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`\n[users-test] Test server: ${baseUrl}`)

  // Run any unapplied migrations
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

  // Seed test users
  const hash = await bcrypt.hash('TestPass123!', 4)

  const { rows: [a] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role, is_active)
     VALUES ('admin-test@users.local', $1, 'Admin Tester', 'admin', TRUE)
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, is_active = TRUE, role = 'admin', failed_login_attempts = 0, locked_until = NULL
     RETURNING id, display_name, login_email, role`,
    [hash]
  )
  adminUser = a

  const { rows: [m] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role, is_active)
     VALUES ('manager-test@users.local', $1, 'Manager Tester', 'manager', TRUE)
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, is_active = TRUE, role = 'manager', failed_login_attempts = 0, locked_until = NULL
     RETURNING id, display_name, login_email, role`,
    [hash]
  )
  managerUser = m

  const { rows: [s] } = await pool.query(
    `INSERT INTO users (login_email, password_hash, display_name, role, is_active)
     VALUES ('staff-test@users.local', $1, 'Staff Tester', 'staff', TRUE)
     ON CONFLICT (login_email) DO UPDATE
       SET password_hash = $1, is_active = TRUE, role = 'staff', failed_login_attempts = 0, locked_until = NULL
     RETURNING id, display_name, login_email, role`,
    [hash]
  )
  staffUser = s

  adminCookie   = await login('admin-test@users.local', 'TestPass123!')
  managerCookie = await login('manager-test@users.local', 'TestPass123!')
  staffCookie   = await login('staff-test@users.local', 'TestPass123!')

  assert.ok(adminCookie, 'Admin session established')
  assert.ok(managerCookie, 'Manager session established')
  assert.ok(staffCookie, 'Staff session established')
})

after(async () => {
  try {
    await pool.query(
      `DELETE FROM audit_logs WHERE actor_id IN ($1, $2, $3)`,
      [adminUser.id, managerUser.id, staffUser.id]
    )
    await pool.query(
      `DELETE FROM users WHERE login_email LIKE '%@created.local' OR login_email LIKE '%@testuser.local'`
    )
  } catch (_) {}
  await pool.end()
  if (server) await new Promise(res => server.close(res))
})

// ══════════════════════════════════════════════════════════════════════════
// TEST SUITE: User Management & Settings
// ══════════════════════════════════════════════════════════════════════════

describe('1. Role-Based Access Control (RBAC) on User Management', async () => {
  test('1. Unauthenticated request to /api/users returns 401 Unauthorized', async () => {
    const res = await apiReq('GET', '/api/users')
    assert.equal(res.status, 401)
    assert.equal(res.json?.error, 'Unauthenticated')
  })

  test('2. Staff user request to /api/users returns 403 Forbidden', async () => {
    const res = await apiReq('GET', '/api/users', { cookie: staffCookie })
    assert.equal(res.status, 403)
    assert.equal(res.json?.error, 'Forbidden')
  })

  test('3. Manager user request to /api/users returns 403 Forbidden', async () => {
    const res = await apiReq('GET', '/api/users', { cookie: managerCookie })
    assert.equal(res.status, 403)
    assert.equal(res.json?.error, 'Forbidden')
  })

  test('4. Admin user can list users with summary counts (200 OK)', async () => {
    const res = await apiReq('GET', '/api/users', { cookie: adminCookie })
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.json?.users), 'users array returned')
    assert.ok(res.json?.summary?.total_users >= 3, 'summary totals returned')
  })
})

describe('2. User Creation and Input Validation', async () => {
  let createdStaffId

  test('5. Admin can create new staff account with hashed password', async () => {
    const res = await apiReq('POST', '/api/users', {
      cookie: adminCookie,
      body: {
        display_name: 'Zaid Khan',
        login_email:  'zaid@created.local',
        password:     'SecurePass123!',
        role:         'staff',
      },
    })
    assert.equal(res.status, 201)
    assert.equal(res.json?.user?.display_name, 'Zaid Khan')
    assert.equal(res.json?.user?.login_email, 'zaid@created.local')
    assert.equal(res.json?.user?.role, 'staff')
    assert.equal(res.json?.user?.is_active, true)
    // Security check: password_hash NEVER returned
    assert.equal(res.json?.user?.password_hash, undefined)
    createdStaffId = res.json?.user?.id
  })

  test('6. Duplicate login email returns 409 Conflict', async () => {
    const res = await apiReq('POST', '/api/users', {
      cookie: adminCookie,
      body: {
        display_name: 'Duplicate Zaid',
        login_email:  'zaid@created.local',
        password:     'SecurePass123!',
        role:         'staff',
      },
    })
    assert.equal(res.status, 409)
    assert.equal(res.json?.error, 'Conflict')
  })

  test('7. Invalid role or weak password returns 400 Bad Request', async () => {
    const resRole = await apiReq('POST', '/api/users', {
      cookie: adminCookie,
      body: {
        display_name: 'Bad Role',
        login_email:  'badrole@created.local',
        password:     'SecurePass123!',
        role:         'superadmin', // Invalid role
      },
    })
    assert.equal(resRole.status, 400)

    const resPass = await apiReq('POST', '/api/users', {
      cookie: adminCookie,
      body: {
        display_name: 'Short Pass',
        login_email:  'shortpass@created.local',
        password:     '123', // Less than 8 chars
        role:         'staff',
      },
    })
    assert.equal(resPass.status, 400)
  })

  test('8. Created user can successfully log in with password', async () => {
    const loginRes = await apiReq('POST', '/api/auth/login', {
      body: { email: 'zaid@created.local', password: 'SecurePass123!' },
    })
    assert.equal(loginRes.status, 200)
    assert.equal(loginRes.json?.user?.email, 'zaid@created.local')
  })
})

describe('3. User Profile and Role Management', async () => {
  let targetUserId

  before(async () => {
    const res = await apiReq('POST', '/api/users', {
      cookie: adminCookie,
      body: {
        display_name: 'Bilal Ahmed',
        login_email:  'bilal@testuser.local',
        password:     'BilalPass123!',
        role:         'staff',
      },
    })
    targetUserId = res.json?.user?.id
  })

  test('9. Admin can update display name and email', async () => {
    const res = await apiReq('PATCH', `/api/users/${targetUserId}`, {
      cookie: adminCookie,
      body: {
        display_name: 'Bilal A. Updated',
        login_email:  'bilal.updated@testuser.local',
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json?.user?.display_name, 'Bilal A. Updated')
    assert.equal(res.json?.user?.login_email, 'bilal.updated@testuser.local')
  })

  test('10. Admin can promote user from staff to manager', async () => {
    const res = await apiReq('PATCH', `/api/users/${targetUserId}/role`, {
      cookie: adminCookie,
      body: { role: 'manager' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json?.user?.role, 'manager')
  })

  test('11. Last active admin safeguard prevents demoting the last active administrator', async () => {
    // Ensure only one admin exists or check against adminUser.id
    // If adminUser is the only active admin with that specific email
    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE AND id != $1`,
      [adminUser.id]
    )
    if (admins.length === 0) {
      const res = await apiReq('PATCH', `/api/users/${adminUser.id}/role`, {
        cookie: adminCookie,
        body: { role: 'staff' },
      })
      assert.equal(res.status, 400)
      assert.ok(res.json?.message?.includes('last active administrator'))
    }
  })
})

describe('4. Safe Deactivation and Inactive Session Invalidation', async () => {
  let deactivatedUserId
  let deactivatedUserCookie

  before(async () => {
    const res = await apiReq('POST', '/api/users', {
      cookie: adminCookie,
      body: {
        display_name: 'Tariq Mehmood',
        login_email:  'tariq@testuser.local',
        password:     'TariqPass123!',
        role:         'staff',
      },
    })
    deactivatedUserId = res.json?.user?.id
    deactivatedUserCookie = await login('tariq@testuser.local', 'TariqPass123!')
    assert.ok(deactivatedUserCookie, 'Tariq logged in successfully')
  })

  test('12. Admin can deactivate user without deleting database record', async () => {
    const res = await apiReq('PATCH', `/api/users/${deactivatedUserId}/status`, {
      cookie: adminCookie,
      body: { is_active: false },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json?.user?.is_active, false)

    // Verify row still exists in DB
    const { rows } = await pool.query(`SELECT id, is_active FROM users WHERE id = $1`, [deactivatedUserId])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].is_active, false)
  })

  test('13. Deactivated user cannot authenticate (POST /login returns 401)', async () => {
    const res = await apiReq('POST', '/api/auth/login', {
      body: { email: 'tariq@testuser.local', password: 'TariqPass123!' },
    })
    assert.equal(res.status, 401)
  })

  test('14. Inactive user with existing session cookie is immediately rejected on protected routes (401)', async () => {
    const res = await apiReq('GET', '/api/auth/me', { cookie: deactivatedUserCookie })
    assert.equal(res.status, 401)
    assert.ok(res.json?.message?.includes('inactive') || res.json?.message?.includes('deactivated'))
  })

  test('15. Last active admin safeguard prevents deactivating the last active administrator', async () => {
    const { rows: otherAdmins } = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE AND id != $1`,
      [adminUser.id]
    )
    if (otherAdmins.length === 0) {
      const res = await apiReq('PATCH', `/api/users/${adminUser.id}/status`, {
        cookie: adminCookie,
        body: { is_active: false },
      })
      assert.equal(res.status, 400)
      assert.ok(res.json?.message?.includes('last active administrator'))
    }
  })

  test('16. Admin can reactivate user and user can log in again', async () => {
    const reactivateRes = await apiReq('PATCH', `/api/users/${deactivatedUserId}/status`, {
      cookie: adminCookie,
      body: { is_active: true },
    })
    assert.equal(reactivateRes.status, 200)
    assert.equal(reactivateRes.json?.user?.is_active, true)

    const loginRes = await apiReq('POST', '/api/auth/login', {
      body: { email: 'tariq@testuser.local', password: 'TariqPass123!' },
    })
    assert.equal(loginRes.status, 200)
  })
})

describe('5. Password Management (Admin Reset & User Change)', async () => {
  let userToResetId

  before(async () => {
    const res = await apiReq('POST', '/api/users', {
      cookie: adminCookie,
      body: {
        display_name: 'Usman Ali',
        login_email:  'usman@testuser.local',
        password:     'OldPassword123!',
        role:         'staff',
      },
    })
    userToResetId = res.json?.user?.id
  })

  test('17. Admin can reset another user password', async () => {
    const res = await apiReq('POST', `/api/users/${userToResetId}/reset-password`, {
      cookie: adminCookie,
      body: { new_password: 'NewAdminSetPass123!' },
    })
    assert.equal(res.status, 200)

    // Old password fails
    const failLogin = await apiReq('POST', '/api/auth/login', {
      body: { email: 'usman@testuser.local', password: 'OldPassword123!' },
    })
    assert.equal(failLogin.status, 401)

    // New password succeeds
    const okLogin = await apiReq('POST', '/api/auth/login', {
      body: { email: 'usman@testuser.local', password: 'NewAdminSetPass123!' },
    })
    assert.equal(okLogin.status, 200)
  })

  test('18. User can change their own password via /api/auth/change-password', async () => {
    const usmanCookie = await login('usman@testuser.local', 'NewAdminSetPass123!')

    // Wrong current password fails
    const failRes = await apiReq('POST', '/api/auth/change-password', {
      cookie: usmanCookie,
      body: {
        current_password: 'WrongCurrentPass!',
        new_password:     'BrandNewPass123!',
      },
    })
    assert.equal(failRes.status, 400)

    // Correct current password succeeds
    const okRes = await apiReq('POST', '/api/auth/change-password', {
      cookie: usmanCookie,
      body: {
        current_password: 'NewAdminSetPass123!',
        new_password:     'BrandNewPass123!',
      },
    })
    assert.equal(okRes.status, 200)

    // Login with new password
    const newLogin = await apiReq('POST', '/api/auth/login', {
      body: { email: 'usman@testuser.local', password: 'BrandNewPass123!' },
    })
    assert.equal(newLogin.status, 200)
  })

  test('19. Audit logs exist for user create and password reset events', async () => {
    const res = await apiReq('GET', `/api/users/${userToResetId}`, { cookie: adminCookie })
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.json?.audit))
    assert.ok(res.json?.audit.length > 0)
    // Verify no password logged in audit trail
    const auditStr = JSON.stringify(res.json?.audit)
    assert.ok(!auditStr.includes('BrandNewPass123!'))
    assert.ok(!auditStr.includes('NewAdminSetPass123!'))
  })
})

describe('6. Application Settings API', async () => {
  test('20. Unauthenticated request to modify settings is rejected (401)', async () => {
    const res = await apiReq('PUT', '/api/settings/shop_profile', {
      body: { shop_name: 'Hacked Shop' },
    })
    assert.equal(res.status, 401)
  })

  test('21. Staff or Manager request to modify settings is rejected (403)', async () => {
    const resStaff = await apiReq('PUT', '/api/settings/shop_profile', {
      cookie: staffCookie,
      body: { shop_name: 'Staff Modified Shop' },
    })
    assert.equal(resStaff.status, 403)

    const resMgr = await apiReq('PUT', '/api/settings/shop_profile', {
      cookie: managerCookie,
      body: { shop_name: 'Manager Modified Shop' },
    })
    assert.equal(resMgr.status, 403)
  })

  test('22. Admin can read all settings categories', async () => {
    const res = await apiReq('GET', '/api/settings', { cookie: adminCookie })
    assert.equal(res.status, 200)
    assert.ok(res.json?.settings?.shop_profile, 'shop_profile present')
    assert.ok(res.json?.settings?.business_preferences, 'business_preferences present')
    assert.ok(res.json?.settings?.operational_preferences, 'operational_preferences present')
    assert.ok(res.json?.settings?.security_policy, 'security_policy present')
  })

  test('23. Admin can update shop profile and operational preferences', async () => {
    const newProfile = {
      shop_name: 'Bismillah Chicken Fresh Hub',
      tagline:   'Premium Halal Chicken',
      phone:     '+91 99887 76655',
      email:     'info@bismillahfresh.com',
      address:   '123 Commercial St, Shivaji Nagar, Bengaluru 560051',
      tax_id:    '29ABCDE1234F1Z5',
    }
    const res = await apiReq('PUT', '/api/settings/shop_profile', {
      cookie: adminCookie,
      body: newProfile,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json?.setting?.value?.shop_name, 'Bismillah Chicken Fresh Hub')

    // Verify persistence via GET
    const getRes = await apiReq('GET', '/api/settings', { cookie: adminCookie })
    assert.equal(getRes.json?.settings?.shop_profile?.shop_name, 'Bismillah Chicken Fresh Hub')
  })

  test('24. Invalid settings values are rejected with 400 Bad Request', async () => {
    const badProfile = { shop_name: '' } // too short
    const res = await apiReq('PUT', '/api/settings/shop_profile', {
      cookie: adminCookie,
      body: badProfile,
    })
    assert.equal(res.status, 400)
  })

  test('25. Settings changes generate audit log entries', async () => {
    const res = await apiReq('GET', '/api/settings/audit', { cookie: adminCookie })
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.json?.audit))
    assert.ok(res.json?.audit.length > 0)
    const latestEvent = res.json?.audit[0]
    assert.equal(latestEvent.action_type, 'UPDATE')
  })
})
