/**
 * client/src/pages/PaymentsPage.jsx
 *
 * Phase 10 — Payments Management & Receipt History
 *
 * Core Features:
 *   • KPI Metric Cards (Total Collected, Total Allocated, Unallocated Advance, Count).
 *   • Multi-Filter Payment History (Search, Date Range, Method, Allocation Status).
 *   • Record Payment Modal:
 *       - Disambiguated customer picker (Party ID, Name, Location).
 *       - Payment method (Cash, UPI, Bank Transfer, Other) & external ref.
 *       - Allocation strategies:
 *           * FIFO (Auto-allocate oldest open credit invoices first)
 *           * Specific Invoices (Interactive invoice checklist with amount inputs)
 *           * Unallocated Advance (Sits as credit on customer account)
 *       - Live math calculation & overpayment guards.
 *   • Itemized Payment Receipt Drawer & Admin Authorized Void Workflow.
 */

import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState, StatusBadge } from '../components/ui/UIStates.jsx'
import './pages.css'

// ── Helpers ──────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function fmtDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
}

function fmtDateTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' ' +
         d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
}

function fmtCurrency(v) {
  if (v === null || v === undefined) return '₹0.00'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(v))
}

const METHOD_BADGES = {
  cash:  { label: 'Cash',          color: '#059669', bg: 'rgba(5, 150, 105, 0.1)' },
  upi:   { label: 'UPI / QR',      color: '#7c3aed', bg: 'rgba(124, 58, 237, 0.1)' },
  bank:  { label: 'Bank Transfer', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.1)' },
  other: { label: 'Other',         color: '#475569', bg: 'rgba(71, 85, 105, 0.1)' },
}

export default function PaymentsPage({ user, addToast }) {
  const isAdmin = user?.role === 'admin'

  // ── State: Payments List & Summary ──────────────────────────
  const [payments,   setPayments]   = useState([])
  const [summary,    setSummary]    = useState(null)
  const [total,      setTotal]      = useState(0)
  const [page,       setPage]       = useState(1)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  // ── State: Filters ──────────────────────────────────────────
  const [search,           setSearch]           = useState('')
  const [filterMethod,     setFilterMethod]     = useState('')
  const [filterAllocation, setFilterAllocation] = useState('')
  const [filterStatus,     setFilterStatus]     = useState('active')
  const [filterFrom,       setFilterFrom]       = useState('')
  const [filterTo,         setFilterTo]         = useState('')

  // ── State: Customers master list for dropdown ───────────────
  const [customers, setCustomers] = useState([])

  // ── State: Record Payment Modal ─────────────────────────────
  const [showModal,          setShowModal]          = useState(false)
  const [selectedPartyId,    setSelectedPartyId]    = useState('')
  const [paymentDate,        setPaymentDate]        = useState(todayIST())
  const [paymentAmount,      setPaymentAmount]      = useState('')
  const [paymentMethod,      setPaymentMethod]      = useState('cash')
  const [externalRef,        setExternalRef]        = useState('')
  const [notes,              setNotes]              = useState('')
  const [allocationStrategy, setAllocationStrategy] = useState('fifo') // 'fifo' | 'specific' | 'unallocated'
  const [openInvoices,       setOpenInvoices]       = useState([])
  const [loadingInvoices,    setLoadingInvoices]    = useState(false)
  const [specificAllocations, setSpecificAllocations] = useState({}) // map sale_id -> amount string
  const [saving,             setSaving]             = useState(false)
  const [formErrors,         setFormErrors]         = useState({})

  // ── State: Payment Receipt / Details Drawer ─────────────────
  const [showDetail,    setShowDetail]    = useState(false)
  const [selectedPay,   setSelectedPay]   = useState(null)
  const [detailData,    setDetailData]    = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // ── State: Void Payment Modal (Admin Only) ──────────────────
  const [voidModal,   setVoidModal]   = useState(null)
  const [voidReason,  setVoidReason]  = useState('')
  const [voidError,   setVoidError]   = useState('')
  const [voidSaving,  setVoidSaving]  = useState(false)

  // ── Fetch Customers for dropdown ────────────────────────────
  const fetchCustomers = useCallback(async () => {
    try {
      const res = await fetch('/api/customers?status=active&limit=200', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        setCustomers(d.customers || [])
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchCustomers()
  }, [fetchCustomers])

  // ── Fetch Payments History ──────────────────────────────────
  const fetchPayments = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (search.trim())           params.set('search', search.trim())
      if (filterMethod)            params.set('method', filterMethod)
      if (filterAllocation)        params.set('allocation_status', filterAllocation)
      if (filterStatus)            params.set('status', filterStatus)
      if (filterFrom)              params.set('from', filterFrom)
      if (filterTo)                params.set('to', filterTo)
      params.set('page', page)
      params.set('limit', 50)

      const res = await fetch(`/api/payments?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP error ${res.status}`)
      const data = await res.json()

      setPayments(data.payments || [])
      setSummary(data.summary || null)
      setTotal(data.total || 0)
    } catch (err) {
      setError(err.message || 'Failed to load payments.')
    } finally {
      setLoading(false)
    }
  }, [search, filterMethod, filterAllocation, filterStatus, filterFrom, filterTo, page])

  useEffect(() => {
    fetchPayments()
  }, [fetchPayments])

  // ── When Customer changes in Record Modal, fetch open invoices ──
  useEffect(() => {
    if (!selectedPartyId) {
      setOpenInvoices([])
      setSpecificAllocations({})
      return
    }

    let isMounted = true
    setLoadingInvoices(true)
    fetch(`/api/outstanding/${selectedPartyId}/invoices`, { credentials: 'include' })
      .then(res => res.ok ? res.json() : { invoices: [] })
      .then(data => {
        if (isMounted) {
          setOpenInvoices(data.invoices || [])
          setSpecificAllocations({})
        }
      })
      .catch(() => {
        if (isMounted) setOpenInvoices([])
      })
      .finally(() => {
        if (isMounted) setLoadingInvoices(false)
      })

    return () => { isMounted = false }
  }, [selectedPartyId])

  // ── Open Record Modal ───────────────────────────────────────
  function openRecordModal(preselectedCustomer = null) {
    setSelectedPartyId(preselectedCustomer?.id || '')
    setPaymentDate(todayIST())
    setPaymentAmount('')
    setPaymentMethod('cash')
    setExternalRef('')
    setNotes('')
    setAllocationStrategy('fifo')
    setSpecificAllocations({})
    setFormErrors({})
    setShowModal(true)
  }

  // ── Open Receipt / Details Drawer ───────────────────────────
  async function openDetailModal(pay) {
    setSelectedPay(pay)
    setShowDetail(true)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/payments/${pay.id}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP error ${res.status}`)
      const d = await res.json()
      setDetailData(d)
    } catch (err) {
      addToast({ type: 'error', message: `Could not load payment details: ${err.message}` })
    } finally {
      setDetailLoading(false)
    }
  }

  // ── Submit Record Payment ───────────────────────────────────
  async function handlePaymentSubmit(e) {
    e.preventDefault()
    const errs = {}

    if (!selectedPartyId) errs.party_id = 'Please select a customer.'
    const numAmt = Number(paymentAmount)
    if (!paymentAmount || isNaN(numAmt) || numAmt <= 0) {
      errs.amount = 'Please enter a valid amount strictly greater than zero.'
    }

    if (allocationStrategy === 'specific') {
      const allocList = []
      let allocTotal = 0
      for (const [saleId, strAmt] of Object.entries(specificAllocations)) {
        const val = Number(strAmt)
        if (val > 0) {
          allocList.push({ sale_id: saleId, allocated_amount: val })
          allocTotal += val
        }
      }

      if (allocList.length === 0) {
        errs.allocations = 'Specific allocation selected: please allocate an amount to at least one invoice.'
      } else if (allocTotal > numAmt) {
        errs.allocations = `Allocated total (${fmtCurrency(allocTotal)}) exceeds payment amount (${fmtCurrency(numAmt)}).`
      }
    }

    if (Object.keys(errs).length > 0) {
      setFormErrors(errs)
      return
    }

    setSaving(true)
    setFormErrors({})

    try {
      const payload = {
        party_id: selectedPartyId,
        payment_date: paymentDate,
        amount: numAmt,
        method: paymentMethod,
        external_ref: externalRef.trim() || undefined,
        notes: notes.trim() || undefined,
        allocation_strategy: allocationStrategy,
      }

      if (allocationStrategy === 'specific') {
        payload.allocations = Object.entries(specificAllocations)
          .filter(([, v]) => Number(v) > 0)
          .map(([saleId, v]) => ({ sale_id: saleId, allocated_amount: Number(v) }))
      }

      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })

      const d = await res.json()
      if (!res.ok) {
        if (d.errors) {
          setFormErrors(d.errors)
        } else {
          throw new Error(d.message || d.error || 'Failed to record payment.')
        }
        return
      }

      addToast({
        type: 'success',
        message: d.message || `Payment ${d.payment?.payment_number} recorded successfully.`,
      })
      setShowModal(false)
      fetchPayments()

      if (d.payment) {
        openDetailModal(d.payment)
      }
    } catch (err) {
      addToast({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  // ── Open Void Modal (Admin Only) ────────────────────────────
  function openVoidModal(pay) {
    setVoidModal(pay)
    setVoidReason('')
    setVoidError('')
  }

  async function handleVoidSubmit(e) {
    e.preventDefault()
    if (!voidReason || voidReason.trim().length < 3) {
      setVoidError('A mandatory void reason of at least 3 characters is required.')
      return
    }

    setVoidSaving(true)
    setVoidError('')
    try {
      const res = await fetch(`/api/payments/${voidModal.id}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ void_reason: voidReason.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to void payment.')

      addToast({ type: 'success', message: d.message || 'Payment voided successfully.' })
      setVoidModal(null)
      setShowDetail(false)
      fetchPayments()
    } catch (err) {
      setVoidError(err.message)
    } finally {
      setVoidSaving(false)
    }
  }

  // ── Helper for setting specific allocation max ──────────────
  function setInvoiceAllocMax(saleId, maxDue) {
    setSpecificAllocations(prev => ({
      ...prev,
      [saleId]: String(maxDue),
    }))
  }

  return (
    <div className="page">
      {/* ── Page Header ────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Payments</h2>
          <p className="page-subtitle">
            Record customer payment receipts, manage FIFO or invoice allocations, and view receipts.
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            id="record-payment-btn"
            onClick={() => openRecordModal()}
          >
            + Record Payment
          </button>
        </div>
      </div>

      {/* ── KPI Metric Cards ───────────────────────────────────── */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
          <div className="card" style={{ padding: '1.1rem 1.25rem', borderLeft: '4px solid var(--color-primary)' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
              Total Collections
            </div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--color-text)', marginTop: 4 }}>
              {fmtCurrency(summary.total_amount)}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
              Across {summary.total_count} active payment receipts
            </div>
          </div>

          <div className="card" style={{ padding: '1.1rem 1.25rem', borderLeft: '4px solid var(--color-ok)' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
              Allocated to Invoices
            </div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--color-ok)', marginTop: 4 }}>
              {fmtCurrency(summary.total_allocated)}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
              Applied directly against credit sales
            </div>
          </div>

          <div className="card" style={{ padding: '1.1rem 1.25rem', borderLeft: '4px solid #7c3aed' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
              Unallocated Advances
            </div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: '#7c3aed', marginTop: 4 }}>
              {fmtCurrency(summary.total_unallocated)}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
              Customer credit balance available
            </div>
          </div>
        </div>
      )}

      {/* ── Filter Toolbar ─────────────────────────────────────── */}
      <div className="card" style={{ padding: '1rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Search Receipts</label>
            <input
              type="text"
              className="form-input"
              placeholder="Receipt #, Customer, Ref…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Payment Method</label>
            <select
              className="form-input"
              value={filterMethod}
              onChange={(e) => { setFilterMethod(e.target.value); setPage(1) }}
            >
              <option value="">All Methods</option>
              <option value="cash">Cash</option>
              <option value="upi">UPI / QR</option>
              <option value="bank">Bank Transfer</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Allocation Status</label>
            <select
              className="form-input"
              value={filterAllocation}
              onChange={(e) => { setFilterAllocation(e.target.value); setPage(1) }}
            >
              <option value="">All Allocations</option>
              <option value="allocated">Fully Allocated</option>
              <option value="partial">Partially Allocated</option>
              <option value="unallocated">Unallocated Advance</option>
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Status</label>
            <select
              className="form-input"
              value={filterStatus}
              onChange={(e) => { setFilterStatus(e.target.value); setPage(1) }}
            >
              <option value="active">Active Only</option>
              <option value="voided">Voided Only</option>
              <option value="all">All Receipts</option>
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>From Date</label>
            <input
              type="date"
              className="form-input"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); setPage(1) }}
            />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>To Date</label>
            <input
              type="date"
              className="form-input"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); setPage(1) }}
            />
          </div>
        </div>
      </div>

      {/* ── Payments History Table ─────────────────────────────── */}
      {loading ? (
        <LoadingState label="Loading payments…" />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchPayments} />
      ) : payments.length === 0 ? (
        <EmptyState
          icon="💳"
          title="No payment receipts found"
          message="No payments match your current filter criteria."
          action={() => openRecordModal()}
          actionLabel="+ Record Payment"
        />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-responsive">
            <table className="table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Receipt #</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Method</th>
                  <th style={{ textAlign: 'right' }}>Total Amount</th>
                  <th style={{ textAlign: 'right' }}>Allocated</th>
                  <th style={{ textAlign: 'right' }}>Advance / Unapplied</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                  <th style={{ textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const mBadge = METHOD_BADGES[p.method] || METHOD_BADGES.cash
                  const isVoid = !!p.voided_at
                  const unalloc = Number(p.unallocated_amount || 0)

                  return (
                    <tr
                      key={p.id}
                      style={{
                        opacity: isVoid ? 0.6 : 1,
                        cursor: 'pointer',
                        transition: 'background 0.15s ease',
                      }}
                      onClick={() => openDetailModal(p)}
                    >
                      <td style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--color-primary)' }}>
                        {p.payment_number}
                      </td>
                      <td style={{ fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>
                        <div>{fmtDate(p.payment_date)}</div>
                        <div style={{ color: 'var(--color-muted)', fontSize: '10px' }}>
                          {fmtDateTime(p.payment_timestamp).split(' ')[1]}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.party_name || 'Walk-In / Anonymous'}</div>
                        {p.party_code && (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontFamily: 'monospace' }}>
                            {p.party_code}
                          </div>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            fontSize: 'var(--text-xs)',
                            fontWeight: 600,
                            color: mBadge.color,
                            backgroundColor: mBadge.bg,
                          }}
                        >
                          {mBadge.label}
                        </span>
                        {p.external_ref && (
                          <div style={{ fontSize: '10px', color: 'var(--color-muted)', marginTop: 2, fontFamily: 'monospace' }}>
                            {p.external_ref}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800, fontSize: 'var(--text-sm)', color: isVoid ? 'var(--color-muted)' : 'var(--color-text)' }}>
                        {fmtCurrency(p.amount)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--color-ok)' }}>
                        {fmtCurrency(p.allocated_amount)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: unalloc > 0.005 ? '#7c3aed' : 'var(--color-muted)' }}>
                        {fmtCurrency(unalloc)}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {isVoid ? (
                          <StatusBadge type="danger">Voided</StatusBadge>
                        ) : unalloc <= 0.005 ? (
                          <StatusBadge type="success">Fully Applied</StatusBadge>
                        ) : Number(p.allocated_amount) > 0.005 ? (
                          <StatusBadge type="warning">Partial</StatusBadge>
                        ) : (
                          <span style={{ fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: 12, background: 'rgba(124, 58, 237, 0.1)', color: '#7c3aed', fontWeight: 600 }}>
                            Advance
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => openDetailModal(p)}
                          title="View Receipt"
                        >
                          Receipt
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Modal: Record Payment ──────────────────────────────── */}
      {showModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="modal" style={{ maxWidth: 600 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">Record Payment Receipt</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>x</button>
            </div>

            <form onSubmit={handlePaymentSubmit}>
              {/* Customer Selector */}
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="pay-customer">Select Customer *</label>
                <select
                  id="pay-customer"
                  className={`form-input ${formErrors.party_id ? 'form-input--error' : ''}`}
                  value={selectedPartyId}
                  onChange={(e) => setSelectedPartyId(e.target.value)}
                >
                  <option value="">— Select Customer (Party ID, Name, Location) —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      [{c.party_code}] {c.name} {c.address ? `· ${c.address}` : ''} ({c.party_type})
                    </option>
                  ))}
                </select>
                {formErrors.party_id && (
                  <div className="form-error" style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
                    {formErrors.party_id}
                  </div>
                )}
              </div>

              {/* Date & Amount */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Payment Date *</label>
                  <input
                    type="date"
                    className="form-input"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Amount (₹) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    className={`form-input ${formErrors.amount ? 'form-input--error' : ''}`}
                    placeholder="e.g. 5000.00"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    autoFocus
                  />
                  {formErrors.amount && (
                    <div className="form-error" style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
                      {formErrors.amount}
                    </div>
                  )}
                </div>
              </div>

              {/* Method & External Reference */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Payment Method</label>
                  <select
                    className="form-input"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                  >
                    <option value="cash">Cash</option>
                    <option value="upi">UPI / QR Code</option>
                    <option value="bank">Bank Transfer / NEFT</option>
                    <option value="other">Other / Cheque</option>
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Reference / UTR / Cheque #</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. UPI-1982736"
                    value={externalRef}
                    onChange={(e) => setExternalRef(e.target.value)}
                  />
                </div>
              </div>

              {/* Allocation Strategy Selection */}
              <div style={{ marginBottom: '1rem', background: 'var(--color-surface)', padding: '0.85rem', borderRadius: 'var(--radius-sm)' }}>
                <label className="form-label" style={{ marginBottom: 6 }}>Allocation Strategy</label>
                <div style={{ display: 'flex', gap: '1rem', fontSize: 'var(--text-sm)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="strategy"
                      value="fifo"
                      checked={allocationStrategy === 'fifo'}
                      onChange={() => setAllocationStrategy('fifo')}
                    />
                    <span>Auto FIFO (Oldest open bills first)</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="strategy"
                      value="specific"
                      checked={allocationStrategy === 'specific'}
                      onChange={() => setAllocationStrategy('specific')}
                    />
                    <span>Specific Invoices</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="strategy"
                      value="unallocated"
                      checked={allocationStrategy === 'unallocated'}
                      onChange={() => setAllocationStrategy('unallocated')}
                    />
                    <span>Advance Credit</span>
                  </label>
                </div>

                {/* Open Invoices selector when Specific is chosen */}
                {allocationStrategy === 'specific' && (
                  <div style={{ marginTop: '0.85rem', paddingTop: '0.85rem', borderTop: '1px solid var(--color-border)' }}>
                    <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--color-text)', marginBottom: 6 }}>
                      Select Invoices & Enter Allocation:
                    </div>

                    {loadingInvoices ? (
                      <LoadingState label="Checking open invoices…" />
                    ) : openInvoices.length === 0 ? (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                        This customer currently has no unpaid credit invoices. Payment will be recorded as advance credit.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                        {openInvoices.map((inv) => {
                          const currentAlloc = specificAllocations[inv.id] || ''
                          return (
                            <div
                              key={inv.id}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '120px 1fr 100px 60px',
                                gap: 8,
                                alignItems: 'center',
                                fontSize: 'var(--text-xs)',
                                padding: '4px 6px',
                                background: 'rgba(255, 255, 255, 0.05)',
                                borderRadius: 4,
                              }}
                            >
                              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{inv.sale_number}</span>
                              <span style={{ color: 'var(--color-muted)' }}>Due: {fmtCurrency(inv.due_amount)}</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                max={inv.due_amount}
                                className="form-input"
                                style={{ padding: '2px 6px', height: 26, fontSize: '11px', textAlign: 'right' }}
                                placeholder="0.00"
                                value={currentAlloc}
                                onChange={(e) => setSpecificAllocations({
                                  ...specificAllocations,
                                  [inv.id]: e.target.value,
                                })}
                              />
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                style={{ padding: '1px 6px', fontSize: '10px' }}
                                onClick={() => setInvoiceAllocMax(inv.id, inv.due_amount)}
                              >
                                Max
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {formErrors.allocations && (
                      <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
                        {formErrors.allocations}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Notes */}
              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label">Notes (Optional)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Paid in full on delivery"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              {/* Live Preview Summary */}
              {Number(paymentAmount) > 0 && (
                <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', borderRadius: 'var(--radius-sm)', padding: '0.65rem 0.85rem', marginBottom: '1.25rem', fontSize: 'var(--text-xs)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span>Payment Received:</span>
                    <strong>{fmtCurrency(paymentAmount)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-muted)' }}>
                    <span>Strategy:</span>
                    <span style={{ textTransform: 'uppercase' }}>{allocationStrategy}</span>
                  </div>
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  id="confirm-payment-btn"
                  disabled={saving || !paymentAmount || Number(paymentAmount) <= 0}
                >
                  {saving ? 'Recording…' : `Confirm Receipt (${fmtCurrency(paymentAmount || 0)})`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Payment Receipt Drawer ──────────────────────── */}
      {showDetail && selectedPay && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowDetail(false) }}>
          <div className="modal" style={{ maxWidth: 540 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">
                Payment Receipt — {detailData?.payment?.payment_number || selectedPay.payment_number}
              </h3>
              <button className="modal-close" onClick={() => setShowDetail(false)}>x</button>
            </div>

            {detailLoading ? (
              <div style={{ padding: '2rem' }}>
                <LoadingState label="Loading receipt details…" />
              </div>
            ) : !detailData?.payment ? (
              <div style={{ padding: '1rem', color: 'var(--color-error)' }}>
                Could not load payment receipt details.
              </div>
            ) : (
              <div>
                {/* Shop Receipt Header */}
                <div style={{ textAlign: 'center', paddingBottom: '0.85rem', borderBottom: '1px dashed var(--color-border)', marginBottom: '1rem' }}>
                  <div style={{ fontWeight: 800, fontSize: 'var(--text-lg)', color: 'var(--color-text)' }}>
                    BISMILLAH CHICKEN SHOP
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                    Official Payment Acknowledgement Receipt
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-primary)', marginTop: 4 }}>
                    Receipt #{detailData.payment.payment_number} · {fmtDateTime(detailData.payment.payment_timestamp)}
                  </div>
                </div>

                {/* Customer Info */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem', fontSize: 'var(--text-xs)' }}>
                  <div>
                    <span style={{ color: 'var(--color-muted)' }}>Received From: </span>
                    <strong>{detailData.payment.party_name || 'Walk-In Customer'}</strong>
                    {detailData.payment.party_code && (
                      <span style={{ marginLeft: 4, fontFamily: 'monospace' }}>({detailData.payment.party_code})</span>
                    )}
                    {detailData.payment.party_address && (
                      <div style={{ color: 'var(--color-muted)', marginTop: 2 }}>📍 {detailData.payment.party_address}</div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--color-muted)' }}>Recorded By: </span>
                    <strong>{detailData.payment.recorded_by_name || 'Staff'}</strong>
                    {detailData.payment.external_ref && (
                      <div style={{ color: 'var(--color-muted)', marginTop: 2 }}>
                        Ref: <span style={{ fontFamily: 'monospace' }}>{detailData.payment.external_ref}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Amount Box */}
                <div style={{ background: 'var(--color-surface)', padding: '1rem', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', textAlign: 'center' }}>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
                    Total Amount Received ({detailData.payment.method?.toUpperCase()})
                  </div>
                  <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 900, color: 'var(--color-ok)', margin: '4px 0' }}>
                    {fmtCurrency(detailData.payment.amount)}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                    Allocated: {fmtCurrency(detailData.payment.allocated_amount)} · Advance Credit: {fmtCurrency(detailData.payment.unallocated_amount)}
                  </div>
                </div>

                {/* Allocations Breakdown */}
                {detailData.allocations && detailData.allocations.length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-muted)', marginBottom: 4 }}>
                      Applied Towards Invoices
                    </div>
                    <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                      <table style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
                        <thead>
                          <tr style={{ background: 'var(--color-surface)' }}>
                            <th>Invoice #</th>
                            <th>Date</th>
                            <th style={{ textAlign: 'right' }}>Invoice Total</th>
                            <th style={{ textAlign: 'right' }}>Allocated Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailData.allocations.map((a) => (
                            <tr key={a.allocation_id}>
                              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{a.sale_number}</td>
                              <td>{fmtDate(a.sale_date)}</td>
                              <td style={{ textAlign: 'right' }}>{fmtCurrency(a.invoice_total)}</td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--color-ok)' }}>
                                {fmtCurrency(a.allocated_amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Void banner */}
                {detailData.payment.voided_at && (
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 'var(--radius-sm)', color: 'var(--color-error)', fontSize: 'var(--text-xs)', marginBottom: '1rem' }}>
                    <strong>VOIDED RECEIPT:</strong> {detailData.payment.void_reason || 'Cancelled'}
                    <div style={{ color: 'var(--color-muted)', marginTop: 2 }}>
                      Voided on {fmtDateTime(detailData.payment.voided_at)} by {detailData.payment.voided_by_name || 'Admin'}
                    </div>
                  </div>
                )}

                <div className="modal-footer" style={{ marginTop: '1.25rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowDetail(false)}>
                    Close
                  </button>
                  {isAdmin && !detailData.payment.voided_at && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ color: 'var(--color-error)', borderColor: 'rgba(239, 68, 68, 0.4)' }}
                      onClick={() => openVoidModal(detailData.payment)}
                    >
                      Void Payment
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modal: Authorized Void Payment (Admin Only) ────────── */}
      {voidModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setVoidModal(null) }}>
          <div className="modal" style={{ maxWidth: 460 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title" style={{ color: 'var(--color-error)' }}>
                Authorized Void — {voidModal.payment_number}
              </h3>
              <button className="modal-close" onClick={() => setVoidModal(null)}>x</button>
            </div>

            <form onSubmit={handleVoidSubmit}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)', lineHeight: 1.6, marginBottom: '1rem' }}>
                Are you sure you want to void payment receipt <strong>{voidModal.payment_number}</strong> ({fmtCurrency(voidModal.amount)})?
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
                  All allocations applied to customer invoices will also be cancelled and customer debt restored.
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label" htmlFor="pay-void-reason">Void Reason * (Mandatory for audit trail)</label>
                <textarea
                  id="pay-void-reason"
                  className="form-input"
                  rows={3}
                  placeholder="e.g. Cheque returned unpaid, duplicate entry, incorrect amount…"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  autoFocus
                />
                {voidError && (
                  <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
                    {voidError}
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setVoidModal(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)' }}
                  disabled={voidSaving || !voidReason.trim()}
                >
                  {voidSaving ? 'Voiding…' : 'Confirm & Void Payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
