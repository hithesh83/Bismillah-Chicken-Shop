import './pages.css'
export default function ChickenLoadsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Chicken Loads</h2>
          <p className="page-subtitle">Record and review incoming chicken stock deliveries.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" disabled>+ New Load</button>
        </div>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">🐔</span>
        <span className="placeholder-label">Chicken Loads</span>
        <p className="placeholder-desc">
          Each load records gross weight, net weight, wastage, supplier, and cost per kg.
          Stock ledger entries are created automatically.
        </p>
        <span className="placeholder-pill">Phase 5 — Coming soon</span>
      </div>
    </div>
  )
}
