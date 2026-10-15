/**
 * server/src/auth/middleware.js
 *
 * Express middleware for authentication and role-based access control (RBAC).
 *
 * Usage:
 *   import { requireAuth, requireRole } from '../auth/middleware.js'
 *
 *   // Any logged-in user:
 *   router.get('/protected', requireAuth, handler)
 *
 *   // Admin only:
 *   router.post('/admin-only', requireAuth, requireRole('admin'), handler)
 *
 *   // Admin or manager:
 *   router.post('/manage', requireAuth, requireRole('admin', 'manager'), handler)
 *
 * After requireAuth passes, req.user is set to:
 *   { id, role, email, name }
 */

import { verifyToken, COOKIE_NAME } from './tokens.js'

/**
 * requireAuth — verifies the JWT cookie and populates req.user.
 * Returns 401 if no valid token is present.
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME]

  if (!token) {
    return res.status(401).json({
      error: 'Unauthenticated',
      message: 'You must be logged in to access this resource.',
    })
  }

  try {
    const payload = verifyToken(token)
    // Attach a minimal user object — never the full DB row
    req.user = {
      id:    payload.sub,
      role:  payload.role,
      email: payload.email,
      name:  payload.name,
    }
    next()
  } catch (err) {
    // jwt.verify throws for expired or tampered tokens
    return res.status(401).json({
      error: 'Unauthenticated',
      message: 'Your session has expired. Please log in again.',
    })
  }
}

/**
 * requireRole(...roles) — factory that returns a middleware
 * allowing only users whose role is in the allowed list.
 * Must be placed AFTER requireAuth.
 *
 * @param {...string} roles  Allowed roles, e.g. 'admin', 'manager'
 */
export function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) {
      // Defensive: requireRole used without requireAuth before it
      return res.status(401).json({ error: 'Unauthenticated' })
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `This action requires one of these roles: ${roles.join(', ')}.`,
        your_role: req.user.role,
      })
    }

    next()
  }
}
