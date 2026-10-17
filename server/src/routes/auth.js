/**
 * server/src/routes/auth.js
 *
 * Authentication endpoints:
 *
 *   POST /api/auth/login   — accept email + password, issue JWT cookie
 *   POST /api/auth/logout  — clear JWT cookie
 *   GET  /api/auth/me      — return current user (requires valid cookie)
 *
 * Security decisions:
 *   - bcrypt.compare always runs even if user not found (prevents timing attacks)
 *   - Generic error message on bad credentials (no "email not found" leakage)
 *   - Account lockout after MAX_ATTEMPTS consecutive failures
 *   - Lockout duration: LOCKOUT_MINUTES minutes
 *   - All DB errors are logged server-side; only a generic message returned to client
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { query } from '../db/pool.js'
import { issueTokenCookie, clearTokenCookie } from '../auth/tokens.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

// Brute-force protection settings
const MAX_ATTEMPTS       = 5
const LOCKOUT_MINUTES    = 15

// A permanently-invalid bcrypt sentinel (cannot be produced by bcrypt.hash)
// Used so we always run bcrypt.compare even for non-existent emails
const DUMMY_HASH = '$2a$12$invalidhashfornonexistentemailprotection1234567'

/**
 * POST /api/auth/login
 * Body: { email: string, password: string }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {}

    // ── Basic input validation ───────────────────────────────
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Email and password are required.',
      })
    }

    const normalizedEmail = email.trim().toLowerCase()

    // ── Fetch user ───────────────────────────────────────────
    const { rows } = await query(
      `SELECT id, display_name, login_email, password_hash, role, is_active,
              failed_login_attempts, locked_until
       FROM users
       WHERE login_email = $1
       LIMIT 1`,
      [normalizedEmail]
    )

    const user = rows[0] ?? null

    // ── Lockout check (before password compare) ──────────────
    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil(
        (new Date(user.locked_until) - new Date()) / 60000
      )
      return res.status(429).json({
        error: 'Account Locked',
        message: `Too many failed attempts. Try again in ${minutesLeft} minute(s).`,
      })
    }

    // ── Password verification ────────────────────────────────
    // Always run bcrypt.compare — even for non-existent users — to prevent
    // timing attacks that reveal whether an email is registered.
    const hashToCheck = user?.password_hash ?? DUMMY_HASH
    const passwordOk  = await bcrypt.compare(password, hashToCheck)

    // ── Handle failure ───────────────────────────────────────
    if (!user || !passwordOk || !user.is_active || user.password_hash === '!') {
      if (user && passwordOk === false) {
        // Increment failure counter and possibly lock the account
        const newAttempts = (user.failed_login_attempts ?? 0) + 1
        const lockedUntil = newAttempts >= MAX_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
          : null

        await query(
          `UPDATE users
           SET failed_login_attempts = $1, locked_until = $2
           WHERE id = $3`,
          [newAttempts, lockedUntil, user.id]
        )
      }

      // Single generic message — never reveal which field is wrong
      return res.status(401).json({
        error: 'Invalid Credentials',
        message: 'Email or password is incorrect.',
      })
    }

    // ── Success: reset failure counter ───────────────────────
    const clientIp = req.ip ?? req.socket?.remoteAddress ?? null
    await query(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until          = NULL,
           last_login_at         = NOW(),
           last_login_ip         = $1
       WHERE id = $2`,
      [clientIp, user.id]
    )

    // ── Issue JWT cookie ─────────────────────────────────────
    issueTokenCookie(res, user)

    return res.json({
      message: 'Login successful.',
      user: {
        id:           user.id,
        display_name: user.display_name,
        email:        user.login_email,
        role:         user.role,
      },
    })

  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/auth/logout
 * Clears the auth cookie. Always returns 200 (idempotent).
 */
router.post('/logout', (_req, res) => {
  clearTokenCookie(res)
  return res.json({ message: 'Logged out successfully.' })
})

/**
 * GET /api/auth/me
 * Returns the current user from the JWT cookie.
 * Protected — requires valid token.
 */
router.get('/me', requireAuth, (req, res) => {
  // req.user is populated by requireAuth middleware
  return res.json({ user: req.user })
})

/**
 * POST /api/auth/change-password
 * Allows the currently logged-in user to change their own password.
 * Protected — requires valid session and verification of current password.
 */
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body ?? {}

    if (!current_password || typeof current_password !== 'string') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Current password is required.',
      })
    }

    if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'New password must be at least 8 characters long.',
      })
    }

    // Fetch user's current password hash
    const { rows } = await query(
      `SELECT password_hash FROM users WHERE id = $1 LIMIT 1`,
      [req.user.id]
    )
    const user = rows[0]
    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' })
    }

    const isMatch = await bcrypt.compare(current_password, user.password_hash)
    if (!isMatch) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Current password is incorrect.',
      })
    }

    if (current_password === new_password) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'New password must be different from the current password.',
      })
    }

    const newHash = await bcrypt.hash(new_password, 12)

    await query(
      `UPDATE users
       SET password_hash = $1,
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [newHash, req.user.id]
    )

    // Audit log without password
    await query(
      `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
       VALUES ($1, 'UPDATE', 'user', $2, $3)`,
      [
        req.user.id,
        req.user.id,
        JSON.stringify({ action: 'password_change_by_user', timestamp: new Date().toISOString() }),
      ]
    )

    return res.json({ message: 'Password changed successfully.' })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/auth/admin-ping
 * Admin-only test route — verifies RBAC is working.
 * Returns 200 for admins, 403 for other roles, 401 for unauthenticated.
 */
router.get('/admin-ping', requireAuth, requireRole('admin'), (req, res) => {
  return res.json({
    message: 'Admin access confirmed.',
    role:    req.user.role,
    email:   req.user.email,
  })
})

export default router

