import { useState } from 'react'
import { TriangleAlert } from './components/ui/Icons.jsx'
import './LoginPage.css'

/**
 * LoginPage.jsx
 *
 * Pixel-perfect reproduction of the reference Bismillah Chicken Shop login screen.
 *
 * Preserves all authentication logic, credentials handling, cookie management,
 * and error handling while faithfully matching the reference screenshot.
 */
export default function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',   // send/receive cookies
        body: JSON.stringify({ email: email.trim(), password }),
      })

      const data = await res.json()

      if (!res.ok) {
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
    <div className="login-screen">
      {/* ── Left Branding Panel (50% on desktop) ────────────── */}
      <div className="login-split-left" role="complementary" aria-label="Bismillah Chicken Shop Branding">
        <div className="login-split-left-bg" />
        <span className="sr-only">Bismillah Chicken Shop Management System</span>
      </div>

      {/* ── Right Authentication Panel (50% on desktop) ─────── */}
      <div className="login-split-right">
        {/* Subtle decorative sparkle in bottom right */}
        <div className="login-sparkle" aria-hidden="true" />

        <div className="login-content-box">
          {/* Mobile-only branding shown when left panel collapses */}
          <div className="login-mobile-brand">
            <img
              src="/assets/bismillah-emblem.png"
              srcSet="/assets/bismillah-emblem.png 1x, /assets/bismillah-emblem@2x.png 2x"
              alt="Bismillah Chicken Shop Emblem"
              className="login-mobile-emblem"
            />
            <h2 className="login-mobile-title">BISMILLAH CHICKEN SHOP</h2>
          </div>

          {/* ── The Login Card ───────────────────────────────── */}
          <div className="login-card">
            <h1 className="login-heading">Welcome Back</h1>
            <p className="login-subheading">Please sign in to your management account</p>

            <form className="login-form" onSubmit={handleSubmit} noValidate>
              {/* Email field */}
              <div className="login-field-group">
                <label htmlFor="login-email" className="login-label">
                  EMAIL ADDRESS
                </label>
                <div className="login-input-wrapper">
                  <span className="login-input-icon" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                  </span>
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
              </div>

              {/* Password field */}
              <div className="login-field-group">
                <label htmlFor="login-password" className="login-label">
                  PASSWORD
                </label>
                <div className="login-input-wrapper">
                  <span className="login-input-icon" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    required
                  />
                  <button
                    type="button"
                    className="login-password-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    ) : (
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Options: Remember Me & Forgot Password */}
              <div className="login-options-row">
                <label className="login-remember-me">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="login-checkbox-input"
                  />
                  <span className="login-checkbox-custom" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span className="login-remember-text">Remember Me</span>
                </label>

                <a
                  href="#forgot-password"
                  className="login-forgot-link"
                  onClick={(e) => {
                    e.preventDefault()
                    setError('Please contact your administrator to reset your password.')
                  }}
                >
                  Forgot Password?
                </a>
              </div>

              {/* Error Alert */}
              {error && (
                <div className="login-error-alert" role="alert">
                  <span className="login-error-icon"><TriangleAlert size={16} /></span>
                  <span>{error}</span>
                </div>
              )}

              {/* Sign In Button */}
              <button
                id="login-submit-btn"
                type="submit"
                className="login-submit-button"
                disabled={loading}
              >
                {loading ? (
                  <span className="login-spinner-icon" aria-label="Signing in…" />
                ) : (
                  <>
                    <svg className="login-btn-key-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M7 14c-2.76 0-5-2.24-5-5s2.24-5 5-5c2.42 0 4.44 1.72 4.9 4h7.1l2 2-2 2h-2v2h-2v-2h-3.1c-.46 2.28-2.48 4-4.9 4zm0-7c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
                    </svg>
                    <span>Sign In</span>
                  </>
                )}
              </button>
            </form>
          </div>

          {/* ── Footer Navigation Links ──────────────────────── */}
          <footer className="login-footer">
            <a
              href="#support"
              className="login-footer-link"
              onClick={(e) => {
                e.preventDefault()
                alert('Support: Contact store manager or admin.')
              }}
            >
              Support
            </a>
          </footer>
        </div>
      </div>
    </div>
  )
}
