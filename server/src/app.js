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
import dashboardRouter   from './routes/dashboard.js'
import reportsRouter     from './routes/reports.js'
import usersRouter       from './routes/users.js'
import settingsRouter    from './routes/settings.js'
import { requireAuth }    from './auth/middleware.js'
import { query }          from './db/pool.js'

const app = express()

// ── Reverse Proxy Trust (Required for Render / Cloudflare / ALB) ───
app.set('trust proxy', 1)

// ── Middleware ─────────────────────────────────────────────
app.use(express.json())
app.use(cookieParser())

// CORS: allow only exact configured frontend origin(s) with credentials (no wildcard with credentials)
const rawOrigins = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const allowedOrigins = rawOrigins
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server health checks, curl, mobile clients)
      if (!origin) return callback(null, true)
      if (allowedOrigins.includes(origin)) {
        return callback(null, true)
      }
      // Return false to reject origin without throwing a 500 error
      return callback(null, false)
    },
    credentials: true,
  })
)

// Lightweight origin verification for state-changing cross-origin requests
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin
    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Cross-origin request rejected.',
      })
    }
  }
  next()
})

// ── Routes ─────────────────────────────────────────────────

/**
 * GET /api/health
 * Liveness check — fast process check, no external dependencies.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status:      'Backend is running ✅',
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  })
})

/**
 * GET /api/health/ready
 * Readiness check — verifies database connectivity with a lightweight ping.
 * Safe error handling: never leaks connection strings, secrets, or internal stack traces.
 */
app.get('/api/health/ready', async (_req, res) => {
  try {
    const start = Date.now()
    await query('SELECT 1')
    const latencyMs = Date.now() - start

    return res.status(200).json({
      status:     'ready',
      database:   'connected',
      latency_ms: latencyMs,
      timestamp:  new Date().toISOString(),
    })
  } catch (err) {
    console.error('[health:ready] Database ping failed:', err.message)
    return res.status(503).json({
      status:    'unavailable',
      database:  'disconnected',
      timestamp: new Date().toISOString(),
    })
  }
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

// ── Dashboard routes ───────────────────────────────────────
// GET /api/dashboard — real-time aggregated shop KPI metrics & recent activity
app.use('/api/dashboard', dashboardRouter)

// ── Reports & Exports routes ───────────────────────────────
// GET /api/reports        — aggregated period report
// GET /api/reports/export — CSV report download
app.use('/api/reports', reportsRouter)

// ── User Management routes ─────────────────────────────────
// Admin only — manage staff, managers, roles, activation, and passwords
app.use('/api/users', usersRouter)

// ── Application Settings routes ────────────────────────────
// Read settings (authenticated) & update settings (admin only)
app.use('/api/settings', settingsRouter)

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
