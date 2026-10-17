/**
 * client/src/pages/RemainingStockPage.jsx
 *
 * Phase 07 — Remaining Stock (Manual Physical Observation)
 *
 * Core Business Rules Enforced in UI:
 *   • Strict Manual Observation: Quantities are manual physical readings observed
 *     at a specific timestamp. Never calculated from dressed weight minus sales.
 *   • No Silent Overwrites: Every reading is saved as an immutable point-in-time
 *     observation. Multiple readings per day for the same product are preserved.
 *   • Corrections & Audit Trail: Authorized corrections create a linked new row
 *     referencing the original entry without overwriting or deleting historical data.
 *   • Role-Based Access: Staff & Admin can record observations; Admin only can submit
 *     authorized corrections.
 */

import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState } from '../components/ui/UIStates.jsx'
import { Scale, Boxes, ScrollText } from '../components/ui/Icons.jsx'
import './pages.css'

// ── Date and Format Helpers ─────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function nowDateTimeLocal() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60000
  return new Date(now.getTime() - offset).toISOString().slice(0, 16)
}

function fmtKg(v) {
  if (v === null || v === undefined) return '—'
  return `${Number(v).toFixed(3)} kg`
}

function fmtDateTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' ' +
         d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
}

function fmtDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
}

export default function RemainingStockPage({ user, addToast }) {
  const isAdmin = user?.role === 'admin'

  // ── State: Latest readings ────────────────────────────────
  const [latestData,    setLatestData]    = useState([])
  const [summary,       setSummary]       = useState(null)
  const [loadingLatest, setLoadingLatest] = useState(true)

  // ── State: Observation history ────────────────────────────
  const [history,        setHistory]        = useState([])
  const [historyTotal,   setHistoryTotal]   = useState(0)
  const [historyPage,    setHistoryPage]    = useState(1)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError,   setHistoryError]   = useState(null)

  // ── State: Filters ────────────────────────────────────────
  const [filterProduct,  setFilterProduct]  = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterFrom,     setFilterFrom]     = useState('')
  const [filterTo,       setFilterTo]       = useState('')

  // ── State: Active products list for form dropdown ─────────
  const [productsList, setProductsList] = useState([])

  // ── State: Record Observation Modal ───────────────────────
  const [showRecordModal, setShowRecordModal] = useState(false)
  const [recordForm,      setRecordForm]      = useState({
    product_id:  '',
    quantity_kg: '',
    observed_at: nowDateTimeLocal(),
    notes:       '',
  })
  const [recordErrors,    setRecordErrors]    = useState({})
  const [recordSaving,    setRecordSaving]    = useState(false)

  // ── State: Admin Correction Modal ─────────────────────────
  const [showCorrectModal, setShowCorrectModal] = useState(false)
  const [correctingEntry,  setCorrectingEntry]  = useState(null)
  const [correctForm,      setCorrectForm]      = useState({
    quantity_kg:       '',
    correction_reason: '',
    observed_at:       '',
    notes:             '',
  })
  const [correctErrors,    setCorrectErrors]    = useState({})
  const [correctSaving,    setCorrectSaving]    = useState(false)

  // ── State: Detail & Audit Drawer ──────────────────────────
  const [selectedEntry,  setSelectedEntry]  = useState(null)
  const [detailData,     setDetailData]     = useState(null)
  const [detailLoading,  setDetailLoading]  = useState(false)
  const [showDetail,     setShowDetail]     = useState(false)

  // ── Fetch active products for dropdowns ───────────────────
  const fetchProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/products?active_only=true', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        setProductsList(d.products || [])
      }
    } catch { /* ignore */ }
  }, [])

  // ── Fetch latest readings per product ─────────────────────
  const fetchLatest = useCallback(async () => {
    setLoadingLatest(true)
    try {
      const res = await fetch('/api/stock-entries/latest', { credentials: 'include' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const d = await res.json()
      setLatestData(d.latest || [])
      setSummary(d.summary || null)
    } catch (e) {
      addToast({ type: 'error', message: `Failed to load latest stock readings: ${e.message}` })
    } finally {
      setLoadingLatest(false)
    }
  }, [addToast])

  // ── Fetch observation history with filters ────────────────
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const params = new URLSearchParams({
        page:  historyPage,
        limit: 25,
      })
      if (filterProduct)  params.set('product_id', filterProduct)
      if (filterCategory) params.set('category',   filterCategory)
      if (filterFrom)     params.set('from',       filterFrom)
      if (filterTo)       params.set('to',         filterTo)

      const res = await fetch(`/api/stock-entries?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const d = await res.json()
      setHistory(d.entries || [])
      setHistoryTotal(d.total || 0)
    } catch (e) {
      setHistoryError(e.message)
    } finally {
      setHistoryLoading(false)
    }
  }, [historyPage, filterProduct, filterCategory, filterFrom, filterTo])

  useEffect(() => {
    fetchProducts()
    fetchLatest()
  }, [fetchProducts, fetchLatest])

  useEffect(() => {
    fetchHistory()
  }, [fetchHistory])

  // ── Open Record Observation Modal ─────────────────────────
  function openRecordModal(preselectedProductId = '') {
    setRecordForm({
      product_id:  preselectedProductId || (productsList[0]?.id ?? ''),
      quantity_kg: '',
      observed_at: nowDateTimeLocal(),
      notes:       '',
    })
    setRecordErrors({})
    setShowRecordModal(true)
  }

  // ── Handle Save New Observation ───────────────────────────
  async function handleRecordSubmit(e) {
    e.preventDefault()
    setRecordErrors({})

    const errors = {}
    if (!recordForm.product_id) errors.product_id = 'Please select a product.'
    if (recordForm.quantity_kg === '' || isNaN(Number(recordForm.quantity_kg))) {
      errors.quantity_kg = 'Please enter a valid numeric quantity in kg.'
    } else if (Number(recordForm.quantity_kg) < 0) {
      errors.quantity_kg = 'Quantity cannot be negative.'
    }

    if (Object.keys(errors).length > 0) {
      setRecordErrors(errors)
      return
    }

    setRecordSaving(true)
    try {
      const res = await fetch('/api/stock-entries', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({
          product_id:  recordForm.product_id,
          quantity_kg: Number(recordForm.quantity_kg),
          observed_at: recordForm.observed_at ? new Date(recordForm.observed_at).toISOString() : undefined,
          notes:       recordForm.notes,
        }),
      })

      const d = await res.json()
      if (res.status === 400) {
        setRecordErrors(d.errors || { general: d.error || 'Validation error' })
        return
      }
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to save observation.')

      addToast({ type: 'success', message: d.message || 'Manual stock observation recorded.' })
      setShowRecordModal(false)
      fetchLatest()
      fetchHistory()
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setRecordSaving(false)
    }
  }

  // ── Open Admin Correction Modal ───────────────────────────
  function openCorrectModal(entry) {
    setCorrectingEntry(entry)
    setCorrectForm({
      quantity_kg:       entry.quantity_kg ?? '',
      correction_reason: '',
      observed_at:       nowDateTimeLocal(),
      notes:             entry.notes ?? '',
    })
    setCorrectErrors({})
    setShowCorrectModal(true)
  }

  // ── Handle Save Correction ────────────────────────────────
  async function handleCorrectSubmit(e) {
    e.preventDefault()
    setCorrectErrors({})

    const errors = {}
    if (correctForm.quantity_kg === '' || isNaN(Number(correctForm.quantity_kg))) {
      errors.quantity_kg = 'Please enter a valid numeric quantity in kg.'
    } else if (Number(correctForm.quantity_kg) < 0) {
      errors.quantity_kg = 'Quantity cannot be negative.'
    }
    if (!correctForm.correction_reason || correctForm.correction_reason.trim().length < 3) {
      errors.correction_reason = 'Correction reason is required (minimum 3 characters).'
    }

    if (Object.keys(errors).length > 0) {
      setCorrectErrors(errors)
      return
    }

    setCorrectSaving(true)
    try {
      const res = await fetch(`/api/stock-entries/${correctingEntry.id}/correct`, {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({
          quantity_kg:       Number(correctForm.quantity_kg),
          correction_reason: correctForm.correction_reason.trim(),
          observed_at:       correctForm.observed_at ? new Date(correctForm.observed_at).toISOString() : undefined,
          notes:             correctForm.notes,
        }),
      })

      const d = await res.json()
      if (res.status === 400) {
        setCorrectErrors(d.errors || { general: d.error || 'Validation error' })
        return
      }
      if (res.status === 403) {
        addToast({ type: 'error', message: 'Forbidden: Admin role required for corrections.' })
        setShowCorrectModal(false)
        return
      }
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to submit correction.')

      addToast({ type: 'success', message: d.message || 'Observation corrected successfully.' })
      setShowCorrectModal(false)
      fetchLatest()
      fetchHistory()
      if (showDetail && selectedEntry?.id === correctingEntry.id) {
        openDetailModal(correctingEntry)
      }
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setCorrectSaving(false)
    }
  }

  // ── View Observation Detail & Audit Drawer ────────────────
  async function openDetailModal(entry) {
    setSelectedEntry(entry)
    setShowDetail(true)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/stock-entries/${entry.id}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const d = await res.json()
      setDetailData(d)
    } catch (e) {
      addToast({ type: 'error', message: `Could not load audit details: ${e.message}` })
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="page">
      {/* ── Page Header ────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <h2 className="page-title" id="stock-page-title">Remaining Stock</h2>
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 700,
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'rgba(59, 130, 246, 0.12)',
                color: '#2563eb',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
              title="Quantities represent manual physical readings at observation time"
            >
              Manual Physical Observations
            </span>
          </div>
          <p className="page-subtitle">
            Point-in-time physical counts taken on the scale. Never automatically calculated from sales or dressed weight.
          </p>
        </div>

        <div className="page-actions">
          <button
            className="btn btn-primary"
            id="record-stock-btn"
            onClick={() => openRecordModal()}
          >
            + Record Observation
          </button>
        </div>
      </div>

      {/* ── Guidance Banner ────────────────────────────────────── */}
      <div
        className="card"
        style={{
          background: 'rgba(59, 130, 246, 0.05)',
          borderColor: 'rgba(59, 130, 246, 0.25)',
          padding: '0.85rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.85rem',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><Scale size={22} /></span>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--color-text)' }}>Audit & Physical Integrity Notice:</strong> Every recorded reading is an immutable historical observation. Entering a new reading will <em>not</em> overwrite previous counts taken earlier today. Authorized corrections by Administrators create linked correction entries with full audit logs.
        </div>
      </div>

      {/* ── Latest Readings Cards ──────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="card-title" style={{ margin: 0 }}>
            Latest Readings by Product
          </div>
          {summary && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
              Total observed stock: <strong style={{ color: 'var(--color-ok)' }}>{summary.total_observed_kg} kg</strong> ({summary.observed_products} of {summary.total_products} products)
            </span>
          )}
        </div>

        {loadingLatest ? (
          <LoadingState label="Loading latest product stock readings…" />
        ) : latestData.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No Products Configured"
            message="No active products found in the catalog."
          />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '1rem',
            }}
          >
            {latestData.map((item) => {
              const hasReading = item.observation_id != null
              return (
                <div
                  key={item.product_id}
                  className="card"
                  style={{
                    padding: '1.1rem 1.25rem',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    borderLeft: hasReading
                      ? '4px solid var(--color-ok)'
                      : '4px solid var(--color-border)',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.4rem' }}>
                      <span
                        style={{
                          fontSize: 'var(--text-xs)',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          color: 'var(--color-muted)',
                        }}
                      >
                        {item.product_category}
                      </span>
                      {item.is_correction && (
                        <span
                          style={{
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '0.15rem 0.45rem',
                            borderRadius: '999px',
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: '#b45309',
                            textTransform: 'uppercase',
                          }}
                        >
                          Corrected
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--color-text)', marginBottom: '0.5rem' }}>
                      {item.product_name}
                    </div>

                    <div style={{ margin: '0.5rem 0' }}>
                      {hasReading ? (
                        <div>
                          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--color-ok)' }}>
                            {fmtKg(item.quantity_kg)}
                          </div>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: '0.2rem' }}>
                            Observed: {fmtDateTime(item.observed_at)}
                          </div>
                          {item.created_by_name && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: '0.1rem' }}>
                              By: {item.created_by_name}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ padding: '0.5rem 0', color: 'var(--color-muted)', fontSize: 'var(--text-sm)', fontStyle: 'italic' }}>
                          No observation recorded yet
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--color-border)', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 'var(--text-xs)', padding: '0.3rem 0.75rem' }}
                      id={`record-stock-${item.seed_key || item.product_id}`}
                      onClick={() => openRecordModal(item.product_id)}
                    >
                      Record Reading
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Observation History Section ────────────────────────── */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '1.25rem 1.5rem 0.75rem 1.5rem', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.85rem' }}>
            <div>
              <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, margin: 0 }}>
                Observation History Log
              </h3>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 2 }}>
                Full chronological audit trail. Multiple readings per day are preserved as distinct historical records.
              </div>
            </div>
            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-muted)' }}>
              {historyTotal} total observation{historyTotal !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Filter Bar */}
          <div className="filter-bar" style={{ padding: 0, border: 'none', background: 'transparent' }}>
            <select
              id="filter-stock-product"
              className="form-input"
              style={{ maxWidth: 200 }}
              value={filterProduct}
              onChange={(e) => { setFilterProduct(e.target.value); setHistoryPage(1) }}
              aria-label="Filter by Product"
            >
              <option value="">All Products</option>
              {productsList.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>

            <select
              id="filter-stock-category"
              className="form-input"
              style={{ maxWidth: 160 }}
              value={filterCategory}
              onChange={(e) => { setFilterCategory(e.target.value); setHistoryPage(1) }}
              aria-label="Filter by Category"
            >
              <option value="">All Categories</option>
              <option value="whole">Whole Chicken</option>
              <option value="cut">Cuts</option>
              <option value="offal">Offal</option>
            </select>

            <input
              id="filter-stock-from"
              type="date"
              className="form-input"
              style={{ maxWidth: 160 }}
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); setHistoryPage(1) }}
              aria-label="From Date"
              title="From Date"
            />

            <input
              id="filter-stock-to"
              type="date"
              className="form-input"
              style={{ maxWidth: 160 }}
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); setHistoryPage(1) }}
              aria-label="To Date"
              title="To Date"
            />

            {(filterProduct || filterCategory || filterFrom || filterTo) && (
              <button
                className="btn btn-secondary"
                id="clear-stock-filters"
                onClick={() => {
                  setFilterProduct('')
                  setFilterCategory('')
                  setFilterFrom('')
                  setFilterTo('')
                  setHistoryPage(1)
                }}
              >
                Clear Filters
              </button>
            )}
          </div>
        </div>

        {/* History Table */}
        {historyLoading ? (
          <div style={{ padding: '2rem' }}>
            <LoadingState label="Loading observation history…" />
          </div>
        ) : historyError ? (
          <div style={{ padding: '2rem' }}>
            <ErrorState message={historyError} onRetry={fetchHistory} />
          </div>
        ) : history.length === 0 ? (
          <div style={{ padding: '2rem' }}>
            <EmptyState
              icon={ScrollText}
              title="No observations found"
              message="No stock readings match your current filters. Record a new physical observation to get started."
              action={() => openRecordModal()}
              actionLabel="+ Record First Observation"
            />
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Observation Time (IST)</th>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Observed Weight (kg)</th>
                  <th>Type / Status</th>
                  <th>Recorded By</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => {
                  const isCorrectionRow = entry.is_correction
                  return (
                    <tr
                      key={entry.id}
                      style={isCorrectionRow ? { background: 'rgba(245, 158, 11, 0.04)' } : {}}
                    >
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {fmtDateTime(entry.observed_at)}
                      </td>
                      <td style={{ fontWeight: 700, color: 'var(--color-text)' }}>
                        {entry.product_name}
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: 'var(--text-xs)',
                            textTransform: 'uppercase',
                            fontWeight: 600,
                            letterSpacing: '0.04em',
                            padding: '0.15rem 0.45rem',
                            borderRadius: '4px',
                            background: 'var(--color-border)',
                          }}
                        >
                          {entry.product_category}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: 'var(--color-ok)', fontSize: 'var(--text-sm)' }}>
                          {fmtKg(entry.quantity_kg)}
                        </span>
                      </td>
                      <td>
                        {isCorrectionRow ? (
                          <span
                            style={{
                              fontSize: 'var(--text-xs)',
                              fontWeight: 700,
                              color: '#b45309',
                              background: 'rgba(245, 158, 11, 0.15)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '999px',
                            }}
                            title={`Correction reason: ${entry.correction_reason || 'Authorized correction'}`}
                          >
                            Correction
                          </span>
                        ) : entry.has_been_corrected ? (
                          <span
                            style={{
                              fontSize: 'var(--text-xs)',
                              fontWeight: 600,
                              color: 'var(--color-muted)',
                              background: 'rgba(100, 116, 139, 0.12)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '999px',
                            }}
                            title="A subsequent correction has been filed for this entry"
                          >
                            Corrected Later
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 'var(--text-xs)',
                              fontWeight: 600,
                              color: '#2563eb',
                              background: 'rgba(37, 99, 235, 0.08)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '999px',
                            }}
                          >
                            Physical Count
                          </span>
                        )}
                      </td>
                      <td>
                        <span style={{ fontSize: 'var(--text-xs)' }}>
                          {entry.created_by_name || 'Staff'}
                        </span>
                      </td>
                      <td style={{ maxWidth: 220, fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                        {isCorrectionRow && entry.correction_reason ? (
                          <span>
                            <strong style={{ color: '#b45309' }}>Reason:</strong> {entry.correction_reason}
                            {entry.notes ? ` · Note: ${entry.notes}` : ''}
                          </span>
                        ) : (
                          entry.notes || '—'
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.55rem' }}
                            onClick={() => openDetailModal(entry)}
                            title="View audit trail and details"
                          >
                            Details
                          </button>
                          {isAdmin && !isCorrectionRow && (
                            <button
                              className="btn btn-secondary"
                              style={{
                                fontSize: 'var(--text-xs)',
                                padding: '0.25rem 0.55rem',
                                color: '#b45309',
                                borderColor: 'rgba(245, 158, 11, 0.4)',
                              }}
                              id={`correct-entry-${entry.id}`}
                              onClick={() => openCorrectModal(entry)}
                              title="Authorized Admin correction workflow"
                            >
                              Correct
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modal: Record New Stock Observation (Staff + Admin) ── */}
      {showRecordModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowRecordModal(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="record-stock-title">
            <div className="modal-header">
              <h3 className="modal-title" id="record-stock-title">Record Physical Stock Observation</h3>
              <button className="modal-close" onClick={() => setShowRecordModal(false)} aria-label="Close">x</button>
            </div>

            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
              Enter the actual physical scale reading for the selected product. This is saved as a discrete historical count and does not overwrite past observations.
            </p>

            <form onSubmit={handleRecordSubmit}>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="record-product">Product *</label>
                <select
                  id="record-product"
                  className="form-input"
                  value={recordForm.product_id}
                  onChange={(e) => setRecordForm({ ...recordForm, product_id: e.target.value })}
                  required
                >
                  <option value="">Select a product…</option>
                  {productsList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.category})
                    </option>
                  ))}
                </select>
                {recordErrors.product_id && <span className="form-error">{recordErrors.product_id}</span>}
              </div>

              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="record-quantity-kg">Observed Remaining Weight (kg) *</label>
                <input
                  id="record-quantity-kg"
                  type="number"
                  step="0.001"
                  min="0"
                  className="form-input"
                  placeholder="e.g. 45.250"
                  value={recordForm.quantity_kg}
                  onChange={(e) => setRecordForm({ ...recordForm, quantity_kg: e.target.value })}
                  required
                  autoFocus
                />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: '0.25rem' }}>
                  Must be zero or a positive number. Negative quantities are strictly prohibited.
                </span>
                {recordErrors.quantity_kg && <span className="form-error">{recordErrors.quantity_kg}</span>}
              </div>

              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="record-observed-at">Observation Timestamp *</label>
                <input
                  id="record-observed-at"
                  type="datetime-local"
                  className="form-input"
                  value={recordForm.observed_at}
                  onChange={(e) => setRecordForm({ ...recordForm, observed_at: e.target.value })}
                  required
                />
                {recordErrors.observed_at && <span className="form-error">{recordErrors.observed_at}</span>}
              </div>

              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label" htmlFor="record-notes">Observation Notes (optional)</label>
                <textarea
                  id="record-notes"
                  className="form-input"
                  rows={2}
                  placeholder="e.g. Evening closing count after retail sales"
                  value={recordForm.notes}
                  onChange={(e) => setRecordForm({ ...recordForm, notes: e.target.value })}
                />
              </div>

              {recordErrors.general && (
                <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-sm)', marginBottom: '1rem' }}>
                  {recordErrors.general}
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowRecordModal(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  id="submit-record-stock"
                  disabled={recordSaving}
                >
                  {recordSaving ? 'Saving Observation…' : 'Save Observation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Admin Authorized Correction (Admin Only) ────── */}
      {showCorrectModal && correctingEntry && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowCorrectModal(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="correct-stock-title">
            <div className="modal-header">
              <h3 className="modal-title" id="correct-stock-title" style={{ color: '#b45309' }}>
                Authorized Correction — {correctingEntry.product_name}
              </h3>
              <button className="modal-close" onClick={() => setShowCorrectModal(false)} aria-label="Close">x</button>
            </div>

            <div
              style={{
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                borderRadius: 'var(--radius-sm)',
                padding: '0.85rem',
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text)',
                marginBottom: '1.25rem',
              }}
            >
              <div>Original Observation: <strong>{fmtKg(correctingEntry.quantity_kg)}</strong></div>
              <div>Recorded At: <strong>{fmtDateTime(correctingEntry.observed_at)}</strong></div>
              <div>Original Observer: <strong>{correctingEntry.created_by_name || 'Staff'}</strong></div>
              <div style={{ marginTop: '0.5rem', color: 'var(--color-muted)' }}>
                <em>Audit Rule:</em> The original observation will not be altered or deleted. A new correction row will be appended with your justification reason.
              </div>
            </div>

            <form onSubmit={handleCorrectSubmit}>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="correct-quantity-kg">Corrected Weight (kg) *</label>
                <input
                  id="correct-quantity-kg"
                  type="number"
                  step="0.001"
                  min="0"
                  className="form-input"
                  placeholder="e.g. 50.000"
                  value={correctForm.quantity_kg}
                  onChange={(e) => setCorrectForm({ ...correctForm, quantity_kg: e.target.value })}
                  required
                  autoFocus
                />
                {correctErrors.quantity_kg && <span className="form-error">{correctErrors.quantity_kg}</span>}
              </div>

              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="correct-reason">Correction Reason * (Mandatory for audit trail)</label>
                <textarea
                  id="correct-reason"
                  className="form-input"
                  rows={2}
                  placeholder="e.g. Digital scale re-zeroed, corrected tare weight discrepancy"
                  value={correctForm.correction_reason}
                  onChange={(e) => setCorrectForm({ ...correctForm, correction_reason: e.target.value })}
                  required
                />
                {correctErrors.correction_reason && <span className="form-error">{correctErrors.correction_reason}</span>}
              </div>

              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label" htmlFor="correct-notes">Additional Notes (optional)</label>
                <textarea
                  id="correct-notes"
                  className="form-input"
                  rows={2}
                  placeholder="Optional additional remarks"
                  value={correctForm.notes}
                  onChange={(e) => setCorrectForm({ ...correctForm, notes: e.target.value })}
                />
              </div>

              {correctErrors.general && (
                <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-sm)', marginBottom: '1rem' }}>
                  {correctErrors.general}
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCorrectModal(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  id="submit-correct-stock"
                  style={{ background: '#b45309', borderColor: '#b45309' }}
                  disabled={correctSaving}
                >
                  {correctSaving ? 'Saving Correction…' : 'Submit Authorized Correction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Observation Detail & Audit Drawer ───────────── */}
      {showDetail && selectedEntry && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowDetail(false) }}>
          <div className="modal" style={{ maxWidth: 640 }} role="dialog" aria-modal="true" aria-labelledby="detail-stock-title">
            <div className="modal-header">
              <h3 className="modal-title" id="detail-stock-title">Observation Details & Audit Trail</h3>
              <button className="modal-close" onClick={() => setShowDetail(false)} aria-label="Close">x</button>
            </div>

            {detailLoading ? (
              <div style={{ padding: '2rem' }}>
                <LoadingState label="Loading audit details…" />
              </div>
            ) : !detailData?.entry ? (
              <div style={{ padding: '1rem', color: 'var(--color-error)' }}>
                Could not load observation details.
              </div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Product</div>
                    <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{detailData.entry.product_name}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Recorded Weight</div>
                    <div style={{ fontWeight: 800, fontSize: 'var(--text-lg)', color: 'var(--color-ok)' }}>
                      {fmtKg(detailData.entry.quantity_kg)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Observation Time</div>
                    <div style={{ fontSize: 'var(--text-sm)' }}>{fmtDateTime(detailData.entry.observed_at)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Recorded By</div>
                    <div style={{ fontSize: 'var(--text-sm)' }}>{detailData.entry.created_by_name || 'Staff'} ({detailData.entry.created_by_role})</div>
                  </div>
                </div>

                {detailData.entry.notes && (
                  <div style={{ marginBottom: '1rem', padding: '0.6rem 0.8rem', background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)' }}>
                    <strong style={{ color: 'var(--color-muted)' }}>Notes: </strong>{detailData.entry.notes}
                  </div>
                )}

                {/* Corrections pointing to this entry */}
                {detailData.corrections && detailData.corrections.length > 0 && (
                  <div style={{ marginTop: '1.25rem', marginBottom: '1rem' }}>
                    <h4 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', color: '#b45309', marginBottom: '0.5rem' }}>
                      Authorized Corrections History ({detailData.corrections.length})
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {detailData.corrections.map((corr) => (
                        <div
                          key={corr.id}
                          style={{
                            padding: '0.65rem 0.85rem',
                            borderRadius: 'var(--radius-sm)',
                            background: 'rgba(245, 158, 11, 0.08)',
                            border: '1px solid rgba(245, 158, 11, 0.25)',
                            fontSize: 'var(--text-xs)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                            <strong style={{ color: '#b45309' }}>Corrected to {fmtKg(corr.quantity_kg)}</strong>
                            <span style={{ color: 'var(--color-muted)' }}>{fmtDateTime(corr.created_at)}</span>
                          </div>
                          <div><strong>Reason:</strong> {corr.correction_reason}</div>
                          <div style={{ color: 'var(--color-muted)', marginTop: '0.15rem' }}>
                            By Administrator: {corr.created_by_name}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Audit log events */}
                <div style={{ marginTop: '1.25rem' }}>
                  <h4 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-muted)', marginBottom: '0.5rem' }}>
                    System Audit Trail Events
                  </h4>
                  {detailData.audit && detailData.audit.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: 200, overflowY: 'auto' }}>
                      {detailData.audit.map((al) => (
                        <div
                          key={al.id}
                          style={{
                            fontSize: 'var(--text-xs)',
                            padding: '0.5rem 0.75rem',
                            background: 'var(--color-surface)',
                            border: '1px solid var(--color-border)',
                            borderRadius: 'var(--radius-sm)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div>
                            <span style={{ fontWeight: 700, color: al.action_type === 'CORRECT' ? '#b45309' : 'var(--color-ok)', marginRight: '0.5rem' }}>
                              [{al.action_type}]
                            </span>
                            <span>By {al.actor_name || 'System'}</span>
                          </div>
                          <span style={{ color: 'var(--color-muted)' }}>
                            {fmtDateTime(al.event_timestamp)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                      No audit events logged.
                    </div>
                  )}
                </div>

                <div className="modal-footer" style={{ marginTop: '1.5rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowDetail(false)}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
