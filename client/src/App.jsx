import { useEffect, useState } from 'react'
import LoginPage from './LoginPage'
import AppShell  from './components/layout/AppShell.jsx'
import './App.css'

/**
 * App.jsx — root component.
 *
 * Manages the top-level auth state (user object or null).
 *
 * Flow:
 *   1. On mount → GET /api/auth/me to restore session from cookie.
 *   2. If valid cookie → show AppShell (sidebar + header + page content).
 *   3. If no session → show LoginPage.
 *   4. LoginPage calls onLoginSuccess(user) → set user → show AppShell.
 *   5. AppShell's Header logout button calls handleLogout →
 *      POST /api/auth/logout → clear user → show LoginPage.
 */
function App() {
  const [user,        setUser]        = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  // ── Restore session on page load ─────────────────────────
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.user) setUser(data.user) })
      .catch(() => {/* no session */})
      .finally(() => setAuthChecked(true))
  }, [])

  // ── Logout ────────────────────────────────────────────────
  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch { /* ignore */ }
    setUser(null)
  }

  // ── Loading ───────────────────────────────────────────────
  if (!authChecked) {
    return (
      <div className="auth-checking">
        <span className="auth-spinner" aria-label="Loading…" />
      </div>
    )
  }

  // ── Unauthenticated ───────────────────────────────────────
  if (!user) {
    return <LoginPage onLoginSuccess={setUser} />
  }

  // ── Authenticated ─────────────────────────────────────────
  return <AppShell user={user} onLogout={handleLogout} />
}

export default App
