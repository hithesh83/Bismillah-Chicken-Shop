import './pages.css'
export default function SettingsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Settings</h2>
          <p className="page-subtitle">Admin only — shop configuration and system preferences.</p>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">⚙️</span>
        <span className="placeholder-label">Settings</span>
        <p className="placeholder-desc">
          Shop name, default currency, backup options, and other system
          configuration will be managed here.
        </p>
        <span className="placeholder-pill">Admin only · Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
