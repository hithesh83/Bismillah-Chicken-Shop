/**
 * server/src/app.js
 *
 * Express application factory.
 * Separated from server/src/index.js so tests can import the app
 * without binding a port or starting the server.
 *
 * index.js is responsible for: starting the server, graceful shutdown.
 * app.js is responsible for:   middleware, routing, error handling.
 */

import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { readEnvOptional } from './config.js'
import authRouter          from './routes/auth.js'
import productsRouter      from './routes/products.js'
import dailyPricesRouter   from './routes/dailyPrices.js'
import chickenLoadsRouter  from './routes/chickenLoads.js'
import stockEntriesRouter from './routes/stockEntries.js'
import customersRouter    from './routes/customers.js'
import salesRouter        from './routes/sales.js'
import paymentsRouter     from './routes/payments.js'
import outstandingRouter, { getCustomerStatement } from './routes/outstanding.js'
import { requireAuth }    from './auth/middleware.js'

const app = express()

// ── Middleware ─────────────────────────────────────────────
app.use(express.json())
app.use(cookieParser())

// CORS: allow the configured frontend origin with credentials (needed for cookies)
const allowedOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
app.use(cors({
  origin:      allowedOrigin,
  credentials: true,
}))

// ── Routes ─────────────────────────────────────────────────

/**
 * GET /api/health
 * Liveness check — no database required.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status:      'Backend is running ✅',
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  })
})

/**
 * GET /api/db-status  (development only)
 * Shows whether env vars are configured — no credential values.
 */
app.get('/api/db-status', (_req, res) => {
  if (readEnvOptional('NODE_ENV', 'development') === 'production') {
    return res.status(404).json({ error: 'Route not found' })
  }
  res.json({
    database_url_configured:        !!(process.env.DATABASE_URL),
    database_url_direct_configured: !!(process.env.DATABASE_URL_DIRECT),
    jwt_secret_configured:          !!(process.env.JWT_SECRET),
  })
})

// ── Auth routes ────────────────────────────────────────────
// POST /api/auth/login
// POST /api/auth/logout
// GET  /api/auth/me
// GET  /api/auth/admin-ping  (admin-only test route)
app.use('/api/auth', authRouter)

// ── Products routes ────────────────────────────────────────
// GET    /api/products               — list (all roles)
// GET    /api/products/:id           — single + price history (all roles)
// POST   /api/products               — create (admin)
// PATCH  /api/products/:id           — update name/category/notes (admin)
// PATCH  /api/products/:id/status    — activate / deactivate (admin)
app.use('/api/products', productsRouter)

// ── Daily prices routes ────────────────────────────────────
// GET  /api/daily-prices             — list with filters (all roles)
// GET  /api/daily-prices/today       — today's prices for all active products
// GET  /api/daily-prices/:pid/history — price history for one product
// POST /api/daily-prices             — set price for a date (admin)
// DELETE /api/daily-prices/:id       — remove future price (admin)
app.use('/api/daily-prices', dailyPricesRouter)

// ── Chicken loads routes ───────────────────────────────────
// GET   /api/chicken-loads             — paginated list with filters (all roles)
// GET   /api/chicken-loads/:id         — single load detail + corrections + audit
// POST  /api/chicken-loads             — create a new load (staff + admin)
// PATCH /api/chicken-loads/:id/stock   — update remaining stock (staff + admin)
// POST  /api/chicken-loads/:id/correct — admin correction workflow (admin only)
app.use('/api/chicken-loads', chickenLoadsRouter)

// ── Remaining Stock / Stock observations routes ─────────────
// GET  /api/stock-entries/latest       — latest readings for all active products
// GET  /api/stock-entries              — history with filters (date range, product, category)
// GET  /api/stock-entries/:id          — single observation detail, corrections, & audit
// POST /api/stock-entries              — record manual observation (Staff + Admin)
// POST /api/stock-entries/:id/correct  — authorized correction (Admin only)
app.use('/api/stock-entries', stockEntriesRouter)
app.use('/api/remaining-stock', stockEntriesRouter)

// ── Customers / Parties routes ─────────────────────────────
// GET   /api/customers            — list with search (name, party_code, phone) & filters
// GET   /api/customers/:id        — single customer details, opening balance, & audit
// POST  /api/customers            — create customer profile + auditable opening balance
// PUT   /api/customers/:id        — update customer details / opening balance
// PATCH /api/customers/:id/status — activate / deactivate customer (Admin only)
app.use('/api/customers', customersRouter)
app.use('/api/parties',   customersRouter)

// ── Sales routes ───────────────────────────────────────────
// GET   /api/sales          — list sales with search, date range, type, & payment status
// GET   /api/sales/:id      — single sale detail, line items, payments, & audit trail
// POST  /api/sales          — create sale (multi-item, walk-in or credit/party, initial payment)
// POST  /api/sales/:id/void — void confirmed sale (Admin only)
app.use('/api/sales', salesRouter)

// ── Payments routes ────────────────────────────────────────
// GET  /api/payments             — list payment receipts with search & filters
// GET  /api/payments/:id         — single payment detail, allocations, & audit
// POST /api/payments             — record payment receipt (FIFO, specific, or advance)
// POST /api/payments/:id/void    — authorized void (Admin only)
app.use('/api/payments', paymentsRouter)

// ── Outstanding & Customer Ledger routes ───────────────────
// GET /api/outstanding                    — customer balances with search & filters
// GET /api/outstanding/:party_id/invoices — open unpaid credit invoices
// GET /api/ledger/:party_id               — chronological statement with running balance
// GET /api/customers/:id/statement        — customer statement alias
app.use('/api/outstanding', outstandingRouter)
app.use('/api/ledger', outstandingRouter)
app.get('/api/customers/:id/statement', requireAuth, getCustomerStatement)

// ── 404 handler ────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// ── Global error handler ───────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.stack)
  res.status(500).json({
    error:   'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  })
})

export default app
