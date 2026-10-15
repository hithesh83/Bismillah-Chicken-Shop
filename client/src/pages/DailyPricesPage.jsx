/**
 * client/src/pages/DailyPricesPage.jsx
 *
 * Live daily prices connected to /api/daily-prices.
 *
 * Features:
 *   - Today's prices overview (GET /api/daily-prices/today)
 *   - Full price list with product and date filters
 *   - Price history per product (inline expand)
 *   - Admin: set price modal with validation
 *   - Admin: delete future price entries
 */
import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState } from '../components/ui/UIStates.jsx'
import './pages.css'

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

export default function DailyPricesPage({ user, addToast }) {
  const isAdmin = user.role === 'admin'
  const today   = todayIST()

  // ── State ────────────────────────────────────────────────
  const [todayPrices, setTodayPrices]   = useState([])
  const [priceList,   setPriceList]     = useState([])
  const [products,    setProducts]      = useState([])
  const [loading,     setLoading]       = useState(true)
  const [error,       setError]         = useState(null)

  // Filters for the price list
  const [filterProduct, setFilterProduct] = useState('')
  const [filterFrom,    setFilterFrom]    = useState('')
  const [filterTo,      setFilterTo]      = useState('')

  // Expanded history row
  const [expandedProduct, setExpandedProduct] = useState(null)
  const [history,         setHistory]         = useState([])
  const [histLoading,     setHistLoading]     = useState(false)

  // New price modal
  const [showModal,   setShowModal]   = useState(false)
  const [form,        setForm]        = useState({ product_id: '', effective_date: today, rate_per_kg: '' })
  const [formErrors,  setFormErrors]  = useState({})
  const [submitting,  setSubmitting]  = useState(false)

  // ── Fetch today's prices + products list ─────────────────
  const fetchToday = useCallback(async () => {
    try {
      const res = await fetch('/api/daily-prices/today', { credentials: 'include' })
      if (res.ok) { const d = await res.json(); setTodayPrices(d.prices) }
    } catch { /* silent */ }
  }, [])

  const fetchProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/products?status=active', { credentials: 'include' })
      if (res.ok) { const d = await res.json(); setProducts(d.products) }
    } catch { /* silent */ }
  }, [])

  // ── Fetch price list ─────────────────────────────────────
  const fetchList = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (filterProduct) params.set('product_id', filterProduct)
      if (filterFrom)    params.set('from', filterFrom)
      if (filterTo)      params.set('to',   filterTo)
      const res = await fetch(`/api/daily-prices?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const d = await res.json()
      setPriceList(d.prices)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filterProduct, filterFrom, filterTo])

  useEffect(() => {
    Promise.all([fetchToday(), fetchProducts(), fetchList()])
  }, [fetchToday, fetchProducts, fetchList])

  // ── Expand price history for a product ──────────────────
  async function toggleHistory(productId) {
    if (expandedProduct === productId) { setExpandedProduct(null); return }
    setExpandedProduct(productId)
    setHistLoading(true)
    try {
      const res = await fetch(`/api/daily-prices/${productId}/history`, { credentials: 'include' })
      const d = await res.json()
      setHistory(d.history ?? [])
    } catch { setHistory([]) }
    setHistLoading(false)
  }

  // ── Delete a price entry ─────────────────────────────────
  async function handleDelete(entry) {
    try {
      const res = await fetch(`/api/daily-prices/${entry.id}`, {
        method: 'DELETE', credentials: 'include',
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.message ?? 'Failed to delete.')
      addToast({ type: 'success', message: d.message })
      fetchList(); fetchToday()
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    }
  }

  // ── Create price ─────────────────────────────────────────
  async function handleCreate(e) {
    e.preventDefault()
    setFormErrors({})
    setSubmitting(true)
    try {
      const body = { ...form, rate_per_kg: Number(form.rate_per_kg) }
      const res = await fetch('/api/daily-prices', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json()
      if (res.status === 400) { setFormErrors(d.errors ?? {}); return }
      if (!res.ok) throw new Error(d.message ?? 'Failed to set price.')
      addToast({ type: 'success', message: d.message })
      setShowModal(false)
      setForm({ product_id: '', effective_date: today, rate_per_kg: '' })
      fetchList(); fetchToday()
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Daily Prices</h2>
          <p className="page-subtitle">Selling price per kg for each product, per business day.</p>
        </div>
        {isAdmin && (
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              + Set Price
            </button>
          </div>
        )}
      </div>

      {/* Today's prices overview */}
      <div className="card">
        <div className="card-title">Today — {today}</div>
        {todayPrices.length === 0 ? (
          <p style={{ color: 'var(--color-muted)', fontSize: 'var(--text-sm)' }}>
            No prices set for today yet.{isAdmin && ' Use "+ Set Price" to add them.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            {todayPrices.map(p => (
              <div key={p.id} style={{
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                padding: '0.6rem 1rem',
                minWidth: 160,
              }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginBottom: 4 }}>
                  {p.product_name}
                </div>
                <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--color-accent)' }}>
                  ₹{Number(p.rate_per_kg).toFixed(2)}<span style={{ fontSize: 'var(--text-xs)', fontWeight: 400, color: 'var(--color-muted)' }}>/kg</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <select
          id="price-product-filter"
          className="form-select"
          style={{ maxWidth: 200 }}
          value={filterProduct}
          onChange={e => setFilterProduct(e.target.value)}
          aria-label="Filter by product"
        >
          <option value="">All products</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input
          id="price-from-filter"
          type="date"
          className="form-input"
          style={{ maxWidth: 160 }}
          value={filterFrom}
          onChange={e => setFilterFrom(e.target.value)}
          aria-label="From date"
          title="From date"
        />
        <input
          id="price-to-filter"
          type="date"
          className="form-input"
          style={{ maxWidth: 160 }}
          value={filterTo}
          onChange={e => setFilterTo(e.target.value)}
          aria-label="To date"
          title="To date"
        />
        {(filterProduct || filterFrom || filterTo) && (
          <button className="btn btn-secondary" onClick={() => {
            setFilterProduct(''); setFilterFrom(''); setFilterTo('')
          }}>Clear</button>
        )}
      </div>

      {/* Price list table */}
      {loading ? (
        <LoadingState label="Loading prices…" />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchList} />
      ) : priceList.length === 0 ? (
        <EmptyState icon="💰" title="No price records" message="No prices match the current filters." />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Effective Date</th>
                  <th>Rate / kg</th>
                  <th>Set By</th>
                  <th>History</th>
                  {isAdmin && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {priceList.map(entry => (
                  <>
                    <tr key={entry.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{entry.product_name}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                          {entry.category}
                        </div>
                      </td>
                      <td>
                        <span style={{
                          color: entry.effective_date === today ? 'var(--color-ok)' : 'inherit',
                          fontWeight: entry.effective_date === today ? 600 : 400,
                        }}>
                          {entry.effective_date}
                          {entry.effective_date === today && ' ← today'}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600, color: 'var(--color-accent)' }}>
                        ₹{Number(entry.rate_per_kg).toFixed(2)}
                      </td>
                      <td style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                        {entry.created_by_name}
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.6rem' }}
                          onClick={() => toggleHistory(entry.product_id)}
                        >
                          {expandedProduct === entry.product_id ? 'Hide' : 'History'}
                        </button>
                      </td>
                      {isAdmin && (
                        <td>
                          {entry.effective_date >= today ? (
                            <button
                              className="btn btn-danger"
                              style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.6rem' }}
                              onClick={() => handleDelete(entry)}
                            >
                              Delete
                            </button>
                          ) : (
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                              Protected
                            </span>
                          )}
                        </td>
                      )}
                    </tr>

                    {/* Inline history expansion */}
                    {expandedProduct === entry.product_id && (
                      <tr key={`hist-${entry.product_id}`}>
                        <td colSpan={isAdmin ? 6 : 5} style={{ padding: 0 }}>
                          <div style={{
                            background: 'var(--color-surface-2)',
                            borderTop: '1px solid var(--color-border)',
                            padding: '1rem 1.25rem',
                          }}>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                              Full price history — {entry.product_name}
                            </div>
                            {histLoading ? (
                              <LoadingState label="Loading history…" />
                            ) : history.length === 0 ? (
                              <p style={{ color: 'var(--color-muted)', fontSize: 'var(--text-sm)' }}>No history found.</p>
                            ) : (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                {history.map(h => (
                                  <div key={h.id} style={{
                                    background: 'var(--color-surface)',
                                    border: '1px solid var(--color-border)',
                                    borderRadius: 'var(--radius-sm)',
                                    padding: '0.4rem 0.8rem',
                                    fontSize: 'var(--text-xs)',
                                  }}>
                                    <span style={{ color: 'var(--color-muted)' }}>{h.effective_date} — </span>
                                    <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>₹{Number(h.rate_per_kg).toFixed(2)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Set Price Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="price-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="price-modal-title">Set Daily Price</h3>
              <button className="modal-close" onClick={() => setShowModal(false)} aria-label="Close">×</button>
            </div>

            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label" htmlFor="price-product">Product *</label>
                <select
                  id="price-product"
                  className="form-select"
                  value={form.product_id}
                  onChange={e => setForm(f => ({ ...f, product_id: e.target.value }))}
                  required
                >
                  <option value="">Select a product…</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {formErrors.product_id && <span className="form-error">{formErrors.product_id}</span>}
              </div>

              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label className="form-label" htmlFor="price-date">Effective Date *</label>
                <input
                  id="price-date"
                  type="date"
                  className="form-input"
                  value={form.effective_date}
                  onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))}
                  required
                />
                {formErrors.effective_date && <span className="form-error">{formErrors.effective_date}</span>}
              </div>

              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label className="form-label" htmlFor="price-rate">Rate per kg (₹) *</label>
                <input
                  id="price-rate"
                  type="number"
                  step="0.01"
                  min="0.01"
                  className="form-input"
                  value={form.rate_per_kg}
                  onChange={e => setForm(f => ({ ...f, rate_per_kg: e.target.value }))}
                  placeholder="e.g. 250.00"
                  required
                />
                {formErrors.rate_per_kg && <span className="form-error">{formErrors.rate_per_kg}</span>}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Saving…' : 'Save Price'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
