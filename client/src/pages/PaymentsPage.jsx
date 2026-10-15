import './pages.css'
export default function PaymentsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Payments</h2>
          <p className="page-subtitle">Record customer payments and allocate them to outstanding sales.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" disabled>+ Record Payment</button>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">💳</span>
        <span className="placeholder-label">Payments</span>
        <p className="placeholder-desc">
          Payments can be unallocated (unapplied credit) or allocated to specific sales.
          Partial allocations and void-and-replace are supported.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
