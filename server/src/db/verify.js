/**
 * server/src/db/verify.js
 *
 * Database verification script.
 * Run with: node src/db/verify.js
 *
 * Checks:
 *   1. Database connectivity (SELECT 1)
 *   2. All required tables exist
 *   3. Critical constraints exist
 *   4. Migration history is consistent
 *   5. Seed products exist by stable seed_key
 *
 * Exits with code 0 on success, 1 on any failure.
 * Never prints connection strings or credential values.
 */

// Load .env from the project root (three levels up from server/src/db/)
import dotenv from 'dotenv'
import pg from 'pg'
import { readEnvRequired } from '../config.js'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

const { Client } = pg

const REQUIRED_TABLES = [
  'schema_migrations',
  'users',
  'products',
  'chicken_loads',
  'stock_entries',
  'daily_prices',
  'parties',
  'account_adjustments',
  'sales',
  'sale_items',
  'payments',
  'payment_allocations',
  'audit_logs',
]

const REQUIRED_SEED_KEYS = [
  'live_chicken',
  'dressed_chicken',
  'boneless',
  'wings',
  'leg_piece',
  'liver',
]

const REQUIRED_MIGRATIONS = [
  '001_create_users.sql',
  '002_create_products.sql',
  '003_create_chicken_loads.sql',
  '004_create_stock_entries.sql',
  '005_create_daily_prices.sql',
  '006_create_parties.sql',
  '007_create_account_adjustments.sql',
  '008_create_sales_and_items.sql',
  '009_create_payments_and_allocations.sql',
  '010_create_audit_logs.sql',
  '011_create_triggers.sql',
  '012_create_indexes.sql',
]

let passed = 0
let failed = 0

function pass(label) {
  console.log(`  ✅ ${label}`)
  passed++
}

function fail(label, detail = '') {
  console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`)
  failed++
}

async function verify() {
  const connectionString = readEnvRequired('DATABASE_URL_DIRECT')
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
  const client = new Client({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8_000,
  })

  try {
    await client.connect()
    console.log('\n[verify] Connected to database.\n')

    // ── Check 1: Basic connectivity ─────────────────────────────────────
    console.log('── Connectivity ─────────────────────────────────────────────')
    try {
      const { rows } = await client.query('SELECT 1 AS ok')
      if (rows[0].ok === 1) pass('SELECT 1 returned successfully')
      else fail('SELECT 1 returned unexpected result')
    } catch (e) {
      fail('Basic connectivity', e.message)
    }

    // ── Check 2: Required tables ─────────────────────────────────────────
    console.log('\n── Required tables ──────────────────────────────────────────')
    const { rows: tableRows } = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
    `)
    const existingTables = new Set(tableRows.map((r) => r.tablename))

    for (const table of REQUIRED_TABLES) {
      if (existingTables.has(table)) pass(table)
      else fail(table, 'table not found in public schema')
    }

    // ── Check 3: Critical constraints and indexes ─────────────────────────
    console.log('\n── Critical constraints and indexes ─────────────────────────')
    const { rows: idxRows } = await client.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `)
    const existingIndexes = new Set(idxRows.map((r) => r.indexname))

    const criticalIndexes = [
      'idx_one_opening_balance_per_party',
      'idx_active_allocation_per_pair',
      'idx_sales_active_credit',
      'idx_payments_active',
    ]
    for (const idx of criticalIndexes) {
      if (existingIndexes.has(idx)) pass(`index: ${idx}`)
      else fail(`index: ${idx}`, 'not found')
    }

    // Check triggers exist
    const { rows: trgRows } = await client.query(`
      SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_schema = 'public'
    `)
    const existingTriggers = new Set(trgRows.map((r) => r.trigger_name))
    const criticalTriggers = [
      'trg_sales_no_direct_confirm',
      'trg_sales_validate_on_confirm',
      'trg_sale_items_immutable',
    ]
    for (const trg of criticalTriggers) {
      if (existingTriggers.has(trg)) pass(`trigger: ${trg}`)
      else fail(`trigger: ${trg}`, 'not found')
    }

    // ── Check 4: Migration history ────────────────────────────────────────
    console.log('\n── Migration history ─────────────────────────────────────────')
    try {
      const { rows: migRows } = await client.query(
        'SELECT version FROM schema_migrations ORDER BY version'
      )
      const appliedVersions = new Set(migRows.map((r) => r.version))

      for (const mig of REQUIRED_MIGRATIONS) {
        if (appliedVersions.has(mig)) pass(`applied: ${mig}`)
        else fail(`pending: ${mig}`, 'not yet applied — run npm run db:migrate')
      }
    } catch {
      fail('schema_migrations table', 'not accessible — run npm run db:migrate first')
    }

    // ── Check 5: Seed products ────────────────────────────────────────────
    console.log('\n── Seed products ─────────────────────────────────────────────')
    try {
      const { rows: seedRows } = await client.query(
        'SELECT seed_key FROM products WHERE seed_key = ANY($1)',
        [REQUIRED_SEED_KEYS]
      )
      const foundKeys = new Set(seedRows.map((r) => r.seed_key))

      for (const key of REQUIRED_SEED_KEYS) {
        if (foundKeys.has(key)) pass(`product seed_key: ${key}`)
        else fail(`product seed_key: ${key}`, 'not found — run npm run db:seed')
      }
    } catch (e) {
      fail('products table query', e.message)
    }

  } catch (err) {
    console.error(`\n[verify] Connection failed: ${err.message}`)
    console.error('Check that DATABASE_URL_DIRECT is set correctly in .env')
    failed++
  } finally {
    try { await client.end() } catch (_) {}
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n── Summary ───────────────────────────────────────────────────`)
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  if (failed > 0) {
    console.error('\n[verify] FAILED — see above for details.\n')
    process.exit(1)
  } else {
    console.log('\n[verify] All checks passed. Database is ready. ✅\n')
    process.exit(0)
  }
}

verify()
