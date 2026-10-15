import './pages.css'
export default function CustomersPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Customers</h2>
          <p className="page-subtitle">Manage customer accounts and view their outstanding balances.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" disabled>+ New Customer</button>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">🤝</span>
        <span className="placeholder-label">Customers</span>
        <p className="placeholder-desc">
          Each customer has a ledger tracking sales, payments, opening balances,
          and a running outstanding amount.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
