/**
 * client/src/pages/UserManagementPage.jsx
 *
 * Full User Management Interface — Admin Only.
 *
 * Capabilities:
 *   • User list with search, role filters, and active/inactive status filters.
 *   • Summary count cards: Total, Active, Admin, Manager, Staff.
 *   • Create User modal (+ New User) with role selection & password validation.
 *   • Edit Profile modal (display name & login email).
 *   • Change Role modal with last-active-admin safeguard.
 *   • Safe Deactivate / Reactivate confirmation dialog.
 *   • Admin-initiated Password Reset modal.
 *   • Detail drawer / modal showing profile metadata & chronological audit trail.
 */

import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState, RoleBadge, StatusBadge } from '../components/ui/UIStates.jsx'
import {
  Users,
  UserCheck,
  Crown,
  Briefcase,
  UsersRound,
  RefreshCw,
  Pencil,
  Shield,
  Key,
  CircleX,
  CircleCheck,
  TriangleAlert,
  X,
} from '../components/ui/Icons.jsx'
import './pages.css'
import './UserManagementPage.css'

function fmtDateTime(v) {
  if (!v) return 'Never'
  const d = new Date(v)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
}

function getInitials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return parts[0].slice(0, 2).toUpperCase()
}

export default function UserManagementPage({ user: currentUser, addToast }) {
  const isAdmin = currentUser?.role === 'admin'

  const [users, setUsers] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  // Filters
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  // Modals state
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editUser, setEditUser] = useState(null)
  const [roleUser, setRoleUser] = useState(null)
  const [resetUser, setResetUser] = useState(null)
  const [statusUser, setStatusUser] = useState(null)

  // Submitting flags
  const [submitting, setSubmitting] = useState(false)

  // Fetch users from server
  const fetchUsers = useCallback(async (isRefresh = false) => {
    if (!isAdmin) {
      setLoading(false)
      return
    }

    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (roleFilter) params.set('role', roleFilter)
      if (statusFilter !== 'all') params.set('status', statusFilter)

      const res = await fetch(`/api/users?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.message || `Server returned HTTP ${res.status}`)
      }
      const data = await res.json()
      setUsers(data.users || [])
      setSummary(data.summary || null)
      if (isRefresh && addToast) {
        addToast({ type: 'info', message: 'User list refreshed.' })
      }
    } catch (err) {
      setError(err.message || 'Failed to load users.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [isAdmin, search, roleFilter, statusFilter, addToast])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])


  // ── Handlers ────────────────────────────────────────────────
  const handleCreateSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    const formData = new FormData(e.target)
    const body = {
      display_name: formData.get('display_name'),
      login_email:  formData.get('login_email'),
      role:         formData.get('role'),
      password:     formData.get('password'),
    }

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || 'Failed to create user.')

      if (addToast) addToast({ type: 'success', message: `User ${json.user.display_name} created successfully.` })
      setIsCreateOpen(false)
      fetchUsers()
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleEditSubmit = async (e) => {
    e.preventDefault()
    if (!editUser) return
    setSubmitting(true)
    const formData = new FormData(e.target)
    const body = {
      display_name: formData.get('display_name'),
      login_email:  formData.get('login_email'),
    }

    try {
      const res = await fetch(`/api/users/${editUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || 'Failed to update user profile.')

      if (addToast) addToast({ type: 'success', message: `Profile updated for ${json.user.display_name}.` })
      setEditUser(null)
      fetchUsers()
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleRoleSubmit = async (e) => {
    e.preventDefault()
    if (!roleUser) return
    setSubmitting(true)
    const formData = new FormData(e.target)
    const newRole = formData.get('role')

    try {
      const res = await fetch(`/api/users/${roleUser.id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role: newRole }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || 'Failed to change role.')

      if (addToast) addToast({ type: 'success', message: json.message })
      setRoleUser(null)
      fetchUsers()
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleResetPasswordSubmit = async (e) => {
    e.preventDefault()
    if (!resetUser) return
    setSubmitting(true)
    const formData = new FormData(e.target)
    const newPassword = formData.get('new_password')

    try {
      const res = await fetch(`/api/users/${resetUser.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ new_password: newPassword }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || 'Failed to reset password.')

      if (addToast) addToast({ type: 'success', message: json.message })
      setResetUser(null)
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleStatusToggle = async () => {
    if (!statusUser) return
    setSubmitting(true)
    const targetStatus = !statusUser.is_active

    try {
      const res = await fetch(`/api/users/${statusUser.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: targetStatus }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || 'Failed to update account status.')

      if (addToast) addToast({ type: 'success', message: json.message })
      setStatusUser(null)
      fetchUsers()
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="page users-page">
        <div className="placeholder-card">
          <span className="placeholder-icon"><Shield size={40} /></span>
          <span className="placeholder-label">Access Restricted</span>
          <p className="placeholder-desc">
            User management requires <strong>Administrator</strong> privileges.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="page users-page">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">User Management</h1>
          <p className="page-subtitle">
            Create, monitor, and manage staff accounts, roles, and administrative access.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsCreateOpen(true)}
          >
            <span>+</span> New User
          </button>
        </div>
      </div>

      {/* ── Summary Count Cards ─────────────────────────────────── */}
      {summary && (
        <section className="users-summary-grid" aria-label="User Accounts Overview">
          <div className="user-summary-card">
            <span className="user-summary-icon"><Users size={20} /></span>
            <div className="user-summary-details">
              <span className="user-summary-label">Total Users</span>
              <span className="user-summary-value">{summary.total_users ?? 0}</span>
            </div>
          </div>
          <div className="user-summary-card">
            <span className="user-summary-icon"><UserCheck size={20} /></span>
            <div className="user-summary-details">
              <span className="user-summary-label">Active Users</span>
              <span className="user-summary-value" style={{ color: 'var(--color-ok)' }}>
                {summary.active_users ?? 0}
              </span>
            </div>
          </div>
          <div className="user-summary-card">
            <span className="user-summary-icon"><Crown size={20} /></span>
            <div className="user-summary-details">
              <span className="user-summary-label">Admins</span>
              <span className="user-summary-value">{summary.admin_count ?? 0}</span>
            </div>
          </div>
          <div className="user-summary-card">
            <span className="user-summary-icon"><Briefcase size={20} /></span>
            <div className="user-summary-details">
              <span className="user-summary-label">Managers</span>
              <span className="user-summary-value">{summary.manager_count ?? 0}</span>
            </div>
          </div>
          <div className="user-summary-card">
            <span className="user-summary-icon"><UsersRound size={20} /></span>
            <div className="user-summary-details">
              <span className="user-summary-label">Staff</span>
              <span className="user-summary-value">{summary.staff_count ?? 0}</span>
            </div>
          </div>
        </section>
      )}

      {/* ── Search & Filter Controls ────────────────────────────── */}
      <section className="users-filter-bar">
        <div className="users-filter-group">
          <input
            type="search"
            className="users-search-input"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <select
            className="users-select-filter"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          >
            <option value="">All Roles</option>
            <option value="admin">Admin</option>
            <option value="manager">Manager</option>
            <option value="staff">Staff</option>
          </select>

          <select
            className="users-select-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="active">Active Only</option>
            <option value="inactive">Inactive Only</option>
          </select>
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => fetchUsers(true)}
          disabled={refreshing}
          title="Refresh user list"
        >
          <span className={`report-spin-icon ${refreshing ? 'spinning' : ''}`}><RefreshCw size={15} /></span>
          <span>Refresh</span>
        </button>
      </section>

      {/* ── User List Table ─────────────────────────────────────── */}
      {loading ? (
        <LoadingState label="Loading users and permission matrix…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => fetchUsers(false)} />
      ) : users.length === 0 ? (
        <EmptyState
          title="No users found"
          message="No users match the current search or filters."
          action={() => setIsCreateOpen(true)}
          actionLabel="+ Create User"
        />
      ) : (
        <div className="users-table-wrapper">
          <table className="users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Login (IST)</th>
                <th>Account Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === currentUser?.id
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="user-identity-cell">
                        <div className="user-avatar-initials">
                          {getInitials(u.display_name)}
                        </div>
                        <div className="user-name-box">
                          <span className="user-full-name">
                            {u.display_name} {isSelf && <small style={{ color: 'var(--color-accent)' }}>(You)</small>}
                          </span>
                          <span className="user-email-text">{u.login_email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <RoleBadge role={u.role} />
                    </td>
                    <td>
                      <StatusBadge status={u.is_active ? 'active' : 'inactive'} />
                    </td>
                    <td style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                      {fmtDateTime(u.last_login_at)}
                    </td>
                    <td style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                      {new Date(u.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })}
                    </td>
                    <td>
                      <div className="user-actions-cell">
                        <button
                          type="button"
                          className="btn-table-action"
                          onClick={() => setEditUser(u)}
                          title="Edit Profile"
                        >
                          <Pencil size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Edit
                        </button>

                        <button
                          type="button"
                          className="btn-table-action"
                          onClick={() => setRoleUser(u)}
                          title="Change Role"
                        >
                          <Shield size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Role
                        </button>

                        <button
                          type="button"
                          className="btn-table-action"
                          onClick={() => setResetUser(u)}
                          title="Reset Password"
                        >
                          <Key size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Reset Pass
                        </button>


                        <button
                          type="button"
                          className={`btn-table-action ${u.is_active ? 'action-deactivate' : 'action-reactivate'}`}
                          onClick={() => setStatusUser(u)}
                          title={u.is_active ? 'Deactivate Account' : 'Reactivate Account'}
                        >
                          {u.is_active ? (
                            <><CircleX size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Deactivate</>
                          ) : (
                            <><CircleCheck size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Reactivate</>
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Modal: Create User ──────────────────────────────────── */}
      {isCreateOpen && (
        <div className="modal-overlay" onClick={() => !submitting && setIsCreateOpen(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title"><span>+</span> Create New Account</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setIsCreateOpen(false)}
                disabled={submitting}
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label" htmlFor="new-name">Full Name *</label>
                  <input
                    id="new-name"
                    name="display_name"
                    className="form-input"
                    placeholder="e.g. Tariq Mehmood"
                    required
                    minLength={2}
                    maxLength={100}
                    disabled={submitting}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="new-email">Login Email *</label>
                  <input
                    id="new-email"
                    name="login_email"
                    type="email"
                    className="form-input"
                    placeholder="e.g. tariq@bismillah.local"
                    required
                    disabled={submitting}
                  />
                  <span className="form-hint">Used for sign in. Normalized to lowercase.</span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="new-role">Role *</label>
                  <select
                    id="new-role"
                    name="role"
                    className="form-select"
                    defaultValue="staff"
                    disabled={submitting}
                  >
                    <option value="staff">Staff — Daily sales, chicken loads, stock observations</option>
                    <option value="manager">Manager — Operations, pricing, payments, reports</option>
                    <option value="admin">Administrator — Full system, user management & settings</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="new-password">Initial Password *</label>
                  <input
                    id="new-password"
                    name="password"
                    type="password"
                    className="form-input"
                    placeholder="Minimum 8 characters"
                    required
                    minLength={8}
                    disabled={submitting}
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                >
                  {submitting ? 'Creating User…' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Edit Profile ─────────────────────────────────── */}
      {editUser && (
        <div className="modal-overlay" onClick={() => !submitting && setEditUser(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title"><span><Pencil size={18} /></span> Edit Profile</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setEditUser(null)}
                disabled={submitting}
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleEditSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label" htmlFor="edit-name">Full Name *</label>
                  <input
                    id="edit-name"
                    name="display_name"
                    className="form-input"
                    defaultValue={editUser.display_name}
                    required
                    minLength={2}
                    disabled={submitting}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="edit-email">Login Email *</label>
                  <input
                    id="edit-email"
                    name="login_email"
                    type="email"
                    className="form-input"
                    defaultValue={editUser.login_email}
                    required
                    disabled={submitting}
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditUser(null)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                >
                  {submitting ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Change Role ──────────────────────────────────── */}
      {roleUser && (
        <div className="modal-overlay" onClick={() => !submitting && setRoleUser(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title"><span><Shield size={18} /></span> Change Account Role</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setRoleUser(null)}
                disabled={submitting}
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleRoleSubmit}>
              <div className="modal-body">
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted)' }}>
                  Changing role for <strong>{roleUser.display_name}</strong> (<code>{roleUser.login_email}</code>).
                </p>

                <div className="form-group">
                  <label className="form-label" htmlFor="role-select">Select New Role *</label>
                  <select
                    id="role-select"
                    name="role"
                    className="form-select"
                    defaultValue={roleUser.role}
                    disabled={submitting}
                  >
                    <option value="staff">Staff — Daily sales, chicken loads, stock counts</option>
                    <option value="manager">Manager — Operations, pricing, payments, reports</option>
                    <option value="admin">Administrator — Full system access & user management</option>
                  </select>
                </div>

                {roleUser.role === 'admin' && (
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-warning)' }}>
                    <TriangleAlert size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Note: You cannot demote the last active administrator in the system.
                  </p>
                )}
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRoleUser(null)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                >
                  {submitting ? 'Updating…' : 'Update Role'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Reset Password ───────────────────────────────── */}
      {resetUser && (
        <div className="modal-overlay" onClick={() => !submitting && setResetUser(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title"><span><Key size={18} /></span> Reset User Password</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setResetUser(null)}
                disabled={submitting}
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleResetPasswordSubmit}>
              <div className="modal-body">
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted)' }}>
                  Resetting credentials for <strong>{resetUser.display_name}</strong> (<code>{resetUser.login_email}</code>).
                </p>

                <div className="form-group">
                  <label className="form-label" htmlFor="reset-pass">New Password *</label>
                  <input
                    id="reset-pass"
                    name="new_password"
                    type="password"
                    className="form-input"
                    placeholder="Minimum 8 characters"
                    required
                    minLength={8}
                    disabled={submitting}
                  />
                  <span className="form-hint">
                    The password will be securely hashed with bcrypt and takes effect immediately.
                  </span>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setResetUser(null)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                >
                  {submitting ? 'Resetting…' : 'Set New Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Confirm Deactivation / Reactivation ─────────── */}
      {statusUser && (
        <div className="modal-overlay" onClick={() => !submitting && setStatusUser(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">
                {statusUser.is_active ? (
                  <><CircleX size={18} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Deactivate Account</>
                ) : (
                  <><CircleCheck size={18} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Reactivate Account</>
                )}
              </h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setStatusUser(null)}
                disabled={submitting}
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 'var(--text-sm)' }}>
                Are you sure you want to {statusUser.is_active ? 'deactivate' : 'reactivate'}{' '}
                <strong>{statusUser.display_name}</strong> (<code>{statusUser.login_email}</code>)?
              </p>
              {statusUser.is_active ? (
                <div style={{ background: 'var(--color-error-dim)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-error)' }}>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}>
                    • Deactivating prevents login and immediately invalidates active sessions.<br />
                    • Historical sales, payments, loads, and audit logs are <strong>fully preserved</strong>.<br />
                    • Accounts can be reactivated at any time by an administrator.
                  </p>
                </div>
              ) : (
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-ok)' }}>
                  Reactivating will restore login access and reset any lockout flags.
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStatusUser(null)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${statusUser.is_active ? 'btn-danger' : 'btn-primary'}`}
                onClick={handleStatusToggle}
                disabled={submitting}
                style={statusUser.is_active ? { background: 'var(--color-error)', borderColor: 'var(--color-error)', color: '#fff' } : {}}
              >
                {submitting ? 'Processing…' : statusUser.is_active ? 'Confirm Deactivation' : 'Confirm Reactivation'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
