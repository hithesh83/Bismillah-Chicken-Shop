/**
 * client/src/pages/ProductsPage.jsx
 *
 * Live product catalogue connected to GET /api/products.
 *
 * Features:
 *   - Search by name
 *   - Filter by status (active / inactive / all)
 *   - Filter by category (whole / cut / offal)
 *   - Shows today's price per product (from joined daily_prices)
 *   - Admin: create product modal
 *   - Admin: activate / deactivate toggle
 */
import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState } from '../components/ui/UIStates.jsx'
import './pages.css'

const CATEGORIES = ['whole', 'cut', 'offal']
const CATEGORY_LABEL = { whole: 'Whole', cut: 'Cut', offal: 'Offal' }

export default function ProductsPage({ user, addToast }) {
  const isAdmin = user.role === 'admin'

  const [products,   setProducts]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [search,     setSearch]     = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [catFilter,  setCatFilter]  = useState('')
  const [showModal,  setShowModal]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form,       setForm]       = useState({ name: '', category: 'whole', notes: '' })
  const [formErrors, setFormErrors] = useState({})

  // ── Fetch products ───────────────────────────────────────
  const fetchProducts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ status: statusFilter })
      if (catFilter) params.set('category', catFilter)
      const res = await fetch(`/api/products?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setProducts(data.products)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, catFilter])

  useEffect(() => { fetchProducts() }, [fetchProducts])

  // ── Search filter (client-side) ──────────────────────────
  const visible = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  // ── Toggle active status ─────────────────────────────────
  async function handleToggleStatus(product) {
    const next = !product.is_active
    try {
      const res = await fetch(`/api/products/${product.id}/status`, {
        method:      'PATCH',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ is_active: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message ?? 'Failed to update status.')
      addToast({ type: 'success', message: data.message })
      fetchProducts()
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    }
  }

  // ── Create product ───────────────────────────────────────
  async function handleCreate(e) {
    e.preventDefault()
    setFormErrors({})
    setSubmitting(true)
    try {
      const res = await fetch('/api/products', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify(form),
      })
      const data = await res.json()
      if (res.status === 400) { setFormErrors(data.errors ?? {}); return }
      if (!res.ok) throw new Error(data.message ?? 'Failed to create product.')
      addToast({ type: 'success', message: `Product "${data.product.name}" created.` })
      setShowModal(false)
      setForm({ name: '', category: 'whole', notes: '' })
      fetchProducts()
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
          <h2 className="page-title">Products</h2>
          <p className="page-subtitle">Manage the chicken product catalogue.</p>
        </div>
        {isAdmin && (
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              + New Product
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <input
          id="product-search"
          type="search"
          className="search-input"
          placeholder="Search by name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search products"
        />
        <select
          id="product-status-filter"
          className="form-select"
          style={{ maxWidth: 140 }}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
        <select
          id="product-category-filter"
          className="form-select"
          style={{ maxWidth: 140 }}
          value={catFilter}
          onChange={e => setCatFilter(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <LoadingState label="Loading products…" />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchProducts} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No products found"
          message={search ? `No products match "${search}".` : 'No products in this filter.'}
        />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Today's Price</th>
                  <th>Status</th>
                  {isAdmin && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map(product => (
                  <tr key={product.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{product.name}</div>
                      {product.notes && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 2 }}>
                          {product.notes}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="role-badge" style={{
                        background: catBadgeBg(product.category),
                        color: 'var(--color-text)'
                      }}>
                        {CATEGORY_LABEL[product.category]}
                      </span>
                    </td>
                    <td>
                      {product.today_rate
                        ? <span style={{ color: 'var(--color-ok)', fontWeight: 600 }}>
                            ₹{Number(product.today_rate).toFixed(2)}/kg
                          </span>
                        : <span style={{ color: 'var(--color-muted)', fontSize: 'var(--text-xs)' }}>
                            Not set
                          </span>
                      }
                    </td>
                    <td>
                      <span className={`status-badge ${product.is_active ? 'status--ok' : 'status--muted'}`}>
                        {product.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td>
                        <button
                          className={`btn btn-secondary`}
                          style={{ fontSize: 'var(--text-xs)', padding: '0.3rem 0.75rem' }}
                          onClick={() => handleToggleStatus(product)}
                        >
                          {product.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Product Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="modal-title">New Product</h3>
              <button className="modal-close" onClick={() => setShowModal(false)} aria-label="Close">×</button>
            </div>

            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label" htmlFor="new-product-name">Product name *</label>
                <input
                  id="new-product-name"
                  className="form-input"
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Boneless Breast"
                  required
                  autoFocus
                />
                {formErrors.name && <span className="form-error">{formErrors.name}</span>}
              </div>

              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label className="form-label" htmlFor="new-product-category">Category *</label>
                <select
                  id="new-product-category"
                  className="form-select"
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                >
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                  ))}
                </select>
                {formErrors.category && <span className="form-error">{formErrors.category}</span>}
              </div>

              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label className="form-label" htmlFor="new-product-notes">Notes (optional)</label>
                <input
                  id="new-product-notes"
                  className="form-input"
                  type="text"
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Any additional details"
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function catBadgeBg(cat) {
  return { whole: 'rgba(245,166,35,.12)', cut: 'rgba(96,165,250,.12)', offal: 'rgba(167,139,250,.12)' }[cat] ?? 'rgba(255,255,255,.06)'
}
