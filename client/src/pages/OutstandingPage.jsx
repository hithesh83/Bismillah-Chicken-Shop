import './pages.css'
export default function OutstandingPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Outstanding</h2>
          <p className="page-subtitle">See which customers have unpaid balances.</p>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">⚠️</span>
        <span className="placeholder-label">Outstanding Balances</span>
        <p className="placeholder-desc">
          Shows each customer's net balance: opening balance + sales – payments.
          Drill in to see the full ledger for any customer.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
