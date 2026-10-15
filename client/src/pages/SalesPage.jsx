import './pages.css'
export default function SalesPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Sales</h2>
          <p className="page-subtitle">Record credit and cash sales of chicken to customers.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" disabled>+ New Sale</button>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">🧾</span>
        <span className="placeholder-label">Sales</span>
        <p className="placeholder-desc">
          Sales use the day's price to calculate totals. Confirmed sales are
          immutable; corrections require an audited void-and-replace workflow.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
