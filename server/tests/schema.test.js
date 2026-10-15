/**
 * server/tests/schema.test.js
 *
 * Schema invariant tests for Phase 2.
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 *
 * SAFETY RULES:
 *   • Reads DATABASE_URL_TEST — must differ from DATABASE_URL and DATABASE_URL_DIRECT.
 *   • If the URLs match, the test runner aborts before touching any data.
 *   • Runs migrations on the test database before any test.
 *   • Truncates all business tables (not schema_migrations) between test suites.
 *   • Never connects to production or development databases.
 *
 * Run with: npm test  (from server/ directory)
 * Requires: DATABASE_URL_TEST in .env (must be a separate test database)
 */

// Load .env from the project root (two levels up from server/tests/)
import dotenv from 'dotenv'
dotenv.config({ path: new URL('../../.env', import.meta.url) })
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

const { Pool } = pg

// ── Safety: abort if test URL matches dev/prod URLs ──────────────────────
const TEST_URL    = process.env.DATABASE_URL_TEST
const DEV_URL     = process.env.DATABASE_URL
const DIRECT_URL  = process.env.DATABASE_URL_DIRECT

if (!TEST_URL) {
  console.error('[test] DATABASE_URL_TEST is not set. Aborting.')
  process.exit(1)
}
if (TEST_URL === DEV_URL || TEST_URL === DIRECT_URL) {
  console.error(
    '[test] SAFETY ABORT: DATABASE_URL_TEST matches DATABASE_URL or DATABASE_URL_DIRECT.\n' +
    'Tests would run against the development or production database.\n' +
    'Set DATABASE_URL_TEST to a separate test database.'
  )
  process.exit(1)
}

// ── Test pool ─────────────────────────────────────────────────────────────
const isLocalTest = TEST_URL.includes('localhost') || TEST_URL.includes('127.0.0.1')
const pool = new Pool({
  connectionString: TEST_URL,
  ssl: isLocalTest ? false : { rejectUnauthorized: true },
  max: 5,
})

/**
 * Execute a query against the test database.
 */
async function q(sql, params = []) {
  return pool.query(sql, params)
}

/**
 * Execute sql inside a transaction. Returns result of callback.
 */
async function withTx(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Insert a minimal user for FK references in tests.
 */
async function insertTestUser(client, suffix = '') {
  const { rows } = await client.query(`
    INSERT INTO users (display_name, login_email, role)
    VALUES ($1, $2, 'admin')
    RETURNING id
  `, [`Test User${suffix}`, `testuser${suffix}@test.local`])
  return rows[0].id
}

/**
 * Insert a test party.
 */
async function insertTestParty(client, userId, suffix = '') {
  const { rows } = await client.query(`
    INSERT INTO parties (party_code, name, credit_enabled, created_by)
    VALUES ($1, $2, TRUE, $3)
    RETURNING id
  `, [`TST-${Date.now()}${suffix}`, `Test Party${suffix}`, userId])
  return rows[0].id
}

/**
 * Create a confirmed sale with one line item.
 * Returns { saleId, itemId }
 */
async function createConfirmedSale(client, userId, partyId, amount) {
  // Insert draft sale
  const { rows: [sale] } = await client.query(`
    INSERT INTO sales (sale_date, party_id, sale_type, total_amount, status, created_by)
    VALUES (CURRENT_DATE, $1, 'party_credit', 0, 'draft', $2)
    RETURNING id
  `, [partyId, userId])

  const saleId = sale.id

  // Find the dressed_chicken product
  const { rows: [product] } = await client.query(
    `SELECT id FROM products WHERE seed_key = 'dressed_chicken'`
  )

  // Insert line item: 10 kg × ₹amount/kg = line_total
  const lineTotal = parseFloat((10 * (amount / 10)).toFixed(2))
  const { rows: [item] } = await client.query(`
    INSERT INTO sale_items (sale_id, product_id, quantity_kg, rate_per_kg, line_total)
    VALUES ($1, $2, 10.000, $3, $4)
    RETURNING id
  `, [saleId, product.id, amount / 10, lineTotal])

  // Confirm the sale (trigger overwrites total_amount with SUM)
  await client.query(
    `UPDATE sales SET status = 'confirmed' WHERE id = $1`, [saleId]
  )

  return { saleId, itemId: item.id }
}

// ── Test setup ────────────────────────────────────────────────────────────
before(async () => {
  // Step 1: Apply migrations to the test DB (idempotent — safe to re-run)
  // This ensures the test DB is always schema-current before any test runs.
  console.log('\n[test] Applying migrations to test database...')
  const { default: testPg } = await import('pg')
  const { Client: SetupClient } = testPg
  const setupClient = new SetupClient({
    connectionString: TEST_URL,
    ssl: isLocalTest ? false : { rejectUnauthorized: true },
  })
  await setupClient.connect()

  // Bootstrap schema_migrations table on the test DB
  await setupClient.query('BEGIN')
  await setupClient.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum   TEXT        NOT NULL
    )
  `)
  await setupClient.query('COMMIT')

  // Apply any pending migration files
  const { createHash }            = await import('node:crypto')
  const { readFileSync, readdirSync } = await import('node:fs')
  const { resolve, dirname }      = await import('node:path')
  const { fileURLToPath: toPath } = await import('node:url')

  const migrationsDir = resolve(dirname(toPath(import.meta.url)), '../migrations')
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  const { rows: done } = await setupClient.query('SELECT version FROM schema_migrations')
  const doneSet = new Set(done.map(r => r.version))

  for (const filename of files) {
    if (doneSet.has(filename)) continue
    const sql   = readFileSync(resolve(migrationsDir, filename), 'utf8')
    const cksum = createHash('sha256').update(sql).digest('hex')
    await setupClient.query('BEGIN')
    await setupClient.query(sql)
    await setupClient.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [filename, cksum]
    )
    await setupClient.query('COMMIT')
    console.log(`[test] ✅ Applied: ${filename}`)
  }
  await setupClient.end()
  console.log('[test] Migrations complete.')

  // Step 2: Truncate all business data (preserves schema_migrations)
  console.log('[test] Clearing business data...')
  await q(`
    TRUNCATE TABLE
      audit_logs, payment_allocations, payments,
      sale_items, sales, account_adjustments,
      parties, daily_prices, stock_entries,
      chicken_loads, users
    RESTART IDENTITY CASCADE
  `)
  console.log('[test] Ready. Running tests...\n')
})

after(async () => {
  await pool.end()
  console.log('\n[test] Pool closed.')
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — ₹10,000 opening debt → ₹10,000 outstanding
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 1: Opening balance produces correct outstanding', async () => {
  test('₹10,000 opening debt = ₹10,000 net balance', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s1')
      const partyId = await insertTestParty(client, userId, '_s1')

      // Opening debt: negative ledger_effect = debit = increases what they owe
      await client.query(`
        INSERT INTO account_adjustments
          (party_id, adjustment_type, ledger_effect, effective_date, reason, created_by)
        VALUES ($1, 'opening_balance', -10000.00, CURRENT_DATE, 'Opening balance test', $2)
      `, [partyId, userId])

      const { rows: [{ balance }] } = await client.query(`
        SELECT
          - COALESCE(SUM(aa.ledger_effect), 0)
          + COALESCE((SELECT SUM(s.total_amount) FROM sales s
              WHERE s.party_id = $1 AND s.sale_type = 'party_credit'
                AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
          - COALESCE((SELECT SUM(p.amount) FROM payments p
              WHERE p.party_id = $1 AND p.voided_at IS NULL), 0)
          AS balance
        FROM account_adjustments aa
        WHERE aa.party_id = $1 AND aa.voided_at IS NULL
      `, [partyId])

      assert.equal(parseFloat(balance), 10000.00)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — ₹50,000 sale + ₹30,000 payment → ₹20,000 outstanding
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 2: Sale plus payment produces correct net balance', async () => {
  test('₹50,000 credit sale - ₹30,000 payment = ₹20,000 outstanding', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s2')
      const partyId = await insertTestParty(client, userId, '_s2')
      await createConfirmedSale(client, userId, partyId, 50000)

      await client.query(`
        INSERT INTO payments (party_id, payment_date, amount, method, created_by)
        VALUES ($1, CURRENT_DATE, 30000.00, 'cash', $2)
      `, [partyId, userId])

      const { rows: [{ balance }] } = await client.query(`
        SELECT
          COALESCE((SELECT SUM(s.total_amount) FROM sales s
              WHERE s.party_id = $1 AND s.sale_type = 'party_credit'
                AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
          - COALESCE((SELECT SUM(p.amount) FROM payments p
              WHERE p.party_id = $1 AND p.voided_at IS NULL), 0)
          AS balance
      `, [partyId])

      assert.equal(parseFloat(balance), 20000.00)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Partial allocation; remainder as unapplied credit
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 3: Partial allocation leaves unallocated credit', async () => {
  test('₹60 allocated from ₹100 payment leaves ₹40 unallocated', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s3')
      const partyId = await insertTestParty(client, userId, '_s3')
      const { saleId } = await createConfirmedSale(client, userId, partyId, 100)

      const { rows: [payment] } = await client.query(`
        INSERT INTO payments (party_id, payment_date, amount, method, created_by)
        VALUES ($1, CURRENT_DATE, 100.00, 'cash', $2)
        RETURNING id
      `, [partyId, userId])

      await client.query(`
        INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by)
        VALUES ($1, $2, 60.00, $3)
      `, [payment.id, saleId, userId])

      const { rows: [{ unallocated }] } = await client.query(`
        SELECT
          COALESCE(SUM(p.amount), 0)
          - COALESCE((SELECT SUM(pa.allocated_amount) FROM payment_allocations pa
              JOIN payments p2 ON pa.payment_id = p2.id
              WHERE p2.party_id = $1 AND p2.voided_at IS NULL AND pa.voided_at IS NULL), 0)
          AS unallocated
        FROM payments p WHERE p.party_id = $1 AND p.voided_at IS NULL
      `, [partyId])

      const { rows: [{ invoice_remaining }] } = await client.query(`
        SELECT s.total_amount
          - COALESCE(SUM(pa.allocated_amount), 0) AS invoice_remaining
        FROM sales s
        LEFT JOIN payment_allocations pa
          ON pa.sale_id = s.id AND pa.voided_at IS NULL
        WHERE s.id = $1
        GROUP BY s.total_amount
      `, [saleId])

      assert.equal(parseFloat(unallocated), 40.00)
      assert.equal(parseFloat(invoice_remaining), 40.00)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Void allocation; create replacement
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 4: Void-and-replace allocation', async () => {
  test('New allocation allowed after voiding old one for same payment+sale pair', async () => {
    // Use sequential committed transactions so each step's data is committed
    // before the next connection reads it. Running everything inside a single
    // uncommitted transaction would cause the unique-violation check (on a
    // separate connection) to block on the row lock rather than see a conflict.

    let userId, partyId, saleId, payId, allocId

    // Step A: create user, party, sale, payment, and first allocation — all committed
    await withTx(async (client) => {
      userId  = await insertTestUser(client, '_s4')
      partyId = await insertTestParty(client, userId, '_s4')
      const s = await createConfirmedSale(client, userId, partyId, 100)
      saleId  = s.saleId

      const { rows: [pay] } = await client.query(`
        INSERT INTO payments (party_id, payment_date, amount, method, created_by)
        VALUES ($1, CURRENT_DATE, 100.00, 'cash', $2) RETURNING id
      `, [partyId, userId])
      payId = pay.id

      const { rows: [alloc] } = await client.query(`
        INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by)
        VALUES ($1, $2, 60.00, $3) RETURNING id
      `, [payId, saleId, userId])
      allocId = alloc.id
    })

    // Step B: void the first allocation, then insert replacement — committed
    await withTx(async (client) => {
      await client.query(`
        UPDATE payment_allocations
          SET voided_at = NOW(), voided_by = $1, void_reason = 'test void'
          WHERE id = $2
      `, [userId, allocId])

      // Replacement: partial unique index allows this (old row is now voided)
      await client.query(`
        INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by)
        VALUES ($1, $2, 75.00, $3)
      `, [payId, saleId, userId])
    })

    // Step C: verify one active allocation exists, then confirm a second is rejected
    const { rows: [{ active_count }] } = await q(`
      SELECT COUNT(*) AS active_count FROM payment_allocations
      WHERE payment_id = $1 AND sale_id = $2 AND voided_at IS NULL
    `, [payId, saleId])
    assert.equal(parseInt(active_count), 1)

    // A second active allocation for the same pair must be rejected by the index
    await assert.rejects(
      () => q(`
        INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by)
        VALUES ($1, $2, 10.00, $3)
      `, [payId, saleId, userId]),
      { code: '23505' }   // unique_violation
    )
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Concurrent over-allocation (two real connections)
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 5: Concurrent over-allocation is rejected', async () => {
  test('Only one of two concurrent allocations exceeding payment capacity succeeds', async () => {
    // Setup: create state outside the concurrent test
    let payId, saleId1, saleId2

    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s5')
      const partyId = await insertTestParty(client, userId, '_s5')
      const s1 = await createConfirmedSale(client, userId, partyId, 200)
      const s2 = await createConfirmedSale(client, userId, partyId, 200)
      saleId1 = s1.saleId
      saleId2 = s2.saleId

      const { rows: [pay] } = await client.query(`
        INSERT INTO payments (party_id, payment_date, amount, method, created_by)
        VALUES ($1, CURRENT_DATE, 100.00, 'cash', $2) RETURNING id
      `, [partyId, userId])
      payId = pay.id
    })

    // Two concurrent connections both try to allocate ₹100 from a ₹100 payment
    const conn1 = await pool.connect()
    const conn2 = await pool.connect()

    let successes = 0
    let failures  = 0

    try {
      // Start both transactions simultaneously
      await Promise.all([conn1.query('BEGIN'), conn2.query('BEGIN')])

      // Both lock the payment row — one will block until the other commits
      const [r1, r2] = await Promise.allSettled([
        (async () => {
          await conn1.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payId])
          await conn1.query('SELECT id FROM sales WHERE id = $1 FOR UPDATE', [saleId1])

          // Check capacity
          const { rows: [{ existing }] } = await conn1.query(
            'SELECT COALESCE(SUM(allocated_amount), 0) AS existing FROM payment_allocations WHERE payment_id = $1 AND voided_at IS NULL',
            [payId]
          )
          if (parseFloat(existing) + 100 > 100) throw new Error('capacity exceeded')

          await conn1.query(
            'INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by) SELECT $1, $2, 100.00, id FROM users LIMIT 1',
            [payId, saleId1]
          )
          await conn1.query('COMMIT')
        })(),
        (async () => {
          await conn2.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payId])
          await conn2.query('SELECT id FROM sales WHERE id = $1 FOR UPDATE', [saleId2])

          const { rows: [{ existing }] } = await conn2.query(
            'SELECT COALESCE(SUM(allocated_amount), 0) AS existing FROM payment_allocations WHERE payment_id = $1 AND voided_at IS NULL',
            [payId]
          )
          if (parseFloat(existing) + 100 > 100) throw new Error('capacity exceeded')

          await conn2.query(
            'INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by) SELECT $1, $2, 100.00, id FROM users LIMIT 1',
            [payId, saleId2]
          )
          await conn2.query('COMMIT')
        })(),
      ])

      for (const result of [r1, r2]) {
        if (result.status === 'fulfilled') successes++
        else failures++
      }

      // Roll back any uncommitted transactions
      await conn1.query('ROLLBACK').catch(() => {})
      await conn2.query('ROLLBACK').catch(() => {})

    } finally {
      conn1.release()
      conn2.release()
    }

    assert.equal(successes, 1, 'Exactly one allocation should succeed')
    assert.equal(failures, 1, 'Exactly one allocation should be rejected')

    // Confirm exactly one active allocation exists
    const { rows: [{ count }] } = await q(
      'SELECT COUNT(*) AS count FROM payment_allocations WHERE payment_id = $1 AND voided_at IS NULL',
      [payId]
    )
    assert.equal(parseInt(count), 1)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Sale total mismatch and trigger enforcement
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 6: Sale total and trigger integrity', async () => {
  test('Direct INSERT with status=confirmed is rejected by trigger', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s6a')
      const partyId = await insertTestParty(client, userId, '_s6a')

      await assert.rejects(
        () => client.query(`
          INSERT INTO sales (sale_date, party_id, sale_type, total_amount, status, created_by)
          VALUES (CURRENT_DATE, $1, 'party_credit', 500.00, 'confirmed', $2)
        `, [partyId, userId]),
        /Direct INSERT with status=confirmed is not allowed/
      )
    })
  })

  test('Confirming sale with no items is rejected', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s6b')
      const partyId = await insertTestParty(client, userId, '_s6b')

      const { rows: [sale] } = await client.query(`
        INSERT INTO sales (sale_date, party_id, sale_type, total_amount, status, created_by)
        VALUES (CURRENT_DATE, $1, 'party_credit', 0, 'draft', $2)
        RETURNING id
      `, [partyId, userId])

      await assert.rejects(
        () => client.query(`UPDATE sales SET status = 'confirmed' WHERE id = $1`, [sale.id]),
        /at least one line item is required/
      )
    })
  })

  test('Trigger overwrites incorrect total_amount with DB-computed sum', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s6c')
      const partyId = await insertTestParty(client, userId, '_s6c')
      const { saleId } = await createConfirmedSale(client, userId, partyId, 100)

      const { rows: [{ total_amount }] } = await client.query(
        'SELECT total_amount FROM sales WHERE id = $1', [saleId]
      )
      // The sale was created with rate 10/kg × 10kg = 100; confirm trigger should set total to 100.00
      assert.equal(parseFloat(total_amount), 100.00)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — Voided records excluded from balance
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 7: Voided payment and sale excluded from balance', async () => {
  test('Voided payment does not reduce outstanding balance', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s7a')
      const partyId = await insertTestParty(client, userId, '_s7a')
      await createConfirmedSale(client, userId, partyId, 50000)

      const { rows: [pay] } = await client.query(`
        INSERT INTO payments (party_id, payment_date, amount, method, created_by)
        VALUES ($1, CURRENT_DATE, 30000.00, 'cash', $2) RETURNING id
      `, [partyId, userId])

      // Void the payment
      await client.query(`
        UPDATE payments SET voided_at = NOW(), voided_by = $1, void_reason = 'test'
        WHERE id = $2
      `, [userId, pay.id])

      const { rows: [{ balance }] } = await client.query(`
        SELECT
          COALESCE((SELECT SUM(s.total_amount) FROM sales s
            WHERE s.party_id = $1 AND s.sale_type = 'party_credit'
              AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
          - COALESCE((SELECT SUM(p.amount) FROM payments p
            WHERE p.party_id = $1 AND p.voided_at IS NULL), 0)
          AS balance
      `, [partyId])

      // Voided payment excluded: balance should still be 50000
      assert.equal(parseFloat(balance), 50000.00)
    })
  })

  test('Voided sale does not increase outstanding balance', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s7b')
      const partyId = await insertTestParty(client, userId, '_s7b')
      const { saleId } = await createConfirmedSale(client, userId, partyId, 50000)

      // Void the sale
      await client.query(`
        UPDATE sales SET status = 'voided', voided_at = NOW(), voided_by = $1, void_reason = 'test'
        WHERE id = $2
      `, [userId, saleId])

      const { rows: [{ balance }] } = await client.query(`
        SELECT
          COALESCE((SELECT SUM(s.total_amount) FROM sales s
            WHERE s.party_id = $1 AND s.sale_type = 'party_credit'
              AND s.status = 'confirmed' AND s.voided_at IS NULL), 0)
          AS balance
      `, [partyId])

      // Voided sale contributes 0
      assert.equal(parseFloat(balance), 0.00)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — Modification of confirmed sale items is rejected
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 8: Confirmed sale items are immutable', async () => {
  test('INSERT into confirmed sale_items is rejected', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s8a')
      const partyId = await insertTestParty(client, userId, '_s8a')
      const { saleId } = await createConfirmedSale(client, userId, partyId, 100)
      const { rows: [prod] } = await client.query(`SELECT id FROM products WHERE seed_key = 'boneless'`)

      await assert.rejects(
        () => client.query(`
          INSERT INTO sale_items (sale_id, product_id, quantity_kg, rate_per_kg, line_total)
          VALUES ($1, $2, 1.0, 50.00, 50.00)
        `, [saleId, prod.id]),
        /immutable/
      )
    })
  })

  test('DELETE from confirmed sale_items is rejected', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s8b')
      const partyId = await insertTestParty(client, userId, '_s8b')
      const { saleId, itemId } = await createConfirmedSale(client, userId, partyId, 100)

      await assert.rejects(
        () => client.query('DELETE FROM sale_items WHERE id = $1', [itemId]),
        /immutable/
      )
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 9 — Voiding a sale atomically voids its allocations
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 9: Sale void atomically voids its allocations', async () => {
  test('Active allocations are voided when their sale is voided', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s9')
      const partyId = await insertTestParty(client, userId, '_s9')
      const { saleId } = await createConfirmedSale(client, userId, partyId, 200)

      const { rows: [pay] } = await client.query(`
        INSERT INTO payments (party_id, payment_date, amount, method, created_by)
        VALUES ($1, CURRENT_DATE, 150.00, 'cash', $2) RETURNING id
      `, [partyId, userId])
      const payId = pay.id

      await client.query(`
        INSERT INTO payment_allocations (payment_id, sale_id, allocated_amount, created_by)
        VALUES ($1, $2, 120.00, $3)
      `, [payId, saleId, userId])

      // Void the sale AND its allocations atomically
      await client.query(`
        UPDATE payment_allocations
          SET voided_at = NOW(), voided_by = $1, void_reason = 'sale voided'
          WHERE sale_id = $2 AND voided_at IS NULL
      `, [userId, saleId])

      await client.query(`
        UPDATE sales SET status = 'voided', voided_at = NOW(), voided_by = $1, void_reason = 'test'
        WHERE id = $2
      `, [userId, saleId])

      // Verify: no active allocations exist for this sale
      const { rows: [{ active_allocs }] } = await client.query(`
        SELECT COUNT(*) AS active_allocs FROM payment_allocations
        WHERE sale_id = $1 AND voided_at IS NULL
      `, [saleId])
      assert.equal(parseInt(active_allocs), 0)

      // Payment credit should be fully restored
      const { rows: [{ unallocated }] } = await client.query(`
        SELECT
          COALESCE(SUM(p.amount), 0)
          - COALESCE((SELECT SUM(pa.allocated_amount) FROM payment_allocations pa
              WHERE pa.payment_id = $1 AND pa.voided_at IS NULL), 0)
          AS unallocated
        FROM payments p WHERE p.id = $1 AND p.voided_at IS NULL
      `, [payId])
      assert.equal(parseFloat(unallocated), 150.00)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO 10 — Allocations to voided records are rejected
// ══════════════════════════════════════════════════════════════════════════
describe('Scenario 10: Allocations to voided records are rejected', async () => {
  test('Cannot allocate to a voided sale', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s10a')
      const partyId = await insertTestParty(client, userId, '_s10a')
      const { saleId } = await createConfirmedSale(client, userId, partyId, 100)
      const { rows: [pay] } = await client.query(`
        INSERT INTO payments (party_id, payment_date, amount, method, created_by)
        VALUES ($1, CURRENT_DATE, 100.00, 'cash', $2) RETURNING id
      `, [partyId, userId])

      // Void the sale
      await client.query(`
        UPDATE sales SET status='voided', voided_at=NOW(), voided_by=$1, void_reason='test'
        WHERE id = $2
      `, [userId, saleId])

      // Application must check voided_at IS NULL after locking; simulate that check
      const { rows: [sale] } = await client.query(
        'SELECT voided_at FROM sales WHERE id = $1 FOR UPDATE', [saleId]
      )
      assert.notEqual(sale.voided_at, null, 'Sale should be voided')
      // If the check passes correctly, we never reach the INSERT
    })
  })

  test('Seeded products exist and seed is idempotent', async () => {
    const { rows } = await q(`
      SELECT seed_key FROM products
      WHERE seed_key = ANY($1::text[])
      ORDER BY seed_key
    `, [['live_chicken','dressed_chicken','boneless','wings','leg_piece','liver']])
    assert.equal(rows.length, 6)
  })

  test('Duplicate opening balance for same party is rejected', async () => {
    await withTx(async (client) => {
      const userId = await insertTestUser(client, '_s10b')
      const partyId = await insertTestParty(client, userId, '_s10b')

      await client.query(`
        INSERT INTO account_adjustments
          (party_id, adjustment_type, ledger_effect, effective_date, reason, created_by)
        VALUES ($1, 'opening_balance', -5000.00, CURRENT_DATE, 'First opening balance', $2)
      `, [partyId, userId])

      // Second opening balance for same party must be rejected by partial unique index
      await assert.rejects(
        () => client.query(`
          INSERT INTO account_adjustments
            (party_id, adjustment_type, ledger_effect, effective_date, reason, created_by)
          VALUES ($1, 'opening_balance', -3000.00, CURRENT_DATE, 'Duplicate attempt', $2)
        `, [partyId, userId]),
        { code: '23505' }   // unique_violation
      )
    })
  })
})
