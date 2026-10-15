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
import authRouter from './routes/auth.js'

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
