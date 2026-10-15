import { useEffect, useState } from 'react'
import './App.css'

function App() {
  // ── Backend health-check state ─────────────────────────────
  const [health, setHealth] = useState({ status: 'checking…', timestamp: '' })
  const [error, setError] = useState(null)

  useEffect(() => {
    // Calls GET /api/health — forwarded to Express by the Vite proxy
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => setHealth(data))
      .catch((err) => setError(err.message))
  }, [])

  return (
    <div className="container">
      {/* ── Header ── */}
      <header className="header">
        <div className="logo">🍗</div>
        <h1>Bismillah Chicken Shop</h1>
        <p className="subtitle">Management System</p>
      </header>

      {/* ── Backend Status Card ── */}
      <section className="card">
        <h2>Backend Status</h2>

        {error ? (
          <div className="status-badge error">
            ⚠️ Cannot reach backend — is the server running?
            <br />
            <small>{error}</small>
          </div>
        ) : (
          <div className="status-badge ok">
            ✅ {health.status}
            {health.timestamp && (
              <small> — {new Date(health.timestamp).toLocaleTimeString()}</small>
            )}
          </div>
        )}
      </section>

      {/* ── Phase Roadmap ── */}
      <section className="card">
        <h2>Development Roadmap</h2>
        <ul className="roadmap">
          <li className="done">✅ Phase 1 – Project scaffold (current)</li>
          <li>⏳ Phase 2 – Database connection (Supabase)</li>
          <li>⏳ Phase 3 – Authentication</li>
          <li>⏳ Phase 4 – Business features</li>
        </ul>
      </section>

      <footer className="footer">
        Built with React + Vite + Express
      </footer>
    </div>
  )
}

export default App
