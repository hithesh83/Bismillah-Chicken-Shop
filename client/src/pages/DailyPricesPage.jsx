import './pages.css'
export default function DailyPricesPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Daily Prices</h2>
          <p className="page-subtitle">Set and review the selling price of chicken per kg for each day.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" disabled>+ Set Today's Price</button>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">💰</span>
        <span className="placeholder-label">Daily Prices</span>
        <p className="placeholder-desc">
          Prices are date-stamped and used to calculate sale line totals automatically.
          Historical prices are preserved for audit purposes.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
