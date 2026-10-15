import './pages.css'
export default function ReportsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Reports</h2>
          <p className="page-subtitle">Generate financial and stock reports for any date range.</p>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">📈</span>
        <span className="placeholder-label">Reports</span>
        <p className="placeholder-desc">
          Daily summary, customer statements, stock reconciliation, and
          profit/loss reports will be available here.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
