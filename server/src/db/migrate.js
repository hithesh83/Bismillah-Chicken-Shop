/**
 * server/src/db/migrate.js
 *
 * Migration runner for Bismillah Chicken Shop.
 *
 * Responsibilities:
 *  1. Validate that DATABASE_URL_DIRECT is a direct (non-pooled) connection
 *  2. Bootstrap the schema_migrations tracking table
 *  3. Acquire a PostgreSQL advisory lock to prevent concurrent runners
 *  4. Apply pending migration files in order
 *  5. Track checksums to detect schema drift (modified-after-applied files)
 *  6. Release the lock and close the connection on ALL exit paths
 *
 * Run with:
 *   node src/db/migrate.js             — apply pending migrations
 *   node src/db/migrate.js --status    — show applied/pending status
 */

// Load .env from the project root (three levels up from server/src/db/)
// 'dotenv/config' alone would look in CWD (server/) which has no .env
import dotenv from 'dotenv'
import pg from 'pg'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { readEnvRequired } from '../config.js'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

const { Client } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Constants ──────────────────────────────────────────────────────────────
// migrate.js lives at server/src/db/ — go up two levels to reach server/migrations/
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

// Fixed advisory lock ID — must not collide with other locks in this project
// Chosen arbitrarily; document in DATABASE.md
const MIGRATION_LOCK_ID = 7_482_910_234n

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate that a connection URL targets a direct (non-pooled) PostgreSQL
 * connection. Supabase Transaction Pooler uses port 6543; direct is 5432.
 * Throws a clear, actionable error if a pooler URL is detected.
 */
function assertDirectConnection(connectionString, label) {
  let parsed
  try {
    parsed = new URL(connectionString)
  } catch {
    throw new Error(`${label} is not a valid PostgreSQL URL.`)
  }

  if (parsed.port === '6543') {
    throw new Error(
      `\n[MIGRATION ABORTED]\n` +
      `${label} targets the Supabase Transaction Pooler (port 6543).\n` +
      `Transaction-pooler connections do not preserve session state.\n` +
      `Session-level advisory locks will not work correctly over a pooler.\n` +
      `Set ${label} to the direct connection string (port 5432).\n`
    )
  }

  if (parsed.hostname.includes('pooler')) {
    throw new Error(
      `\n[MIGRATION ABORTED]\n` +
      `${label} hostname contains 'pooler'. Migrations require a direct connection.\n`
    )
  }
}

/**
 * Compute a SHA-256 checksum of a migration file's content.
 * Used to detect modifications after a migration has been applied.
 */
function checksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Load all .sql files from the migrations directory, sorted by filename.
 * @returns {{ filename: string, filepath: string, content: string, checksum: string }[]}
 */
function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`)
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()   // lexicographic sort — filenames must use zero-padded numeric prefixes
    .map((filename) => {
      const filepath = path.join(MIGRATIONS_DIR, filename)
      const content = fs.readFileSync(filepath, 'utf8')
      return { filename, filepath, content, checksum: checksum(content) }
    })
}

// ── Main runner ────────────────────────────────────────────────────────────
async function runMigrations({ statusOnly = false } = {}) {
  // Validate connection string BEFORE opening any connection
  const connectionString = readEnvRequired('DATABASE_URL_DIRECT')
  assertDirectConnection(connectionString, 'DATABASE_URL_DIRECT')

  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1')

  // Use a single Client (not Pool) to guarantee one session throughout
  const client = new Client({
    connectionString,
    // Supabase uses a self-signed cert in their chain; rejectUnauthorized:false
    // still uses SSL encryption — only the chain verification is relaxed.
    // This is the documented approach for Supabase + pg.
    ssl: isLocal ? false : { rejectUnauthorized: false },
    // Long timeout for migrations that create indexes or run on large tables
    statement_timeout: 120_000,
    query_timeout:     120_000,
  })

  let lockAcquired = false

  try {
    await client.connect()

    // Confirm we are on a real direct connection (not pooler impersonating one)
    const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid')
    console.log(`[migrate] Connected. Backend PID: ${pid}`)

    // ── 1. Acquire advisory lock (session-level — valid for this entire Client session) ──
    const { rows: [{ acquired }] } = await client.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [MIGRATION_LOCK_ID]
    )
    if (!acquired) {
      throw new Error(
        '[migrate] Another migration runner holds the advisory lock. ' +
        'Aborting to prevent concurrent migrations.'
      )
    }
    lockAcquired = true
    console.log('[migrate] Advisory lock acquired.')

    // ── 2. Bootstrap schema_migrations (its own transaction) ──
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum   TEXT        NOT NULL
      )
    `)
    await client.query('COMMIT')
    console.log('[migrate] schema_migrations table ready.')

    // ── 3. Load migration files ──
    const files = loadMigrationFiles()
    if (files.length === 0) {
      console.log('[migrate] No migration files found.')
      return
    }

    // ── 4. Read applied migrations ──
    const { rows: applied } = await client.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY version'
    )
    const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]))

    if (statusOnly) {
      console.log('\n[migrate] Migration status:')
      for (const file of files) {
        const isApplied = appliedMap.has(file.filename)
        const drifted  = isApplied && appliedMap.get(file.filename) !== file.checksum
        const marker   = drifted ? '⚠  DRIFT' : isApplied ? '✅ applied' : '⏳ pending'
        console.log(`  ${marker}  ${file.filename}`)
      }
      console.log('')
      return
    }

    // ── 5. Apply pending migrations ──
    let applied_count = 0
    let skipped_count = 0

    for (const file of files) {
      const existingChecksum = appliedMap.get(file.filename)

      if (existingChecksum !== undefined) {
        // Already applied — verify checksum for drift detection
        if (existingChecksum !== file.checksum) {
          throw new Error(
            `[migrate] SCHEMA DRIFT DETECTED\n` +
            `Migration file '${file.filename}' has been modified after it was applied.\n` +
            `Checksum on disk:    ${file.checksum}\n` +
            `Checksum in DB:      ${existingChecksum}\n` +
            `Do not edit migration files after they have been applied. ` +
            `Create a new migration file to make further changes.`
          )
        }
        skipped_count++
        continue
      }

      // Apply this migration inside a transaction
      console.log(`[migrate] Applying: ${file.filename}`)
      try {
        await client.query('BEGIN')
        await client.query(file.content)
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [file.filename, file.checksum]
        )
        await client.query('COMMIT')
        applied_count++
        console.log(`[migrate] ✅ Applied: ${file.filename}`)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw new Error(
          `[migrate] FAILED applying '${file.filename}'\n` +
          `Error: ${err.message}\n` +
          `The migration was rolled back. No changes were committed.`
        )
      }
    }

    console.log(
      `\n[migrate] Done. ${applied_count} applied, ${skipped_count} already up-to-date.\n`
    )

  } catch (err) {
    // Ensure any open transaction is rolled back before releasing lock
    try { await client.query('ROLLBACK') } catch (_) { /* ignore */ }
    console.error('\n' + err.message + '\n')
    process.exitCode = 1

  } finally {
    // ALWAYS release the advisory lock — runs on success, error, and early exit
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
        console.log('[migrate] Advisory lock released.')
      } catch (_) { /* ignore — connection may be closing */ }
    }

    // Close the client connection
    try { await client.end() } catch (_) { /* ignore */ }
  }
}

// ── Entry point ────────────────────────────────────────────────────────────
const statusOnly = process.argv.includes('--status')
runMigrations({ statusOnly })
