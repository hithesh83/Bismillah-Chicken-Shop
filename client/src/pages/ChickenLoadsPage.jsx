/**
 * client/src/pages/ChickenLoadsPage.jsx
 *
 * Phase 06 — Chicken Loads (Live, database-driven)
 *
 * Features:
 *   • Paginated load history with date-range + load-number search filters
 *   • "+ New Load" form (Admin + Staff) — real-time wastage preview
 *   • Load detail drawer: weights, wastage, corrections, audit trail
 *   • Manual remaining-stock update (staff + admin)
 *   • Admin correction workflow (new row, not edit)
 *   • Role-based UI (admin sees correction button)
 */
import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState } from '../components/ui/UIStates.jsx'
import { Truck } from '../components/ui/Icons.jsx'
import './pages.css'

// ── Helpers ────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function fmtKg(v) {
  if (v === null || v === undefined) return '—'
  return `${Number(v).toFixed(3)} kg`
}

function fmtPct(v) {
  if (v === null || v === undefined) return '—'
  return `${Number(v).toFixed(2)}%`
}

function fmtDate(v) {
  if (!v) return '—'
  return v.slice(0, 10)
}

function fmtDateTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' ' +
         d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
}

/**
 * Compute wastage preview for the form (server recalculates on save).
 * Returns null when invalid.
 */
function previewWastage(live, dressed) {
  const l = Number(live)
  const d = Number(dressed)
  if (!live || !dressed || isNaN(l) || isNaN(d) || l <= 0 || d < 0 || d > l) return null
  return (((l - d) / l) * 100).toFixed(4)
}

// ══════════════════════════════════════════════════════════════════════════
// Main Page Component
// ══════════════════════════════════════════════════════════════════════════
export default function ChickenLoadsPage({ user, addToast }) {
  const isAdmin = user?.role === 'admin'

  // ── List state ──────────────────────────────────────────
  const [loads,      setLoads]      = useState([])
  const [total,      setTotal]      = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page,       setPage]       = useState(1)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  // Filters
  const [filterFrom,   setFilterFrom]   = useState('')
  const [filterTo,     setFilterTo]     = useState('')
  const [filterSearch, setFilterSearch] = useState('')
  const [searchInput,  setSearchInput]  = useState('')

  // ── Detail drawer ────────────────────────────────────────
  const [selectedLoad,   setSelectedLoad]   = useState(null)
  const [detailLoading,  setDetailLoading]  = useState(false)
  const [showDetail,     setShowDetail]     = useState(false)

  // ── New Load modal ───────────────────────────────────────
  const [showNewModal,  setShowNewModal]  = useState(false)
  const [newForm,       setNewForm]       = useState({
    load_date:         todayIST(),
    supplier_ref:      '',
    live_weight_kg:    '',
    dressed_weight_kg: '',
    remaining_stock_kg: '',
    notes:             '',
  })
  const [newErrors,   setNewErrors]   = useState({})
  const [submitting,  setSubmitting]  = useState(false)

  // ── Stock Update modal ───────────────────────────────────
  const [showStockModal,  setShowStockModal]  = useState(false)
  const [stockLoadId,     setStockLoadId]     = useState(null)
  const [stockLoadNumber, setStockLoadNumber] = useState('')
  const [stockForm,       setStockForm]       = useState({ remaining_stock_kg: '', notes: '' })
  const [stockErrors,     setStockErrors]     = useState({})
  const [stockSubmitting, setStockSubmitting] = useState(false)

  // ── Correction modal ─────────────────────────────────────
  const [showCorrectModal,  setShowCorrectModal]  = useState(false)
  const [correctLoadId,     setCorrectLoadId]     = useState(null)
  const [correctLoadNumber, setCorrectLoadNumber] = useState('')
  const [correctForm,       setCorrectForm]       = useState({
    load_date:         todayIST(),
    supplier_ref:      '',
    live_weight_kg:    '',
    dressed_weight_kg: '',
    remaining_stock_kg: '',
    notes:             '',
    correction_reason: '',
  })
  const [correctErrors,   setCorrectErrors]   = useState({})
  const [correctSubmitting, setCorrectSubmitting] = useState(false)

  // ── Fetch load list ──────────────────────────────────────
  const fetchLoads = useCallback(async (pg = 1) => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ page: pg, limit: 20 })
      if (filterFrom)   params.set('from', filterFrom)
      if (filterTo)     params.set('to',   filterTo)
      if (filterSearch) params.set('load_number', filterSearch)
      const res = await fetch(`/api/chicken-loads?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const d = await res.json()
      setLoads(d.loads)
      setTotal(d.total)
      setTotalPages(d.totalPages)
      setPage(pg)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filterFrom, filterTo, filterSearch])

  useEffect(() => { fetchLoads(1) }, [fetchLoads])

  // ── Fetch load detail ────────────────────────────────────
  async function openDetail(id) {
    setShowDetail(true)
    setDetailLoading(true)
    setSelectedLoad(null)
    try {
      const res = await fetch(`/api/chicken-loads/${id}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const d = await res.json()
      setSelectedLoad(d)
    } catch (e) {
      addToast({ type: 'error', message: e.message })
      setShowDetail(false)
    } finally {
      setDetailLoading(false)
    }
  }

  // ── Create load ──────────────────────────────────────────
  async function handleNewSubmit(e) {
    e.preventDefault()
    setNewErrors({})
    setSubmitting(true)
    try {
      const body = {
        load_date:         newForm.load_date,
        supplier_ref:      newForm.supplier_ref,
        live_weight_kg:    newForm.live_weight_kg !== '' ? Number(newForm.live_weight_kg) : undefined,
        dressed_weight_kg: newForm.dressed_weight_kg !== '' ? Number(newForm.dressed_weight_kg) : undefined,
        remaining_stock_kg: newForm.remaining_stock_kg !== '' ? Number(newForm.remaining_stock_kg) : undefined,
        notes:             newForm.notes,
      }
      const res = await fetch('/api/chicken-loads', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json()
      if (res.status === 400) { setNewErrors(d.errors ?? {}); return }
      if (!res.ok) throw new Error(d.message ?? 'Failed to create load.')
      addToast({ type: 'success', message: d.message })
      setShowNewModal(false)
      resetNewForm()
      fetchLoads(1)
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setSubmitting(false)
    }
  }

  function resetNewForm() {
    setNewForm({ load_date: todayIST(), supplier_ref: '', live_weight_kg: '', dressed_weight_kg: '', remaining_stock_kg: '', notes: '' })
    setNewErrors({})
  }

  // ── Update remaining stock ───────────────────────────────
  function openStockModal(load) {
    setStockLoadId(load.id)
    setStockLoadNumber(load.load_number)
    setStockForm({ remaining_stock_kg: load.remaining_stock_kg ?? '', notes: '' })
    setStockErrors({})
    setShowStockModal(true)
  }

  async function handleStockSubmit(e) {
    e.preventDefault()
    setStockErrors({})
    setStockSubmitting(true)
    try {
      const res = await fetch(`/api/chicken-loads/${stockLoadId}/stock`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remaining_stock_kg: stockForm.remaining_stock_kg !== '' ? Number(stockForm.remaining_stock_kg) : undefined,
          notes: stockForm.notes,
        }),
      })
      const d = await res.json()
      if (res.status === 400) { setStockErrors(d.errors ?? {}); return }
      if (!res.ok) throw new Error(d.message ?? 'Failed to update stock.')
      addToast({ type: 'success', message: d.message })
      setShowStockModal(false)
      fetchLoads(page)
      if (selectedLoad?.load?.id === stockLoadId) openDetail(stockLoadId)
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setStockSubmitting(false)
    }
  }

  // ── Admin correction ─────────────────────────────────────
  function openCorrectModal(load) {
    setCorrectLoadId(load.id)
    setCorrectLoadNumber(load.load_number)
    setCorrectForm({
      load_date:         load.load_date ?? todayIST(),
      supplier_ref:      load.supplier_ref ?? '',
      live_weight_kg:    load.live_weight_kg ?? '',
      dressed_weight_kg: load.dressed_weight_kg ?? '',
      remaining_stock_kg: load.remaining_stock_kg ?? '',
      notes:             '',
      correction_reason: '',
    })
    setCorrectErrors({})
    setShowCorrectModal(true)
  }

  async function handleCorrectSubmit(e) {
    e.preventDefault()
    setCorrectErrors({})
    setCorrectSubmitting(true)
    try {
      const body = {
        load_date:         correctForm.load_date,
        supplier_ref:      correctForm.supplier_ref,
        live_weight_kg:    correctForm.live_weight_kg !== '' ? Number(correctForm.live_weight_kg) : undefined,
        dressed_weight_kg: correctForm.dressed_weight_kg !== '' ? Number(correctForm.dressed_weight_kg) : undefined,
        remaining_stock_kg: correctForm.remaining_stock_kg !== '' ? Number(correctForm.remaining_stock_kg) : undefined,
        notes:             correctForm.notes,
        correction_reason: correctForm.correction_reason,
      }
      const res = await fetch(`/api/chicken-loads/${correctLoadId}/correct`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json()
      if (res.status === 400) { setCorrectErrors(d.errors ?? {}); return }
      if (!res.ok) throw new Error(d.message ?? 'Failed to create correction.')
      addToast({ type: 'success', message: d.message })
      setShowCorrectModal(false)
      fetchLoads(page)
      if (selectedLoad?.load?.id === correctLoadId) openDetail(correctLoadId)
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setCorrectSubmitting(false)
    }
  }

  // Real-time wastage preview
  const newWastage     = previewWastage(newForm.live_weight_kg, newForm.dressed_weight_kg)
  const correctWastage = previewWastage(correctForm.live_weight_kg, correctForm.dressed_weight_kg)

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="page">

      {/* Page header */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Chicken Loads</h2>
          <p className="page-subtitle">
            Record and review incoming chicken stock deliveries.
            {total > 0 && <span style={{ marginLeft: 8, color: 'var(--color-accent)', fontWeight: 600 }}>{total} load{total !== 1 ? 's' : ''} total</span>}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" id="new-load-btn" onClick={() => { resetNewForm(); setShowNewModal(true) }}>
            + New Load
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <input
          id="load-search"
          type="text"
          className="search-input"
          placeholder="Search by Load ID (e.g. LD-00001)…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setFilterSearch(searchInput); fetchLoads(1) } }}
          style={{ maxWidth: 260 }}
          aria-label="Search by load number"
        />
        <input
          id="load-from"
          type="date"
          className="form-input"
          style={{ maxWidth: 160 }}
          value={filterFrom}
          onChange={e => setFilterFrom(e.target.value)}
          aria-label="From date"
          title="From date"
        />
        <input
          id="load-to"
          type="date"
          className="form-input"
          style={{ maxWidth: 160 }}
          value={filterTo}
          onChange={e => setFilterTo(e.target.value)}
          aria-label="To date"
          title="To date"
        />
        <button
          className="btn btn-primary"
          style={{ fontSize: 'var(--text-xs)' }}
          onClick={() => { setFilterSearch(searchInput); fetchLoads(1) }}
          id="apply-filter-btn"
        >
          Apply
        </button>
        {(filterFrom || filterTo || filterSearch) && (
          <button className="btn btn-secondary" id="clear-filter-btn" onClick={() => {
            setFilterFrom(''); setFilterTo(''); setFilterSearch(''); setSearchInput('')
          }}>
            Clear
          </button>
        )}
      </div>

      {/* Load list table */}
      {loading ? (
        <LoadingState label="Loading loads…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => fetchLoads(page)} />
      ) : loads.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No load records"
          message='No chicken loads match the current filters. Click "+ New Load" to add one.'
        />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Load ID</th>
                  <th>Date</th>
                  <th>Supplier Ref</th>
                  <th>Live (kg)</th>
                  <th>Dressed (kg)</th>
                  <th>Wastage</th>
                  <th>Remaining</th>
                  <th>By</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loads.map(load => (
                  <tr key={load.id}>
                    <td>
                      <span style={{ fontWeight: 700, color: 'var(--color-accent)', fontFamily: 'monospace', fontSize: 'var(--text-sm)' }}>
                        {load.load_number}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(load.load_date)}</td>
                    <td style={{ color: 'var(--color-muted)', fontSize: 'var(--text-xs)' }}>
                      {load.supplier_ref || '—'}
                    </td>
                    <td style={{ fontWeight: 600 }}>{fmtKg(load.live_weight_kg)}</td>
                    <td>{fmtKg(load.dressed_weight_kg)}</td>
                    <td><WastageBadge pct={load.wastage_pct} /></td>
                    <td>
                      {load.remaining_stock_kg != null
                        ? <span style={{ color: 'var(--color-ok)', fontWeight: 600 }}>{fmtKg(load.remaining_stock_kg)}</span>
                        : <span style={{ color: 'var(--color-muted)', fontSize: 'var(--text-xs)' }}>Not set</span>
                      }
                    </td>
                    <td style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                      {load.created_by_name}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.55rem' }}
                          onClick={() => openDetail(load.id)}
                          id={`detail-btn-${load.load_number}`}
                        >
                          Detail
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.55rem' }}
                          onClick={() => openStockModal(load)}
                          id={`stock-btn-${load.load_number}`}
                        >
                          Stock
                        </button>
                        {isAdmin && (
                          <button
                            className="btn btn-danger"
                            style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.55rem' }}
                            onClick={() => openCorrectModal(load)}
                            id={`correct-btn-${load.load_number}`}
                          >
                            Correct
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.75rem 1rem', borderTop: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
              <button
                className="btn btn-secondary"
                style={{ padding: '0.2rem 0.7rem', fontSize: 'var(--text-xs)' }}
                disabled={page <= 1}
                onClick={() => fetchLoads(page - 1)}
              >
                Prev
              </button>
              <span>Page {page} of {totalPages}</span>
              <button
                className="btn btn-secondary"
                style={{ padding: '0.2rem 0.7rem', fontSize: 'var(--text-xs)' }}
                disabled={page >= totalPages}
                onClick={() => fetchLoads(page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Load Detail Modal */}
      {showDetail && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowDetail(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="detail-title"
            style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }}
          >
            <div className="modal-header">
              <h3 className="modal-title" id="detail-title">
                {detailLoading ? 'Loading…' : selectedLoad?.load?.load_number ?? 'Load Detail'}
              </h3>
              <button className="modal-close" onClick={() => setShowDetail(false)} aria-label="Close">x</button>
            </div>
            {detailLoading ? (
              <LoadingState label="Loading detail…" />
            ) : selectedLoad ? (
              <LoadDetail
                data={selectedLoad}
                isAdmin={isAdmin}
                onOpenStock={() => { setShowDetail(false); openStockModal(selectedLoad.load) }}
                onOpenCorrect={() => { setShowDetail(false); openCorrectModal(selectedLoad.load) }}
              />
            ) : null}
          </div>
        </div>
      )}

      {/* New Load Modal */}
      {showNewModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setShowNewModal(false); resetNewForm() } }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-load-title"
            style={{ maxWidth: 520, maxHeight: '92vh', overflowY: 'auto' }}
          >
            <div className="modal-header">
              <h3 className="modal-title" id="new-load-title">New Chicken Load</h3>
              <button className="modal-close" onClick={() => { setShowNewModal(false); resetNewForm() }} aria-label="Close">x</button>
            </div>
            <form onSubmit={handleNewSubmit}>
              <LoadFormFields
                form={newForm}
                setForm={setNewForm}
                errors={newErrors}
                wastagePreview={newWastage}
                idPrefix="new"
              />
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => { setShowNewModal(false); resetNewForm() }}>Cancel</button>
                <button type="submit" className="btn btn-primary" id="save-load-btn" disabled={submitting}>
                  {submitting ? 'Saving…' : 'Save Load'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock Update Modal */}
      {showStockModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowStockModal(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="stock-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="stock-modal-title">Update Stock — {stockLoadNumber}</h3>
              <button className="modal-close" onClick={() => setShowStockModal(false)} aria-label="Close">x</button>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginBottom: '1rem' }}>
              Manually observed remaining stock. This is <strong>never calculated automatically</strong>.
            </p>
            <form onSubmit={handleStockSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="stock-kg">Remaining Stock (kg) *</label>
                <input
                  id="stock-kg"
                  type="number" step="0.001" min="0"
                  className="form-input"
                  value={stockForm.remaining_stock_kg}
                  onChange={e => setStockForm(f => ({ ...f, remaining_stock_kg: e.target.value }))}
                  placeholder="e.g. 150.500"
                  required
                />
                {stockErrors.remaining_stock_kg && <span className="form-error">{stockErrors.remaining_stock_kg}</span>}
              </div>
              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label className="form-label" htmlFor="stock-notes">Notes (optional)</label>
                <textarea
                  id="stock-notes"
                  className="form-input" rows={2}
                  value={stockForm.notes}
                  onChange={e => setStockForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. Counted after morning sales"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowStockModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" id="save-stock-btn" disabled={stockSubmitting}>
                  {stockSubmitting ? 'Saving…' : 'Update Stock'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Correction Modal */}
      {showCorrectModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowCorrectModal(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="correct-modal-title"
            style={{ maxWidth: 540, maxHeight: '92vh', overflowY: 'auto' }}
          >
            <div className="modal-header">
              <h3 className="modal-title" id="correct-modal-title">Admin Correction — {correctLoadNumber}</h3>
              <button className="modal-close" onClick={() => setShowCorrectModal(false)} aria-label="Close">x</button>
            </div>
            <div style={{
              background: 'var(--color-error-dim)',
              border: '1px solid rgba(239,68,68,.3)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.6rem 0.9rem',
              fontSize: 'var(--text-xs)',
              color: 'var(--color-error)',
              marginBottom: '1.25rem',
            }}>
              This creates a <strong>new correction row</strong>. The original load is never edited. A full audit trail will be recorded.
            </div>
            <form onSubmit={handleCorrectSubmit}>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="correct-reason">Correction Reason *</label>
                <input
                  id="correct-reason"
                  type="text"
                  className="form-input"
                  value={correctForm.correction_reason}
                  onChange={e => setCorrectForm(f => ({ ...f, correction_reason: e.target.value }))}
                  placeholder="e.g. Scale recalibrated — corrected live weight"
                  required
                />
                {correctErrors.correction_reason && <span className="form-error">{correctErrors.correction_reason}</span>}
              </div>
              <LoadFormFields
                form={correctForm}
                setForm={setCorrectForm}
                errors={correctErrors}
                wastagePreview={correctWastage}
                idPrefix="correct"
              />
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCorrectModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-danger" id="save-correct-btn" disabled={correctSubmitting}>
                  {correctSubmitting ? 'Saving…' : 'Save Correction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// Sub-components
// ══════════════════════════════════════════════════════════════════════════

function WastageBadge({ pct }) {
  if (pct === null || pct === undefined) return <span style={{ color: 'var(--color-muted)' }}>—</span>
  const p = Number(pct)
  const color = p < 20 ? 'var(--color-ok)' : p < 30 ? '#f59e0b' : 'var(--color-error)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: `${color}22`, color,
      border: `1px solid ${color}44`,
      borderRadius: 999, padding: '0.15rem 0.55rem',
      fontSize: 'var(--text-xs)', fontWeight: 700,
    }}>
      {p.toFixed(2)}%
    </span>
  )
}

function LoadFormFields({ form, setForm, errors, wastagePreview, idPrefix }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
          <label className="form-label" htmlFor={`${idPrefix}-date`}>Load Date *</label>
          <input
            id={`${idPrefix}-date`}
            type="date" className="form-input"
            value={form.load_date}
            onChange={e => setForm(f => ({ ...f, load_date: e.target.value }))}
            required
          />
          {errors.load_date && <span className="form-error">{errors.load_date}</span>}
        </div>
        <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
          <label className="form-label" htmlFor={`${idPrefix}-supplier`}>Supplier / Bill Ref</label>
          <input
            id={`${idPrefix}-supplier`}
            type="text" className="form-input"
            value={form.supplier_ref}
            onChange={e => setForm(f => ({ ...f, supplier_ref: e.target.value }))}
            placeholder="Optional"
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 130 }}>
          <label className="form-label" htmlFor={`${idPrefix}-live`}>Live Weight (kg) *</label>
          <input
            id={`${idPrefix}-live`}
            type="number" step="0.001" min="0.001"
            className="form-input"
            value={form.live_weight_kg}
            onChange={e => setForm(f => ({ ...f, live_weight_kg: e.target.value }))}
            placeholder="e.g. 500.000"
            required
          />
          {errors.live_weight_kg && <span className="form-error">{errors.live_weight_kg}</span>}
        </div>
        <div className="form-group" style={{ flex: 1, minWidth: 130 }}>
          <label className="form-label" htmlFor={`${idPrefix}-dressed`}>Dressed Weight (kg) *</label>
          <input
            id={`${idPrefix}-dressed`}
            type="number" step="0.001" min="0"
            className="form-input"
            value={form.dressed_weight_kg}
            onChange={e => setForm(f => ({ ...f, dressed_weight_kg: e.target.value }))}
            placeholder="e.g. 380.000"
            required
          />
          {errors.dressed_weight_kg && <span className="form-error">{errors.dressed_weight_kg}</span>}
        </div>
      </div>

      {/* Real-time wastage preview */}
      <div style={{
        background: wastagePreview !== null ? 'var(--color-accent-dim)' : 'rgba(255,255,255,.03)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        padding: '0.6rem 1rem',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
      }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          Wastage Preview
        </span>
        {wastagePreview !== null ? (
          <span style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--color-accent)' }}>
            {wastagePreview}%
          </span>
        ) : (
          <span style={{ color: 'var(--color-muted)', fontSize: 'var(--text-sm)' }}>
            Enter live and dressed weights above
          </span>
        )}
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginLeft: 'auto' }}>
          Server recalculates on save
        </span>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor={`${idPrefix}-remaining`}>Remaining Stock (kg)</label>
        <input
          id={`${idPrefix}-remaining`}
          type="number" step="0.001" min="0"
          className="form-input"
          value={form.remaining_stock_kg}
          onChange={e => setForm(f => ({ ...f, remaining_stock_kg: e.target.value }))}
          placeholder="Optional — manually observed"
        />
        {errors.remaining_stock_kg && <span className="form-error">{errors.remaining_stock_kg}</span>}
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
          Manually observed — never automatically calculated
        </span>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor={`${idPrefix}-notes`}>Notes</label>
        <textarea
          id={`${idPrefix}-notes`}
          className="form-input" rows={2}
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          placeholder="Any additional notes about this load"
        />
      </div>
    </div>
  )
}

function LoadDetail({ data, isAdmin, onOpenStock, onOpenCorrect }) {
  const { load, corrections, audit } = data
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
        <StatBox label="Live Weight"     value={fmtKg(load.live_weight_kg)} />
        <StatBox label="Dressed Weight"  value={fmtKg(load.dressed_weight_kg)} />
        <StatBox label="Wastage"         value={<WastageBadge pct={load.wastage_pct} />} />
        <StatBox label="Remaining Stock" value={fmtKg(load.remaining_stock_kg)} accent />
        <StatBox label="Load Date"       value={fmtDate(load.load_date)} />
        <StatBox label="Supplier Ref"    value={load.supplier_ref || '—'} />
      </div>

      {load.notes && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', background: 'var(--color-surface-2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }}>
          <strong>Notes:</strong> {load.notes}
        </div>
      )}

      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
        Created by <strong>{load.created_by_name}</strong> at {fmtDateTime(load.created_at)}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)' }} onClick={onOpenStock}>
          Update Remaining Stock
        </button>
        {isAdmin && (
          <button className="btn btn-danger" style={{ fontSize: 'var(--text-xs)' }} onClick={onOpenCorrect}>
            Create Correction
          </button>
        )}
      </div>

      {corrections.length > 0 && (
        <div>
          <div className="card-title">Corrections ({corrections.length})</div>
          {corrections.map(c => (
            <div key={c.id} style={{
              background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.9rem', marginBottom: '0.5rem', fontSize: 'var(--text-xs)',
            }}>
              <span style={{ fontWeight: 700, color: 'var(--color-accent)', fontFamily: 'monospace' }}>{c.load_number}</span>
              {' — Live: '}{fmtKg(c.live_weight_kg)}{' · Dressed: '}{fmtKg(c.dressed_weight_kg)}{' · Wastage: '}{fmtPct(c.wastage_pct)}
              <span style={{ color: 'var(--color-muted)', marginLeft: 8 }}>by {c.created_by_name} · {fmtDateTime(c.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {audit.length > 0 && (
        <div>
          <div className="card-title">Audit Trail ({audit.length} events)</div>
          {audit.map(entry => <AuditRow key={entry.id} entry={entry} />)}
        </div>
      )}
    </div>
  )
}

function StatBox({ label, value, accent }) {
  return (
    <div style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '0.65rem 0.85rem' }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontWeight: 700, color: accent ? 'var(--color-ok)' : 'var(--color-text)' }}>
        {value}
      </div>
    </div>
  )
}

function AuditRow({ entry }) {
  const actionColors = { CREATE: 'var(--color-ok)', UPDATE: '#f59e0b', CORRECT: 'var(--color-error)', VOID: 'var(--color-muted)' }
  const color = actionColors[entry.action_type] || 'var(--color-muted)'
  const meta  = entry.change_metadata
  return (
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', borderLeft: `3px solid ${color}`, paddingLeft: '0.75rem', marginBottom: '0.6rem', fontSize: 'var(--text-xs)' }}>
      <span style={{ color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
        {entry.action_type}
      </span>
      <div>
        <div style={{ color: 'var(--color-muted)' }}>
          by <strong>{entry.actor_name ?? 'System'}</strong> · {fmtDateTime(entry.event_timestamp)}
        </div>
        {meta && (
          <div style={{ color: 'var(--color-muted)', marginTop: 2 }}>
            {[
              meta.correction_reason && `Reason: ${meta.correction_reason}`,
              meta.field             && `Field: ${meta.field}`,
              meta.before !== undefined && `Before: ${meta.before}`,
              meta.after  !== undefined && `After: ${meta.after}`,
              meta.note              && `Note: ${meta.note}`,
            ].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
    </div>
  )
}
