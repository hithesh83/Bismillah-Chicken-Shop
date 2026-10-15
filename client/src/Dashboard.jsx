import './Dashboard.css'

/**
 * Dashboard.jsx
 *
 * Minimal post-login screen shown to authenticated users.
 * Phase 3 scope: shows who is logged in, their role, and a logout button.
 * Business feature panels will be added in Phase 4.
 */
export default function Dashboard({ user, onLogout }) {
  const roleLabel = {
    admin:   '👑 Admin',
    manager: '🔑 Manager',
    staff:   '🧑‍💼 Staff',
  }[user.role] ?? user.role

  return (
    <div className="dash-wrapper">
      {/* ── Top nav ── */}
      <header className="dash-header">
        <div className="dash-brand">
          <span>🍗</span>
          <span className="dash-brand-name">Bismillah Chicken Shop</span>
        </div>

        <div className="dash-user-bar">
          <div className="dash-user-info">
            <span className="dash-user-name">{user.name ?? user.email}</span>
            <span className="dash-role-badge">{roleLabel}</span>
          </div>
          <button
            id="logout-btn"
            className="dash-logout-btn"
            onClick={onLogout}
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="dash-main">
        {/* Welcome card */}
        <section className="dash-card dash-welcome">
          <h1 className="dash-welcome-title">
            Welcome back, {user.name?.split(' ')[0] ?? 'User'}! 👋
          </h1>
          <p className="dash-welcome-sub">
            You are signed in as <strong>{user.email}</strong> with
            role <strong>{user.role}</strong>.
          </p>
        </section>

        {/* Phase roadmap */}
        <section className="dash-card">
          <h2 className="dash-section-title">Development Roadmap</h2>
          <ul className="dash-roadmap">
            <li className="done">✅ Phase 1 — Project scaffold</li>
            <li className="done">✅ Phase 2 — Database foundation (Supabase)</li>
            <li className="done">✅ Phase 3 — Authentication &amp; RBAC</li>
            <li>⏳ Phase 4 — Business features (loads, sales, reports)</li>
          </ul>
        </section>

        {/* Session info card */}
        <section className="dash-card">
          <h2 className="dash-section-title">Your Session</h2>
          <dl className="dash-session-info">
            <dt>Email</dt>   <dd>{user.email}</dd>
            <dt>Role</dt>    <dd>{roleLabel}</dd>
            <dt>Session</dt> <dd>8-hour token (secure cookie)</dd>
          </dl>
        </section>
      </main>
    </div>
  )
}
