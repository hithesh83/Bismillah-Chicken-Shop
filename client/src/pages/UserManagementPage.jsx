import './pages.css'
export default function UserManagementPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">User Management</h2>
          <p className="page-subtitle">Admin only — create, deactivate, and manage staff accounts.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" disabled>+ New User</button>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">👥</span>
        <span className="placeholder-label">User Management</span>
        <p className="placeholder-desc">
          Create accounts for Admin, Manager, and Staff roles.
          Deactivate instead of deleting — all audit trails are preserved.
        </p>
        <span className="placeholder-pill">Admin only · Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
