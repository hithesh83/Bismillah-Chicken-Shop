/**
 * server/src/routes/users.js
 *
 * User Management API endpoints — Admin only.
 *
 * Capabilities:
 *   1. GET    /api/users                 — list users with search, role/status filters, & counts
 *   2. GET    /api/users/:id             — single user details + audit trail
 *   3. POST   /api/users                 — create user (Admin, Manager, Staff) with bcrypt hash
 *   4. PATCH  /api/users/:id             — update display_name / login_email
 *   5. PATCH  /api/users/:id/role        — change role with last-active-admin safeguard
 *   6. PATCH  /api/users/:id/status      — activate/deactivate with last-active-admin safeguard
 *   7. POST   /api/users/:id/reset-password — admin password reset
 *
 * Security & Integrity:
 *   - Never returns password_hash or reset tokens.
 *   - Enforces last-active-admin protection (cannot demote or deactivate the last admin).
 *   - Never performs hard deletes (is_active = FALSE preserves all historical records).
 *   - Audits every create, update, role change, status change, and password reset.
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../auth/middleware.js'

const router = Router()

// All user management routes require admin role
router.use(requireAuth, requireRole('admin'))

const ALLOWED_ROLES = ['admin', 'manager', 'staff']
const BCRYPT_ROUNDS = 12

// ══════════════════════════════════════════════════════════════════════════
// 1. GET /api/users
// ══════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res, next) => {
  try {
    const { search, role, status } = req.query

    const conditions = []
    const params = []
    let pIdx = 1

    if (search && typeof search === 'string' && search.trim()) {
      conditions.push(`(u.display_name ILIKE $${pIdx} OR u.login_email ILIKE $${pIdx})`)
      params.push(`%${search.trim()}%`)
      pIdx++
    }

    if (role && ALLOWED_ROLES.includes(role.toLowerCase())) {
      conditions.push(`u.role = $${pIdx}`)
      params.push(role.toLowerCase())
      pIdx++
    }

    if (status === 'active') {
      conditions.push(`u.is_active = TRUE`)
    } else if (status === 'inactive') {
      conditions.push(`u.is_active = FALSE`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const listSql = `
      SELECT
        u.id,
        u.display_name,
        u.login_email,
        u.role,
        u.is_active,
        u.created_at,
        u.updated_at,
        u.last_login_at,
        u.failed_login_attempts,
        u.locked_until
      FROM users u
      ${whereClause}
      ORDER BY
        CASE u.role
          WHEN 'admin' THEN 1
          WHEN 'manager' THEN 2
          ELSE 3
        END,
        u.display_name ASC
    `
    const { rows: users } = await query(listSql, params)

    // Summary counts across all users
    const summarySql = `
      SELECT
        COUNT(*)::INT                                             AS total_users,
        COUNT(CASE WHEN is_active = TRUE THEN 1 END)::INT         AS active_users,
        COUNT(CASE WHEN is_active = FALSE THEN 1 END)::INT        AS inactive_users,
        COUNT(CASE WHEN role = 'admin' AND is_active = TRUE THEN 1 END)::INT AS admin_count,
        COUNT(CASE WHEN role = 'manager' AND is_active = TRUE THEN 1 END)::INT AS manager_count,
        COUNT(CASE WHEN role = 'staff' AND is_active = TRUE THEN 1 END)::INT AS staff_count
      FROM users
    `
    const { rows: [summary] } = await query(summarySql)

    return res.json({
      users,
      summary,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 2. GET /api/users/:id
// ══════════════════════════════════════════════════════════════════════════
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params

    const { rows: [user] } = await query(
      `SELECT
         id, display_name, login_email, role, is_active,
         created_at, updated_at, last_login_at, last_login_ip,
         failed_login_attempts, locked_until
       FROM users
       WHERE id = $1`,
      [id]
    )

    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' })
    }

    // Fetch user audit history
    const auditSql = `
      SELECT
        al.id,
        al.action_type,
        al.event_timestamp,
        al.change_metadata,
        u.display_name AS actor_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.entity_type = 'user' AND al.entity_id = $1
      ORDER BY al.event_timestamp DESC
      LIMIT 30
    `
    const { rows: audit } = await query(auditSql, [id])

    return res.json({ user, audit })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 3. POST /api/users
// ══════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res, next) => {
  try {
    const { display_name, login_email, password, role = 'staff' } = req.body ?? {}

    if (!display_name || typeof display_name !== 'string' || display_name.trim().length < 2) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Display name must be at least 2 characters.',
      })
    }

    if (!login_email || typeof login_email !== 'string' || !login_email.includes('@')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'A valid email address is required.',
      })
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Password must be at least 8 characters long.',
      })
    }

    const normalizedRole = String(role).toLowerCase()
    if (!ALLOWED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Role must be one of: ${ALLOWED_ROLES.join(', ')}.`,
      })
    }

    const cleanName  = display_name.trim()
    const cleanEmail = login_email.trim().toLowerCase()

    // Check duplicate
    const { rows: existing } = await query(
      `SELECT id FROM users WHERE login_email = $1`,
      [cleanEmail]
    )
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A user with this email address already exists.',
      })
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    const insertSql = `
      INSERT INTO users (display_name, login_email, password_hash, role, is_active)
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING id, display_name, login_email, role, is_active, created_at, updated_at
    `
    const { rows: [newUser] } = await query(insertSql, [
      cleanName,
      cleanEmail,
      passwordHash,
      normalizedRole,
    ])

    // Audit log (never log password or hash)
    await query(
      `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
       VALUES ($1, 'CREATE', 'user', $2, $3)`,
      [
        req.user.id,
        newUser.id,
        JSON.stringify({
          display_name: cleanName,
          login_email:  cleanEmail,
          role:         normalizedRole,
        }),
      ]
    )

    return res.status(201).json({
      message: 'User created successfully.',
      user: newUser,
    })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A user with this email address already exists.',
      })
    }
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 4. PATCH /api/users/:id (Profile: name, email)
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const { display_name, login_email } = req.body ?? {}

    const { rows: [existing] } = await query(
      `SELECT id, display_name, login_email, role, is_active FROM users WHERE id = $1`,
      [id]
    )
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' })
    }

    const updates = []
    const params = []
    let pIdx = 1

    const changes = {}

    if (display_name !== undefined) {
      if (typeof display_name !== 'string' || display_name.trim().length < 2) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Display name must be at least 2 characters.',
        })
      }
      updates.push(`display_name = $${pIdx}`)
      params.push(display_name.trim())
      changes.display_name = { from: existing.display_name, to: display_name.trim() }
      pIdx++
    }

    if (login_email !== undefined) {
      const cleanEmail = String(login_email).trim().toLowerCase()
      if (!cleanEmail || !cleanEmail.includes('@')) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'A valid email address is required.',
        })
      }
      if (cleanEmail !== existing.login_email) {
        const { rows: dupes } = await query(
          `SELECT id FROM users WHERE login_email = $1 AND id != $2`,
          [cleanEmail, id]
        )
        if (dupes.length > 0) {
          return res.status(409).json({
            error: 'Conflict',
            message: 'A user with this email address already exists.',
          })
        }
        updates.push(`login_email = $${pIdx}`)
        params.push(cleanEmail)
        changes.login_email = { from: existing.login_email, to: cleanEmail }
        pIdx++
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No profile updates provided.',
      })
    }

    updates.push(`updated_at = NOW()`)
    params.push(id)

    const updateSql = `
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${pIdx}
      RETURNING id, display_name, login_email, role, is_active, updated_at
    `
    const { rows: [updatedUser] } = await query(updateSql, params)

    // Audit log
    await query(
      `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
       VALUES ($1, 'UPDATE', 'user', $2, $3)`,
      [req.user.id, id, JSON.stringify({ action: 'profile_update', changes })]
    )

    return res.json({
      message: 'User profile updated.',
      user: updatedUser,
    })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A user with this email address already exists.',
      })
    }
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 5. PATCH /api/users/:id/role
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id/role', async (req, res, next) => {
  try {
    const { id } = req.params
    const { role } = req.body ?? {}

    const normalizedRole = String(role).toLowerCase()
    if (!ALLOWED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Role must be one of: ${ALLOWED_ROLES.join(', ')}.`,
      })
    }

    const { rows: [targetUser] } = await query(
      `SELECT id, display_name, login_email, role, is_active FROM users WHERE id = $1`,
      [id]
    )
    if (!targetUser) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' })
    }

    if (targetUser.role === normalizedRole) {
      return res.json({ message: 'Role unchanged.', user: targetUser })
    }

    // Last Active Admin Protection: if target is admin and demoting to manager or staff
    if (targetUser.role === 'admin' && normalizedRole !== 'admin') {
      const { rows: [adminCountRow] } = await query(
        `SELECT COUNT(*)::INT AS count
         FROM users
         WHERE role = 'admin' AND is_active = TRUE AND id != $1`,
        [id]
      )
      if (adminCountRow.count === 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot demote the last active administrator. Another active administrator must exist first.',
        })
      }
    }

    const { rows: [updatedUser] } = await query(
      `UPDATE users
       SET role = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, display_name, login_email, role, is_active, updated_at`,
      [normalizedRole, id]
    )

    // Audit log
    await query(
      `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
       VALUES ($1, 'UPDATE', 'user', $2, $3)`,
      [
        req.user.id,
        id,
        JSON.stringify({
          action: 'role_change',
          previous_role: targetUser.role,
          new_role: normalizedRole,
        }),
      ]
    )

    return res.json({
      message: `User role updated to ${normalizedRole}.`,
      user: updatedUser,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 6. PATCH /api/users/:id/status (Activate / Deactivate)
// ══════════════════════════════════════════════════════════════════════════
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params
    const { is_active } = req.body ?? {}

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Field "is_active" must be a boolean.',
      })
    }

    const { rows: [targetUser] } = await query(
      `SELECT id, display_name, login_email, role, is_active FROM users WHERE id = $1`,
      [id]
    )
    if (!targetUser) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' })
    }

    // Last Active Admin Protection: cannot deactivate the last admin
    if (targetUser.role === 'admin' && !is_active && targetUser.is_active) {
      const { rows: [adminCountRow] } = await query(
        `SELECT COUNT(*)::INT AS count
         FROM users
         WHERE role = 'admin' AND is_active = TRUE AND id != $1`,
        [id]
      )
      if (adminCountRow.count === 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot deactivate the last active administrator. Another active administrator must exist first.',
        })
      }
    }

    let updateSql
    let params
    if (is_active) {
      // Reactivate: unlock account and clear failed attempts
      updateSql = `
        UPDATE users
        SET is_active = TRUE,
            failed_login_attempts = 0,
            locked_until = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, display_name, login_email, role, is_active, updated_at
      `
      params = [id]
    } else {
      // Deactivate
      updateSql = `
        UPDATE users
        SET is_active = FALSE,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, display_name, login_email, role, is_active, updated_at
      `
      params = [id]
    }

    const { rows: [updatedUser] } = await query(updateSql, params)

    // Audit log
    await query(
      `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
       VALUES ($1, 'UPDATE', 'user', $2, $3)`,
      [
        req.user.id,
        id,
        JSON.stringify({
          action: is_active ? 'reactivate' : 'deactivate',
          previous_status: targetUser.is_active ? 'active' : 'inactive',
          new_status: is_active ? 'active' : 'inactive',
        }),
      ]
    )

    return res.json({
      message: `User account ${is_active ? 'reactivated' : 'deactivated'} successfully.`,
      user: updatedUser,
    })
  } catch (err) {
    next(err)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 7. POST /api/users/:id/reset-password (Admin password reset)
// ══════════════════════════════════════════════════════════════════════════
router.post('/:id/reset-password', async (req, res, next) => {
  try {
    const { id } = req.params
    const { new_password } = req.body ?? {}

    if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'New password must be at least 8 characters long.',
      })
    }

    const { rows: [targetUser] } = await query(
      `SELECT id, display_name, login_email, role, is_active FROM users WHERE id = $1`,
      [id]
    )
    if (!targetUser) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' })
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS)

    await query(
      `UPDATE users
       SET password_hash = $1,
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [newHash, id]
    )

    // Audit log (NEVER store password or hash)
    await query(
      `INSERT INTO audit_logs (actor_id, action_type, entity_type, entity_id, change_metadata)
       VALUES ($1, 'UPDATE', 'user', $2, $3)`,
      [
        req.user.id,
        id,
        JSON.stringify({
          action: 'admin_password_reset',
          target_email: targetUser.login_email,
        }),
      ]
    )

    return res.json({
      message: `Password reset successfully for ${targetUser.display_name}.`,
    })
  } catch (err) {
    next(err)
  }
})

export default router
