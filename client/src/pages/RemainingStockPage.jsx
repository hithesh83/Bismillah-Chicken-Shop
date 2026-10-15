import './pages.css'
export default function RemainingStockPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Remaining Stock</h2>
          <p className="page-subtitle">View current available chicken stock after sales and wastage.</p>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">📦</span>
        <span className="placeholder-label">Remaining Stock</span>
        <p className="placeholder-desc">
          Calculated as: total loaded – total sold – total wastage.
          Drill into daily breakdowns to identify discrepancies.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
