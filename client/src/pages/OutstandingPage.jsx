/**
 * client/src/pages/OutstandingPage.jsx
 *
 * Phase 10 — Outstanding Balances & Customer Ledger Statement
 *
 * Core Features:
 *   • Top-level Outstanding Metrics (Total Debt across shop, Owing customer count).
 *   • Customer Balances Table with Search, Type Filter, Balance Only Toggle, and Sorting (Highest Due First).
 *   • Quick Actions:
 *       - "+ Record Payment": Direct payment modal for that customer.
 *       - "Statement / Ledger": Comprehensive chronological statement with running balance.
 *   • Customer Statement Drawer:
 *       - Opening Balance + Sales Charges + Payments + Adjustments.
 *       - Running Balance column on every row reconciling 100% with the closing balance.
 *       - Date range filtering (From/To).
 *       - Printable statement format.
 */

import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState } from '../components/ui/UIStates.jsx'
import { CircleCheck, MapPin } from '../components/ui/Icons.jsx'
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

const TYPE_CONFIG = {
  hotel:  { label: 'Hotel / Restaurant', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.1)' },
  party:  { label: 'Party / Event',       color: '#7c3aed', bg: 'rgba(124, 58, 237, 0.1)' },
  retail: { label: 'Regular Credit',      color: '#059669', bg: 'rgba(5, 150, 105, 0.1)' },
}

export default function OutstandingPage({ user, addToast }) {
  // ── State: Outstanding Balances List ────────────────────────
  const [customers,  setCustomers]  = useState([])
  const [summary,    setSummary]    = useState(null)
  const [total,      setTotal]      = useState(0)
  const [page,       setPage]       = useState(1)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  // ── State: Filters & Sort ───────────────────────────────────
  const [search,      setSearch]      = useState('')
  const [partyType,   setPartyType]   = useState('')
  const [hasBalance,  setHasBalance]  = useState('true') // 'true' | 'false' | 'all'
  const [sortOrder,   setSortOrder]   = useState('balance_desc') // 'balance_desc' | 'balance_asc' | 'name_asc'

  // ── State: Statement / Ledger Drawer ────────────────────────
  const [showStatement,     setShowStatement]     = useState(false)
  const [statementCustomer, setStatementCustomer] = useState(null)
  const [statementData,     setStatementData]     = useState(null)
  const [statementLoading,  setStatementLoading]  = useState(false)
  const [stmtFrom,          setStmtFrom]          = useState('')
  const [stmtTo,            setStmtTo]            = useState('')

  // ── State: Quick Payment Modal ──────────────────────────────
  const [quickPayCustomer,  setQuickPayCustomer]  = useState(null)
  const [payAmount,         setPayAmount]         = useState('')
  const [payMethod,         setPayMethod]         = useState('cash')
  const [payRef,            setPayRef]            = useState('')
  const [payNotes,          setPayNotes]          = useState('')
  const [paySaving,         setPaySaving]         = useState(false)
  const [payError,          setPayError]          = useState('')

  // ── Fetch Outstanding List ──────────────────────────────────
  const fetchOutstanding = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (partyType)     params.set('party_type', partyType)
      if (hasBalance)    params.set('has_balance', hasBalance)
      params.set('sort', sortOrder)
      params.set('page', page)
      params.set('limit', 50)

      const res = await fetch(`/api/outstanding?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP error ${res.status}`)
      const data = await res.json()

      setCustomers(data.customers || [])
      setSummary(data.summary || null)
      setTotal(data.total || 0)
    } catch (err) {
      setError(err.message || 'Failed to load outstanding balances.')
    } finally {
      setLoading(false)
    }
  }, [search, partyType, hasBalance, sortOrder, page])

  useEffect(() => {
    fetchOutstanding()
  }, [fetchOutstanding])

  // ── Fetch Customer Statement ────────────────────────────────
  const fetchStatement = useCallback(async (customerId, from = '', to = '') => {
    setStatementLoading(true)
    try {
      const params = new URLSearchParams()
      if (from) params.set('from', from)
      if (to)   params.set('to', to)

      const res = await fetch(`/api/ledger/${customerId}?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP error ${res.status}`)
      const d = await res.json()
      setStatementData(d)
    } catch (err) {
      addToast({ type: 'error', message: `Could not load statement: ${err.message}` })
    } finally {
      setStatementLoading(false)
    }
  }, [addToast])

  function openStatementModal(cust) {
    setStatementCustomer(cust)
    setStmtFrom('')
    setStmtTo('')
    setShowStatement(true)
    fetchStatement(cust.id)
  }

  function handleFilterStatement(e) {
    e.preventDefault()
    if (statementCustomer) {
      fetchStatement(statementCustomer.id, stmtFrom, stmtTo)
    }
  }

  // ── Quick Payment Submission ────────────────────────────────
  function openQuickPay(cust) {
    setQuickPayCustomer(cust)
    setPayAmount(Number(cust.current_balance) > 0 ? String(cust.current_balance) : '')
    setPayMethod('cash')
    setPayRef('')
    setPayNotes('')
    setPayError('')
  }

  async function handleQuickPaySubmit(e) {
    e.preventDefault()
    const num = Number(payAmount)
    if (!payAmount || isNaN(num) || num <= 0) {
      setPayError('Please enter a valid amount strictly greater than zero.')
      return
    }

    setPaySaving(true)
    setPayError('')

    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          party_id: quickPayCustomer.id,
          payment_date: todayIST(),
          amount: num,
          method: payMethod,
          external_ref: payRef.trim() || undefined,
          notes: payNotes.trim() || undefined,
          allocation_strategy: 'fifo',
        }),
      })

      const d = await res.json()
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to record payment.')

      addToast({
        type: 'success',
        message: `Payment ${d.payment?.payment_number} recorded. Balance updated.`,
      })
      setQuickPayCustomer(null)
      fetchOutstanding()

      // If statement drawer is open for this customer, refresh it too
      if (showStatement && statementCustomer?.id === quickPayCustomer.id) {
        fetchStatement(quickPayCustomer.id, stmtFrom, stmtTo)
      }
    } catch (err) {
      setPayError(err.message)
    } finally {
      setPaySaving(false)
    }
  }

  return (
    <div className="page">
      {/* ── Page Header ────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Outstanding Balances</h2>
          <p className="page-subtitle">
            Monitor customer credit balances, view itemized account statements, and record receipts.
          </p>
        </div>
      </div>

      {/* ── KPI Metric Cards ───────────────────────────────────── */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
          <div className="card" style={{ padding: '1.1rem 1.25rem', borderLeft: '4px solid #b45309' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
              Total Outstanding Due
            </div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: '#b45309', marginTop: 4 }}>
              {fmtCurrency(summary.total_outstanding_amount)}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
              Across all customer credit accounts
            </div>
          </div>

          <div className="card" style={{ padding: '1.1rem 1.25rem', borderLeft: '4px solid var(--color-error)' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
              Accounts with Due Balance
            </div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--color-error)', marginTop: 4 }}>
              {summary.owing_customers_count}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
              Out of {summary.total_customers} active customers
            </div>
          </div>

          <div className="card" style={{ padding: '1.1rem 1.25rem', borderLeft: '4px solid var(--color-ok)' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
              Clear / Advance Accounts
            </div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--color-ok)', marginTop: 4 }}>
              {Math.max(0, summary.total_customers - summary.owing_customers_count)}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
              Zero balance or in advance credit
            </div>
          </div>
        </div>
      )}

      {/* ── Search & Filter Toolbar ────────────────────────────── */}
      <div className="card" style={{ padding: '1rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Search Customer</label>
            <input
              type="text"
              className="form-input"
              placeholder="Name, Party ID, Phone…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Customer Type</label>
            <select
              className="form-input"
              value={partyType}
              onChange={(e) => { setPartyType(e.target.value); setPage(1) }}
            >
              <option value="">All Types</option>
              <option value="hotel">Hotel / Restaurant</option>
              <option value="party">Party / Event</option>
              <option value="retail">Regular Credit</option>
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Balance Status</label>
            <select
              className="form-input"
              value={hasBalance}
              onChange={(e) => { setHasBalance(e.target.value); setPage(1) }}
            >
              <option value="true">Owing Balance Only (&gt; ₹0)</option>
              <option value="false">Clear / Advance Credit (≤ ₹0)</option>
              <option value="">All Accounts</option>
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Sort Order</label>
            <select
              className="form-input"
              value={sortOrder}
              onChange={(e) => { setSortOrder(e.target.value); setPage(1) }}
            >
              <option value="balance_desc">Highest Due First</option>
              <option value="balance_asc">Lowest Due First</option>
              <option value="name_asc">Customer Name (A-Z)</option>
            </select>
          </div>
        </div>
      </div>

      {/* ── Outstanding Balances Table ─────────────────────────── */}
      {loading ? (
        <LoadingState label="Calculating customer balances…" />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchOutstanding} />
      ) : customers.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title="No outstanding balances"
          message={hasBalance === 'true' ? 'No customers currently have unpaid credit balances.' : 'No customer records match.'}
        />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-responsive">
            <table className="table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Customer (Party ID)</th>
                  <th>Type</th>
                  <th style={{ textAlign: 'right' }}>Opening Balance</th>
                  <th style={{ textAlign: 'right' }}>Credit Sales</th>
                  <th style={{ textAlign: 'right' }}>Payments</th>
                  <th style={{ textAlign: 'right' }}>Adjustments</th>
                  <th style={{ textAlign: 'right' }}>Current Outstanding</th>
                  <th style={{ textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => {
                  const bal = Number(c.current_balance || 0)
                  const tConfig = TYPE_CONFIG[c.party_type] || TYPE_CONFIG.hotel

                  return (
                    <tr
                      key={c.id}
                      style={{ cursor: 'pointer', transition: 'background 0.15s ease' }}
                      onClick={() => openStatementModal(c)}
                    >
                      <td>
                        <div style={{ fontWeight: 700, color: 'var(--color-text)' }}>{c.name}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', fontFamily: 'monospace' }}>
                          {c.party_code} {c.address ? <>· <MapPin size={11} style={{ verticalAlign: 'middle', marginRight: 2 }} />{c.address}</> : ''}
                        </div>
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: 'var(--text-xs)',
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: '12px',
                            color: tConfig.color,
                            backgroundColor: tConfig.bg,
                          }}
                        >
                          {tConfig.label}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 'var(--text-xs)' }}>
                        {fmtCurrency(c.opening_balance)}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 'var(--text-xs)' }}>
                        {fmtCurrency(c.total_credit_sales)}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 'var(--text-xs)', color: 'var(--color-ok)' }}>
                        {fmtCurrency(c.total_payments)}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 'var(--text-xs)' }}>
                        {fmtCurrency(c.total_adjustments)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 900, fontSize: 'var(--text-base)' }}>
                        <span style={{ color: bal > 0.005 ? '#b45309' : bal < -0.005 ? '#7c3aed' : 'var(--color-ok)' }}>
                          {fmtCurrency(bal)}
                        </span>
                        {bal < -0.005 && (
                          <div style={{ fontSize: '10px', color: '#7c3aed', fontWeight: 600 }}>ADVANCE</div>
                        )}
                      </td>
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ marginRight: 6 }}
                          onClick={() => openStatementModal(c)}
                          title="View Ledger Statement"
                        >
                          Statement
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => openQuickPay(c)}
                          title="Record Payment Receipt"
                        >
                          + Pay
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

      {/* ── Modal: Customer Ledger Statement Drawer ────────────── */}
      {showStatement && statementCustomer && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowStatement(false) }}>
          <div className="modal" style={{ maxWidth: 840 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">
                Customer Ledger Statement — {statementCustomer.name} ({statementCustomer.party_code})
              </h3>
              <button className="modal-close" onClick={() => setShowStatement(false)}>x</button>
            </div>

            {/* Date Range Filter Bar */}
            <form onSubmit={handleFilterStatement} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', background: 'var(--color-surface)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', marginBottom: '1rem' }}>
              <div className="form-group" style={{ margin: 0, flex: 1 }}>
                <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>From Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={stmtFrom}
                  onChange={(e) => setStmtFrom(e.target.value)}
                />
              </div>
              <div className="form-group" style={{ margin: 0, flex: 1 }}>
                <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>To Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={stmtTo}
                  onChange={(e) => setStmtTo(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-secondary btn-sm" style={{ height: 38 }}>
                Filter Period
              </button>
              {(stmtFrom || stmtTo) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ height: 38 }}
                  onClick={() => { setStmtFrom(''); setStmtTo(''); fetchStatement(statementCustomer.id) }}
                >
                  Clear
                </button>
              )}
            </form>

            {statementLoading ? (
              <div style={{ padding: '3rem' }}>
                <LoadingState label="Computing running ledger balance…" />
              </div>
            ) : !statementData ? (
              <div style={{ padding: '1rem', color: 'var(--color-error)' }}>
                Could not load customer ledger statement.
              </div>
            ) : (
              <div>
                {/* Statement Summary KPI Header */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
                  <div style={{ background: 'var(--color-surface)', padding: '0.65rem 0.85rem', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase' }}>Period Opening</div>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800 }}>
                      {fmtCurrency(statementData.period.opening_balance)}
                    </div>
                  </div>
                  <div style={{ background: 'var(--color-surface)', padding: '0.65rem 0.85rem', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase' }}>Total Debits (+)</div>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800, color: '#b45309' }}>
                      {fmtCurrency(statementData.period.total_debits)}
                    </div>
                  </div>
                  <div style={{ background: 'var(--color-surface)', padding: '0.65rem 0.85rem', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase' }}>Total Credits (-)</div>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800, color: 'var(--color-ok)' }}>
                      {fmtCurrency(statementData.period.total_credits)}
                    </div>
                  </div>
                  <div style={{ background: 'var(--color-surface)', padding: '0.65rem 0.85rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', fontWeight: 700 }}>Closing Balance</div>
                    <div style={{ fontSize: 'var(--text-xl)', fontWeight: 900, color: Number(statementData.period.closing_balance) > 0 ? '#b45309' : 'var(--color-ok)' }}>
                      {fmtCurrency(statementData.period.closing_balance)}
                    </div>
                  </div>
                </div>

                {/* Chronological Statement Table */}
                {statementData.statement.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-muted)' }}>
                    No ledger transactions recorded in this period.
                  </div>
                ) : (
                  <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', maxHeight: 380, overflowY: 'auto' }}>
                    <table style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
                      <thead>
                        <tr style={{ background: 'var(--color-surface)', position: 'sticky', top: 0, zIndex: 1 }}>
                          <th>Date</th>
                          <th>Type</th>
                          <th>Reference</th>
                          <th>Description</th>
                          <th style={{ textAlign: 'right' }}>Debit (+)</th>
                          <th style={{ textAlign: 'right' }}>Credit (-)</th>
                          <th style={{ textAlign: 'right' }}>Running Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statementData.statement.map((row) => {
                          const deb = Number(row.debit)
                          const crd = Number(row.credit)
                          const run = Number(row.running_balance)

                          return (
                            <tr key={row.id}>
                              <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(row.date)}</td>
                              <td>
                                <span style={{
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  textTransform: 'uppercase',
                                  background: row.entry_type === 'sale' ? 'rgba(37, 99, 235, 0.1)' : row.entry_type === 'payment' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(124, 58, 237, 0.1)',
                                  color: row.entry_type === 'sale' ? '#2563eb' : row.entry_type === 'payment' ? '#059669' : '#7c3aed',
                                }}>
                                  {row.entry_type.replace('_', ' ')}
                                </span>
                              </td>
                              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{row.reference}</td>
                              <td style={{ color: 'var(--color-muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {row.description}
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: deb > 0 ? 700 : 400 }}>
                                {deb > 0 ? fmtCurrency(deb) : '—'}
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: crd > 0 ? 700 : 400, color: crd > 0 ? 'var(--color-ok)' : undefined }}>
                                {crd > 0 ? fmtCurrency(crd) : '—'}
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 800, color: run > 0.005 ? '#b45309' : 'var(--color-ok)' }}>
                                {fmtCurrency(run)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="modal-footer" style={{ marginTop: '1.25rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowStatement(false)}>
                    Close
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => { setShowStatement(false); openQuickPay(statementCustomer) }}
                  >
                    + Record Payment
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modal: Quick Record Payment ────────────────────────── */}
      {quickPayCustomer && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setQuickPayCustomer(null) }}>
          <div className="modal" style={{ maxWidth: 480 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">Record Payment — {quickPayCustomer.name}</h3>
              <button className="modal-close" onClick={() => setQuickPayCustomer(null)}>x</button>
            </div>

            <form onSubmit={handleQuickPaySubmit}>
              <div style={{ background: 'var(--color-surface)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', fontSize: 'var(--text-xs)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>Customer:</span>
                  <strong>{quickPayCustomer.name} ({quickPayCustomer.party_code})</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Current Outstanding Debt:</span>
                  <strong style={{ color: Number(quickPayCustomer.current_balance) > 0 ? '#b45309' : 'var(--color-ok)' }}>
                    {fmtCurrency(quickPayCustomer.current_balance)}
                  </strong>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label">Payment Amount (₹) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  className="form-input"
                  placeholder="0.00"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  autoFocus
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Method</label>
                  <select
                    className="form-input"
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value)}
                  >
                    <option value="cash">Cash</option>
                    <option value="upi">UPI / QR</option>
                    <option value="bank">Bank Transfer</option>
                    <option value="other">Other / Cheque</option>
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Reference / UTR #</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. UPI-984201"
                    value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label">Notes (Optional)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Part payment on weekly account"
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                />
              </div>

              {payError && (
                <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)', marginBottom: '1rem' }}>
                  {payError}
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setQuickPayCustomer(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={paySaving || !payAmount || Number(payAmount) <= 0}
                >
                  {paySaving ? 'Recording…' : `Confirm Payment (${fmtCurrency(payAmount || 0)})`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
