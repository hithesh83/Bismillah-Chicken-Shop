/**
 * client/src/pages/DashboardPage.jsx
 *
 * Real Business Dashboard — Phase 11.
 *
 * Displays live PostgreSQL database metrics:
 *   • Today's Chicken Processing (Live weight, Dressed weight, Weighted aggregate wastage %)
 *   • Today's Financial Overview (Total sales, Collections received, Credit sales, Total customer outstanding)
 *   • Latest Manual Stock Observations (physical inventory counts only — no inferred stock)
 *   • Quick Action Navigation Hub (New Sale, Record Payment, Add Chicken Load, Record Stock Observation, Daily Prices)
 *   • Recent Activities (Loads, Sales, and Payments feeds)
 */

import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState } from '../components/ui/UIStates.jsx'
import './pages.css'
import './DashboardPage.css'

function fmtCurrency(v) {
  if (v === null || v === undefined || isNaN(Number(v))) return '₹0.00'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(v))
}

function fmtKg(v) {
  if (v === null || v === undefined || isNaN(Number(v))) return '0.000 kg'
  return `${Number(v).toFixed(3)} kg`
}

function fmtDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })
}

function fmtDateTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
}

export default function DashboardPage({ user, addToast }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/dashboard', { credentials: 'include' })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.message || `Server returned HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      if (isRefresh && addToast) {
        addToast({ type: 'info', message: 'Dashboard refreshed.' })
      }
    } catch (err) {
      setError(err.message || 'Failed to load dashboard.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [addToast])

  useEffect(() => {
    fetchDashboard()
  }, [fetchDashboard])

  if (loading) {
    return <LoadingState label="Loading real-time shop dashboard…" fullPage />
  }

  if (error) {
    return (
      <div className="page dashboard-page">
        <ErrorState
          message={`Unable to load dashboard data: ${error}`}
          onRetry={() => fetchDashboard(false)}
        />
      </div>
    )
  }

  const loads = data?.loads ?? {}
  const finances = data?.finances ?? {}
  const outstanding = data?.outstanding ?? {}
  const stock = data?.stock ?? {}
  const recent = data?.recent_activity ?? {}

  const wastagePctNum = loads.today_aggregate_wastage_pct != null
    ? Number(loads.today_aggregate_wastage_pct)
    : null

  let wastageClass = 'good'
  if (wastagePctNum !== null) {
    if (wastagePctNum > 28) wastageClass = 'high'
    else if (wastagePctNum > 24) wastageClass = 'warning'
  }

  return (
    <div className="page dashboard-page">
      {/* ── Top Header Bar ──────────────────────────────────────── */}
      <header className="dash-page-header">
        <div>
          <div className="dash-header-title-row">
            <h1 className="page-title">
              Welcome back, {user?.name?.split(' ')[0] ?? 'Partner'} 👋
            </h1>
            <span className="dash-header-badge">
              <span>📍</span>
              <span>Shop Time: {data?.date ? fmtDate(data.date) : 'Today'} (IST)</span>
            </span>
          </div>
          <p className="page-subtitle">
            Real-time operations, daily chicken dressing, physical stock, and customer ledger reconciliation.
          </p>
        </div>

        <div className="dash-header-actions">
          <button
            type="button"
            className="dash-refresh-btn"
            onClick={() => fetchDashboard(true)}
            disabled={refreshing}
            title="Refresh latest metrics from database"
          >
            <span className={`dash-spin-icon ${refreshing ? 'spinning' : ''}`}>🔄</span>
            <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </header>

      {/* ── Financial Overview KPI Cards (Strictly Distinct) ────── */}
      <section aria-labelledby="financial-kpi-heading">
        <h2 id="financial-kpi-heading" className="card-title">Today's Financial Performance</h2>
        <div className="dash-kpi-grid">
          {/* 1. Today's Total Sales */}
          <div className="dash-kpi-card kpi-sales">
            <div className="dash-kpi-card-header">
              <span className="dash-kpi-label">Today's Total Sales</span>
              <span className="dash-kpi-icon">🧾</span>
            </div>
            <div className="dash-kpi-value">{fmtCurrency(finances.today_total_sales)}</div>
            <div className="dash-kpi-desc">
              {finances.today_sales_count > 0
                ? `${finances.today_sales_count} confirmed sale invoices recorded today`
                : 'No sales recorded yet today'}
            </div>
          </div>

          {/* 2. Today's Collections Received */}
          <div className="dash-kpi-card kpi-collections">
            <div className="dash-kpi-card-header">
              <span className="dash-kpi-label">Collections Received</span>
              <span className="dash-kpi-icon">💵</span>
            </div>
            <div className="dash-kpi-value">{fmtCurrency(finances.today_collections_received)}</div>
            <div className="dash-kpi-desc">
              Actual money collected today ({finances.today_payments_count} receipts, zero double-counting)
            </div>
          </div>

          {/* 3. Today's Credit Sales */}
          <div className="dash-kpi-card kpi-credit">
            <div className="dash-kpi-card-header">
              <span className="dash-kpi-label">Today's Credit Sales</span>
              <span className="dash-kpi-icon">🤝</span>
            </div>
            <div className="dash-kpi-value">{fmtCurrency(finances.today_credit_sales)}</div>
            <div className="dash-kpi-desc">
              Unpaid / credited portion of today's customer sales
            </div>
          </div>

          {/* 4. Total Customer Outstanding */}
          <div className="dash-kpi-card kpi-outstanding">
            <div className="dash-kpi-card-header">
              <span className="dash-kpi-label">Total Outstanding Due</span>
              <span className="dash-kpi-icon">⚠️</span>
            </div>
            <div className="dash-kpi-value">{fmtCurrency(outstanding.total_outstanding_amount)}</div>
            <div className="dash-kpi-desc">
              Across {outstanding.owing_customers_count ?? 0} customer accounts with due debt (of {outstanding.total_customers ?? 0} active)
            </div>
          </div>
        </div>
      </section>

      {/* ── Quick Action Hub ────────────────────────────────────── */}
      <section aria-labelledby="quick-actions-heading">
        <h2 id="quick-actions-heading" className="card-title">Quick Actions</h2>
        <div className="dash-actions-grid">
          <a href="#/sales" className="dash-action-btn">
            <span className="dash-action-icon">🧾</span>
            <div className="dash-action-texts">
              <span className="dash-action-title">New Sale</span>
              <span className="dash-action-hint">Walk-in or Credit</span>
            </div>
          </a>

          <a href="#/payments" className="dash-action-btn">
            <span className="dash-action-icon">💳</span>
            <div className="dash-action-texts">
              <span className="dash-action-title">Record Payment</span>
              <span className="dash-action-hint">Cash, UPI, or Bank</span>
            </div>
          </a>

          <a href="#/chicken-loads" className="dash-action-btn">
            <span className="dash-action-icon">🐔</span>
            <div className="dash-action-texts">
              <span className="dash-action-title">Add Chicken Load</span>
              <span className="dash-action-hint">Live & Dressed weights</span>
            </div>
          </a>

          <a href="#/remaining-stock" className="dash-action-btn">
            <span className="dash-action-icon">📦</span>
            <div className="dash-action-texts">
              <span className="dash-action-title">Record Stock</span>
              <span className="dash-action-hint">Manual physical count</span>
            </div>
          </a>

          <a href="#/daily-prices" className="dash-action-btn">
            <span className="dash-action-icon">💰</span>
            <div className="dash-action-texts">
              <span className="dash-action-title">Daily Prices</span>
              <span className="dash-action-hint">Update product rates</span>
            </div>
          </a>

          <a href="#/outstanding" className="dash-action-btn">
            <span className="dash-action-icon">📊</span>
            <div className="dash-action-texts">
              <span className="dash-action-title">Customer Ledger</span>
              <span className="dash-action-hint">View outstanding balances</span>
            </div>
          </a>
        </div>
      </section>

      {/* ── Chicken Processing & Aggregate Wastage ──────────────── */}
      <section className="dash-card" aria-labelledby="chicken-loads-heading">
        <div className="dash-card-header">
          <h2 id="chicken-loads-heading" className="dash-card-title">
            <span>🐔</span>
            <span>Today's Chicken Loads &amp; Dressing Wastage</span>
          </h2>
          <a href="#/chicken-loads" className="dash-card-action-link">
            <span>Manage Loads</span>
            <span>→</span>
          </a>
        </div>

        {loads.today_loads_count === 0 ? (
          <div className="dash-empty-block">
            <span className="dash-empty-block-icon">🚚</span>
            <p><strong>No chicken loads recorded yet for today.</strong></p>
            <p style={{ fontSize: 'var(--text-xs)' }}>
              Loads recorded for today ({data?.date}) will calculate live weight, dressed weight, and aggregate dressing wastage.
            </p>
            <a href="#/chicken-loads" className="dash-empty-block-btn">
              + Add Today's Load
            </a>
          </div>
        ) : (
          <div>
            <div className="dash-loads-grid">
              <div className="dash-load-stat">
                <span className="dash-load-stat-label">Total Live Weight</span>
                <span className="dash-load-stat-value">{fmtKg(loads.today_live_weight_kg)}</span>
                <span className="dash-load-stat-sub">{loads.today_loads_count} load(s) received</span>
              </div>

              <div className="dash-load-stat">
                <span className="dash-load-stat-label">Total Dressed Weight</span>
                <span className="dash-load-stat-value">{fmtKg(loads.today_dressed_weight_kg)}</span>
                <span className="dash-load-stat-sub">Cleaned dressed output</span>
              </div>

              <div className="dash-load-stat">
                <span className="dash-load-stat-label">Total Wastage Weight</span>
                <span className="dash-load-stat-value">{fmtKg(loads.today_wastage_kg)}</span>
                <span className="dash-load-stat-sub">Live minus dressed output</span>
              </div>

              <div className="dash-load-stat">
                <span className="dash-load-stat-label">Aggregate Wastage %</span>
                <div>
                  <span className={`dash-wastage-badge ${wastageClass}`}>
                    {wastagePctNum !== null ? `${wastagePctNum.toFixed(2)}%` : '—'}
                  </span>
                </div>
                <span className="dash-load-stat-sub">
                  {wastageClass === 'good' ? '✅ Optimal processing' : wastageClass === 'warning' ? '⚠️ Moderate loss' : '🚨 High processing loss'}
                </span>
              </div>
            </div>

            <p className="dash-formula-note">
              <span>ℹ️</span>
              <span>
                Calculated strictly via weighted formula: <code>((Sum Live - Sum Dressed) / Sum Live) * 100</code>. Never averaged.
              </span>
            </p>
          </div>
        )}
      </section>

      {/* ── Latest Physical Stock Observations ──────────────────── */}
      <section className="dash-card" aria-labelledby="stock-heading">
        <div className="dash-card-header">
          <div>
            <h2 id="stock-heading" className="dash-card-title">
              <span>📦</span>
              <span>Latest Manual Stock Observations</span>
            </h2>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: '0.2rem' }}>
              Physical inventory only ({stock.total_observed_kg ? fmtKg(stock.total_observed_kg) : '0.000 kg'} total observed across {stock.observed_products_count ?? 0} of {stock.total_products_count ?? 0} active products)
            </p>
          </div>
          <a href="#/remaining-stock" className="dash-card-action-link">
            <span>Stock Observations</span>
            <span>→</span>
          </a>
        </div>

        {(!stock.latest_observations || stock.latest_observations.length === 0) ? (
          <div className="dash-empty-block">
            <span className="dash-empty-block-icon">📦</span>
            <p><strong>No active products configured.</strong></p>
            <a href="#/products" className="dash-empty-block-btn">Go to Products</a>
          </div>
        ) : (
          <div className="dash-stock-table-wrap">
            <table className="dash-stock-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Observed Physical Stock</th>
                  <th>Observed Time</th>
                  <th>Recorded By</th>
                </tr>
              </thead>
              <tbody>
                {stock.latest_observations.map((item) => (
                  <tr key={item.product_id}>
                    <td><strong>{item.product_name}</strong></td>
                    <td>
                      <span className={`dash-category-pill ${item.product_category || 'whole'}`}>
                        {item.product_category}
                      </span>
                    </td>
                    <td>
                      {item.quantity_kg !== null ? (
                        <span className="dash-stock-weight">{fmtKg(item.quantity_kg)}</span>
                      ) : (
                        <span className="dash-stock-unobserved">No physical count yet</span>
                      )}
                    </td>
                    <td>
                      {item.observed_at ? fmtDateTime(item.observed_at) : '—'}
                    </td>
                    <td>
                      {item.observed_by_name || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="dash-formula-note" style={{ marginTop: '0.9rem' }}>
          <span>📌</span>
          <span>
            Physical observations represent actual in-shop counts. Physical stock is never deducted or auto-calculated from sales.
          </span>
        </p>
      </section>

      {/* ── Recent Activity Feed ────────────────────────────────── */}
      <section aria-labelledby="activity-heading">
        <h2 id="activity-heading" className="card-title">Recent Activity Feed</h2>
        <div className="dash-activity-grid">
          {/* Recent Chicken Loads */}
          <div className="dash-card" style={{ padding: '1.25rem' }}>
            <div className="dash-card-header" style={{ marginBottom: '0.85rem' }}>
              <h3 className="dash-card-title" style={{ fontSize: '0.92rem' }}>
                <span>🐔</span>
                <span>Recent Loads</span>
              </h3>
              <a href="#/chicken-loads" className="dash-card-action-link">View all</a>
            </div>

            {(!recent.loads || recent.loads.length === 0) ? (
              <p style={{ color: 'var(--color-muted)', fontSize: 'var(--text-xs)', fontStyle: 'italic', padding: '1rem 0' }}>
                No recent chicken loads recorded.
              </p>
            ) : (
              <div className="dash-activity-list">
                {recent.loads.map(load => (
                  <div key={load.id} className="dash-activity-item">
                    <div className="dash-activity-main">
                      <span className="dash-activity-ref">{load.load_number}</span>
                      <span className="dash-activity-meta">
                        {fmtDate(load.load_date)} · {load.supplier_ref || 'Local supplier'}
                      </span>
                    </div>
                    <div className="dash-activity-amount-col">
                      <span className="dash-activity-val">{fmtKg(load.live_weight_kg)}</span>
                      <span className="dash-activity-meta">
                        {load.wastage_pct != null ? `${Number(load.wastage_pct).toFixed(1)}% loss` : '—'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Sales */}
          <div className="dash-card" style={{ padding: '1.25rem' }}>
            <div className="dash-card-header" style={{ marginBottom: '0.85rem' }}>
              <h3 className="dash-card-title" style={{ fontSize: '0.92rem' }}>
                <span>🧾</span>
                <span>Recent Sales</span>
              </h3>
              <a href="#/sales" className="dash-card-action-link">View all</a>
            </div>

            {(!recent.sales || recent.sales.length === 0) ? (
              <p style={{ color: 'var(--color-muted)', fontSize: 'var(--text-xs)', fontStyle: 'italic', padding: '1rem 0' }}>
                No recent sales recorded.
              </p>
            ) : (
              <div className="dash-activity-list">
                {recent.sales.map(sale => (
                  <div key={sale.id} className="dash-activity-item">
                    <div className="dash-activity-main">
                      <span className="dash-activity-ref">{sale.sale_number}</span>
                      <span className="dash-activity-meta">
                        {sale.party_name || 'Walk-in Customer'} · {fmtDate(sale.sale_date)}
                      </span>
                    </div>
                    <div className="dash-activity-amount-col">
                      <span className="dash-activity-val">{fmtCurrency(sale.total_amount)}</span>
                      <span className="dash-activity-meta" style={{ color: Number(sale.due_amount) > 0 ? 'var(--color-warning)' : 'var(--color-ok)' }}>
                        {Number(sale.due_amount) > 0 ? `₹${Number(sale.due_amount).toFixed(0)} due` : 'Fully paid'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Payments */}
          <div className="dash-card" style={{ padding: '1.25rem' }}>
            <div className="dash-card-header" style={{ marginBottom: '0.85rem' }}>
              <h3 className="dash-card-title" style={{ fontSize: '0.92rem' }}>
                <span>💳</span>
                <span>Recent Payments</span>
              </h3>
              <a href="#/payments" className="dash-card-action-link">View all</a>
            </div>

            {(!recent.payments || recent.payments.length === 0) ? (
              <p style={{ color: 'var(--color-muted)', fontSize: 'var(--text-xs)', fontStyle: 'italic', padding: '1rem 0' }}>
                No recent payment receipts recorded.
              </p>
            ) : (
              <div className="dash-activity-list">
                {recent.payments.map(payment => (
                  <div key={payment.id} className="dash-activity-item">
                    <div className="dash-activity-main">
                      <span className="dash-activity-ref">{payment.payment_number || 'Receipt'}</span>
                      <span className="dash-activity-meta">
                        {payment.party_name || 'Walk-in / Cash'} · via {payment.method?.toUpperCase()}
                      </span>
                    </div>
                    <div className="dash-activity-amount-col">
                      <span className="dash-activity-val" style={{ color: 'var(--color-ok)' }}>
                        +{fmtCurrency(payment.amount)}
                      </span>
                      <span className="dash-activity-meta">
                        {fmtDate(payment.payment_date)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
