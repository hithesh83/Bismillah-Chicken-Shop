import 'dotenv/config'
import express from 'express'
import cors from 'cors'

// ── App setup ──────────────────────────────────────────────
const app = express()
const PORT = process.env.PORT || 5001

// ── Middleware ─────────────────────────────────────────────
// parse incoming JSON bodies
app.use(express.json())

// CORS – in production you would restrict origins; for dev we allow all
app.use(cors())

// ── Routes ─────────────────────────────────────────────────

/**
 * GET /api/health
 * Simple health-check endpoint so the frontend (and monitoring tools)
 * can confirm the backend is running without needing a database.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'Backend is running ✅',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  })
})

// ── 404 handler ────────────────────────────────────────────
// Catches any route that hasn't been matched above
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// ── Global error handler ───────────────────────────────────
// Express recognises a 4-argument middleware as an error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.stack)
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  })
})

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
  console.log(`   Health check → http://localhost:${PORT}/api/health`)
})
