/**
 * src/pages/DashboardPage.jsx
 * Phase 4 placeholder — no fabricated metrics.
 */
import './pages.css'

export default function DashboardPage({ user }) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">
            Welcome back, {user.name?.split(' ')[0] ?? 'there'} 👋
          </h2>
          <p className="page-subtitle">
            Signed in as <strong>{user.email}</strong> · role: <strong>{user.role}</strong>
          </p>
        </div>
      </div>

      <div className="placeholder-card">
        <span className="placeholder-icon">📊</span>
        <span className="placeholder-label">Dashboard</span>
        <p className="placeholder-desc">
          Summary cards and quick stats will appear here in Phase 5.
          Navigate using the sidebar to explore each module.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
