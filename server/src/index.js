/**
 * server/src/index.js
 *
 * Server entry point.
 * Imports the Express app from app.js, binds to PORT, handles graceful shutdown.
 * Tests import app.js directly (not this file) to avoid port conflicts.
 */

import dotenv from 'dotenv'
dotenv.config({ path: new URL('../../.env', import.meta.url) })

import http from 'http'
import app from './app.js'
import { closePool } from './db/pool.js'

const PORT = process.env.PORT || 5001

const server = http.createServer(app)

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
  console.log(`   Health → http://localhost:${PORT}/api/health`)
  console.log(`   Login  → POST http://localhost:${PORT}/api/auth/login`)
  console.log(`   Me     → GET  http://localhost:${PORT}/api/auth/me`)
})

// ── Graceful shutdown ──────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`)
  server.close(async () => {
    await closePool()
    console.log('[server] Shutdown complete.')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
