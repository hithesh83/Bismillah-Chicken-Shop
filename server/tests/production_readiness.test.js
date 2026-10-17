/**
 * server/tests/production_readiness.test.js
 *
 * Automated verification for Phase 14 Production Readiness:
 *  - Health liveness (/api/health)
 *  - Health readiness with database connectivity (/api/health/ready)
 *  - Strict CORS origin filtering (rejects unauthorized origins)
 *  - Trust proxy header acceptance
 *  - Isolated test database safety checks
 */

import dotenv from 'dotenv'
dotenv.config({ path: new URL('../../.env', import.meta.url) })

import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'

// ── Strict Safety Abort: Prevent accidental production mutation ──
const TEST_URL = process.env.DATABASE_URL_TEST
const PROD_URL = process.env.DATABASE_URL
const DIRECT_URL = process.env.DATABASE_URL_DIRECT

if (!TEST_URL) {
  console.error('[p14-test] DATABASE_URL_TEST is not set.')
  process.exit(1)
}
if (TEST_URL === PROD_URL || TEST_URL === DIRECT_URL) {
  console.error('[p14-test] SAFETY ABORT: DATABASE_URL_TEST matches production database.')
  process.exit(1)
}

// Redirect app database connection pool to the isolated test database
process.env.DATABASE_URL = TEST_URL

const { default: app } = await import('../src/app.js')
const { query } = await import('../src/db/pool.js')

let server
let baseUrl

before(async () => {
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('Phase 14: Production Readiness & Health Checks', () => {
  test('GET /api/health returns 200 OK with liveness details', async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.ok(json.status.includes('Backend is running'))
    assert.ok(json.timestamp)
    assert.ok(json.environment)
  })

  test('GET /api/health/ready returns 200 OK and confirms database connection', async () => {
    const res = await fetch(`${baseUrl}/api/health/ready`)
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.status, 'ready')
    assert.equal(json.database, 'connected')
    assert.ok(typeof json.latency_ms === 'number')
    assert.ok(json.timestamp)
  })

  test('CORS: Allows requests from configured CLIENT_ORIGIN', async () => {
    const allowedOrigin = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim()
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: {
        Origin: allowedOrigin,
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), allowedOrigin)
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true')
  })

  test('CORS: Blocks requests from unauthorized foreign origins', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: {
        Origin: 'https://malicious-attacker-site.com',
      },
    })
    // Express CORS middleware returns 500 or error when origin callback rejects
    const text = await res.text()
    assert.ok(res.status >= 400 || !res.headers.get('access-control-allow-origin'))
    assert.ok(!res.headers.get('access-control-allow-origin')?.includes('malicious-attacker-site.com'))
  })

  test('CSRF Defense: Blocks unauthorized origin on state-changing requests', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://malicious-attacker-site.com',
      },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
    })
    assert.equal(res.status, 403)
    const json = await res.json()
    assert.equal(json.error, 'Forbidden')
  })

  test('Reverse Proxy: Trust proxy setting is enabled for Render load balancers', () => {
    assert.equal(app.get('trust proxy'), 1)
  })
})
