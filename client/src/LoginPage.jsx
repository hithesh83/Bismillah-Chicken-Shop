import { useState } from 'react'
import './LoginPage.css'

/**
 * LoginPage
 *
 * Minimal auth UI. Handles:
 *   - Email + password form with client-side validation
 *   - Loading state during fetch
 *   - Server error messages (wrong credentials, locked account)
 *   - Calls onLoginSuccess(user) when the server returns 200
 */
export default function LoginPage({ onLoginSuccess }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState(null)
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    // ── Client-side validation ─────────────────────────────
    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }
    if (!email.includes('@')) {
      setError('Please enter a valid email address.')
      return
    }
    if (!password) {
      setError('Please enter your password.')
      return
    }

    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',   // send/receive cookies
        body:        JSON.stringify({ email: email.trim(), password }),
      })

      const data = await res.json()

      if (!res.ok) {
        // Use the server's message if available, else a generic fallback
        setError(data?.message ?? 'Login failed. Please try again.')
        return
      }

      onLoginSuccess(data.user)

    } catch {
      setError('Cannot reach the server. Is it running?')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-wrapper">
      <div className="login-card">
        {/* Brand */}
        <div className="login-brand">
          <span className="login-logo">🍗</span>
          <h1 className="login-title">Bismillah Chicken Shop</h1>
          <p className="login-subtitle">Management System</p>
        </div>

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="admin@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="login-error" role="alert">
              ⚠️ {error}
            </div>
          )}

          <button
            id="login-submit-btn"
            type="submit"
            className="login-btn"
            disabled={loading}
          >
            {loading ? (
              <span className="login-spinner" aria-label="Signing in…" />
            ) : (
              'Sign In'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
