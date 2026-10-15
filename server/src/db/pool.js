/**
 * server/src/db/pool.js
 *
 * Reusable PostgreSQL connection pool for application queries.
 *
 * This module is the ONLY place in the application that creates a pg.Pool.
 * All Express route handlers import { query, withTransaction } from here.
 *
 * IMPORTANT:
 *   - Uses DATABASE_URL from environment (may be Transaction Pooler or direct)
 *   - Never import this module in migration or test runner — they use their own connections
 *   - Never print the connection string or any part of it in logs
 */

import pg from 'pg'
import { readEnvRequired } from '../config.js'

const { Pool } = pg

// ── Configuration ──────────────────────────────────────────────────────────
// Validate required environment variables without printing their values
const connectionString = readEnvRequired('DATABASE_URL')

// SSL: required for Supabase/remote connections, not needed for local Homebrew PostgreSQL.
// Disable SSL when connecting to localhost (Homebrew install has no SSL configured).
const isLocalConnection =
  connectionString.includes('localhost') ||
  connectionString.includes('127.0.0.1')

const sslConfig = isLocalConnection ? false : { rejectUnauthorized: false }

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: sslConfig,  // false for localhost, { rejectUnauthorized: false } for Supabase
})

// ── Connection lifecycle logging ────────────────────────────────────────────
pool.on('connect', () => {
  // Log connection events in dev to aid debugging — never log credentials
  if (process.env.NODE_ENV === 'development') {
    console.log('[db] New client connected to pool')
  }
})

pool.on('error', (err) => {
  // Log sanitized error — never include the connection string
  console.error('[db] Unexpected error on idle pool client:', err.message)
})

// ── query helper ────────────────────────────────────────────────────────────
/**
 * Execute a single parameterized query.
 *
 * Always use parameterized queries:
 *   query('SELECT * FROM users WHERE id = $1', [userId])
 *
 * NEVER interpolate user input into the SQL string.
 *
 * @param {string} text   SQL string with $1, $2, ... placeholders
 * @param {any[]}  params Values for placeholders
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  try {
    return await pool.query(text, params)
  } catch (err) {
    // Re-throw with sanitized message — strip any connection details pg may include
    const safe = new Error(`Database query failed: ${err.message}`)
    safe.code = err.code   // preserve PostgreSQL error code (e.g. '23505' for unique violation)
    safe.detail = err.detail  // constraint detail (safe to expose in dev logs)
    throw safe
  }
}

// ── withTransaction helper ──────────────────────────────────────────────────
/**
 * Run a callback inside a SERIALIZABLE database transaction.
 * Automatically commits on success and rolls back on any thrown error.
 * The callback receives a `client` that must be used for all queries
 * within the transaction.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('INSERT INTO ...', [...])
 *     await client.query('UPDATE ...', [...])
 *     return someValue
 *   })
 *
 * @param {(client: pg.PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withTransaction(callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) { /* ignore rollback error */ }
    throw err
  } finally {
    client.release()
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────────────
/**
 * Call this when the process is shutting down (SIGTERM, SIGINT).
 * Waits for active queries to complete, then closes all connections.
 */
export async function closePool() {
  await pool.end()
  console.log('[db] Connection pool closed.')
}

export default pool
