/**
 * client/src/pages/SalesPage.jsx
 *
 * Phase 09 — Sales Management
 *
 * Core Business Rules Enforced in UI:
 *   • Multi-Item Support:
 *       - Single sale can contain multiple products (live, dressed, cuts, offal).
 *   • Server-Side Calculation Alignment:
 *       - Line Total = quantity_kg * rate_per_kg
 *       - Sale Total = sum of line totals
 *       - Real-time client preview matches server calculations.
 *   • Historical Rate Snapshot:
 *       - Auto-suggests today's daily price, but allows actual rate override.
 *       - Stored directly on line item; future price updates never alter past sales.
 *   • Fast Walk-In Workflow:
 *       - Optimized for retail counter sales with instant payment (Cash, UPI).
 *   • Party / Credit Workflow:
 *       - Customer selection clearly displays Party ID, Name, and Location.
 *       - Supports full credit, partial payment, and full cash payment.
 *       - Validates credit eligibility (credit_enabled) for credit sales.
 *   • No Double-Counting:
 *       - Immediate payment recorded in payments and allocated to this sale.
 *       - Remaining due = total_amount - paid_amount.
 *   • Authorized Void & Audit Trail:
 *       - Admin only can void confirmed sales with a mandatory reason.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { LoadingState, ErrorState, EmptyState, StatusBadge } from '../components/ui/UIStates.jsx'
import { ReceiptText, MapPin } from '../components/ui/Icons.jsx'
import './pages.css'

// ── Helpers ────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function fmtDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
}

function fmtCurrency(v) {
  if (v === null || v === undefined) return '₹0.00'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(v))
}

function fmtKg(v) {
  if (v === null || v === undefined) return '0.000 kg'
  return `${Number(v).toFixed(3)} kg`
}

function fmtDateTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' ' +
         d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
}

function roundCurrency(val) {
  return Math.round((Number(val) + Number.EPSILON) * 100) / 100
}

const SALE_TYPE_BADGES = {
  walkin:       { label: 'Walk-In',       color: '#059669', bg: 'rgba(5, 150, 105, 0.1)' },
  party_cash:   { label: 'Party Cash',    color: '#2563eb', bg: 'rgba(37, 99, 235, 0.1)' },
  party_credit: { label: 'Credit Account', color: '#b45309', bg: 'rgba(245, 158, 11, 0.1)' },
}

export default function SalesPage({ user, addToast }) {
  const isAdmin = user?.role === 'admin'

  // ── State: Sales history & summary ────────────────────────
  const [sales,   setSales]   = useState([])
  const [summary, setSummary] = useState(null)
  const [total,   setTotal]   = useState(0)
  const [page,    setPage]    = useState(1)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  // ── State: Filters ────────────────────────────────────────
  const [search,         setSearch]         = useState('')
  const [filterType,     setFilterType]     = useState('')
  const [filterPayment,  setFilterPayment]  = useState('')
  const [filterFrom,     setFilterFrom]     = useState('')
  const [filterTo,       setFilterTo]       = useState('')

  // ── State: Master data for dropdowns ──────────────────────
  const [products, setProducts] = useState([])
  const [parties,  setParties]  = useState([])
  const [prices,   setPrices]   = useState({}) // map product_id -> price_per_kg

  // ── State: Sale Creation Modal ────────────────────────────
  const [showModal,    setShowModal]    = useState(false)
  const [saleMode,     setSaleMode]     = useState('walkin') // 'walkin' or 'credit_party'
  const [saleDate,     setSaleDate]     = useState(todayIST())
  const [selectedParty, setSelectedParty] = useState('')
  const [partySaleType, setPartySaleType] = useState('party_credit')
  const [saleItems,    setSaleItems]    = useState([
    { product_id: '', quantity_kg: '', rate_per_kg: '', line_total: 0 }
  ])
  const [paymentOption, setPaymentOption] = useState('full') // 'full', 'partial', 'none'
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentRef,    setPaymentRef]    = useState('')
  const [saleNotes,     setSaleNotes]     = useState('')
  const [formErrors,    setFormErrors]    = useState({})
  const [saving,        setSaving]        = useState(false)

  // ── State: Receipt & Details Drawer ───────────────────────
  const [showDetail,    setShowDetail]    = useState(false)
  const [selectedSale,  setSelectedSale]  = useState(null)
  const [detailData,    setDetailData]    = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // ── State: Void Confirmation Modal ────────────────────────
  const [voidModal,   setVoidModal]   = useState(null) // sale object
  const [voidReason,  setVoidReason]  = useState('')
  const [voidError,   setVoidError]   = useState('')
  const [voidSaving,  setVoidSaving]  = useState(false)

  // ── Fetch Master Data (Products, Customers, Daily Prices) ─
  const fetchMasterData = useCallback(async () => {
    try {
      // 1. Products
      const prodRes = await fetch('/api/products?active_only=true', { credentials: 'include' })
      if (prodRes.ok) {
        const d = await prodRes.json()
        setProducts(d.products || [])
      }

      // 2. Customers / Parties
      const partyRes = await fetch('/api/customers?status=active&limit=100', { credentials: 'include' })
      if (partyRes.ok) {
        const d = await partyRes.json()
        setParties(d.customers || [])
      }

      // 3. Today's Prices
      const priceRes = await fetch('/api/daily-prices/today', { credentials: 'include' })
      if (priceRes.ok) {
        const d = await priceRes.json()
        const priceMap = {}
        for (const item of (d.prices || [])) {
          if (item.product_id && item.price_per_kg) {
            priceMap[item.product_id] = Number(item.price_per_kg)
          }
        }
        setPrices(priceMap)
      }
    } catch { /* ignore */ }
  }, [])

  // ── Fetch Sales History List ──────────────────────────────
  const fetchSales = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page,
        limit: 30,
      })
      if (search.trim())       params.set('search', search.trim())
      if (filterType)          params.set('sale_type', filterType)
      if (filterPayment)       params.set('payment_status', filterPayment)
      if (filterFrom)          params.set('from', filterFrom)
      if (filterTo)            params.set('to', filterTo)

      const res = await fetch(`/api/sales?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server returned error ${res.status}`)
      const d = await res.json()
      setSales(d.sales || [])
      setTotal(d.total || 0)
      setSummary(d.summary || null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [page, search, filterType, filterPayment, filterFrom, filterTo])

  useEffect(() => {
    fetchMasterData()
  }, [fetchMasterData])

  useEffect(() => {
    fetchSales()
  }, [fetchSales])

  // ── Calculate Live Totals for Create Modal ─────────────────
  const { calculatedSubtotal, calculatedPaid, calculatedDue } = useMemo(() => {
    let subtotal = 0
    for (const item of saleItems) {
      const qty  = Number(item.quantity_kg || 0)
      const rate = Number(item.rate_per_kg || 0)
      if (qty > 0 && rate > 0) {
        subtotal = roundCurrency(subtotal + roundCurrency(qty * rate))
      }
    }

    let paid = 0
    if (saleMode === 'walkin') {
      // Walkin defaults to full payment unless adjusted
      paid = paymentAmount !== '' ? roundCurrency(Number(paymentAmount)) : subtotal
    } else {
      if (paymentOption === 'full') {
        paid = subtotal
      } else if (paymentOption === 'none') {
        paid = 0
      } else if (paymentOption === 'partial') {
        paid = paymentAmount !== '' ? roundCurrency(Number(paymentAmount)) : 0
      }
    }

    const due = Math.max(0, roundCurrency(subtotal - paid))
    return { calculatedSubtotal: subtotal, calculatedPaid: paid, calculatedDue: due }
  }, [saleItems, saleMode, paymentOption, paymentAmount])

  // ── Open Fast Walk-In Modal ───────────────────────────────
  function openWalkInModal() {
    setSaleMode('walkin')
    setSaleDate(todayIST())
    setSelectedParty('')
    setPartySaleType('walkin')

    // Pre-populate with first product and its daily price if available
    const defaultProd = products[0]?.id || ''
    const defaultRate = prices[defaultProd] ? String(prices[defaultProd]) : ''

    setSaleItems([
      { product_id: defaultProd, quantity_kg: '', rate_per_kg: defaultRate, line_total: 0 }
    ])
    setPaymentOption('full')
    setPaymentAmount('')
    setPaymentMethod('cash')
    setPaymentRef('')
    setSaleNotes('')
    setFormErrors({})
    setShowModal(true)
  }

  // ── Open Credit / Party Sale Modal ────────────────────────
  function openPartySaleModal() {
    setSaleMode('credit_party')
    setSaleDate(todayIST())
    const defaultParty = parties[0]?.id || ''
    const partyObj = parties.find(p => p.id === defaultParty)
    setSelectedParty(defaultParty)
    setPartySaleType(partyObj?.credit_enabled ? 'party_credit' : 'party_cash')

    const defaultProd = products[0]?.id || ''
    const defaultRate = prices[defaultProd] ? String(prices[defaultProd]) : ''

    setSaleItems([
      { product_id: defaultProd, quantity_kg: '', rate_per_kg: defaultRate, line_total: 0 }
    ])
    setPaymentOption('none') // Default for credit is none (or partial)
    setPaymentAmount('')
    setPaymentMethod('cash')
    setPaymentRef('')
    setSaleNotes('')
    setFormErrors({})
    setShowModal(true)
  }

  // ── Line Items Manipulation ───────────────────────────────
  function handleItemChange(idx, field, value) {
    const updated = [...saleItems]
    updated[idx] = { ...updated[idx], [field]: value }

    // If product changed, automatically pre-fill today's rate if rate is empty or was previous default
    if (field === 'product_id' && prices[value]) {
      updated[idx].rate_per_kg = String(prices[value])
    }

    // Recompute line total
    const qty  = Number(updated[idx].quantity_kg || 0)
    const rate = Number(updated[idx].rate_per_kg || 0)
    updated[idx].line_total = qty > 0 && rate > 0 ? roundCurrency(qty * rate) : 0

    setSaleItems(updated)
  }

  function addItemRow() {
    const nextProd = products[0]?.id || ''
    const defaultRate = prices[nextProd] ? String(prices[nextProd]) : ''
    setSaleItems([
      ...saleItems,
      { product_id: nextProd, quantity_kg: '', rate_per_kg: defaultRate, line_total: 0 }
    ])
  }

  function removeItemRow(idx) {
    if (saleItems.length <= 1) return
    setSaleItems(saleItems.filter((_, i) => i !== idx))
  }

  // ── Customer Selection Change ─────────────────────────────
  function handlePartySelect(partyId) {
    setSelectedParty(partyId)
    const partyObj = parties.find(p => p.id === partyId)
    if (partyObj) {
      if (!partyObj.credit_enabled && partySaleType === 'party_credit') {
        setPartySaleType('party_cash')
      }
    }
  }

  // ── Handle Submit Sale ────────────────────────────────────
  async function handleSubmitSale(e) {
    e.preventDefault()
    setFormErrors({})

    const errors = {}

    // Line items validation
    if (saleItems.length === 0) {
      errors.items = 'Please add at least one line item.'
    } else {
      for (let i = 0; i < saleItems.length; i++) {
        const item = saleItems[i]
        if (!item.product_id) errors[`item_${i}_product`] = 'Product is required.'
        if (!item.quantity_kg || Number(item.quantity_kg) <= 0) {
          errors[`item_${i}_qty`] = 'Quantity must be > 0.'
        }
        if (!item.rate_per_kg || Number(item.rate_per_kg) <= 0) {
          errors[`item_${i}_rate`] = 'Rate must be > 0.'
        }
      }
    }

    if (calculatedSubtotal <= 0) {
      errors.total = 'Sale total must be greater than zero.'
    }

    // Party validation
    const effectiveSaleType = saleMode === 'walkin' ? 'walkin' : partySaleType
    if (effectiveSaleType !== 'walkin' && !selectedParty) {
      errors.party_id = 'Please select a customer account.'
    }

    // Payment validation
    let finalPaymentAmount = calculatedPaid
    if (finalPaymentAmount < 0) {
      errors.payment = 'Payment amount cannot be negative.'
    } else if (finalPaymentAmount > calculatedSubtotal) {
      errors.payment = 'Payment amount cannot exceed the sale total.'
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors)
      return
    }

    setSaving(true)
    try {
      const payload = {
        sale_date: saleDate,
        sale_type: effectiveSaleType,
        party_id:  effectiveSaleType === 'walkin' ? null : selectedParty,
        items: saleItems.map(item => ({
          product_id:  item.product_id,
          quantity_kg: Number(item.quantity_kg),
          rate_per_kg: Number(item.rate_per_kg),
        })),
        initial_payment: finalPaymentAmount > 0 ? {
          amount:       finalPaymentAmount,
          method:       paymentMethod,
          external_ref: paymentRef.trim() || undefined,
        } : undefined,
        notes: saleNotes.trim() || undefined,
        idempotency_key: `sale_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      }

      const res = await fetch('/api/sales', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify(payload),
      })

      const d = await res.json()
      if (res.status === 400 || res.status === 409) {
        setFormErrors(d.errors || { general: d.message || d.error || 'Validation error' })
        return
      }
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to create sale.')

      addToast({
        type:    'success',
        message: d.message || `Sale ${d.sale?.sale_number} recorded successfully.`,
      })
      setShowModal(false)
      fetchSales()

      // Automatically open receipt view for convenience
      if (d.sale?.id) {
        openDetailModal(d.sale)
      }
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setSaving(false)
    }
  }

  // ── Open Receipt / Details Drawer ─────────────────────────
  async function openDetailModal(sale) {
    setSelectedSale(sale)
    setShowDetail(true)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/sales/${sale.id}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server returned error ${res.status}`)
      const d = await res.json()
      setDetailData(d)
    } catch (e) {
      addToast({ type: 'error', message: `Could not load sale details: ${e.message}` })
    } finally {
      setDetailLoading(false)
    }
  }

  // ── Handle Void Sale (Admin Only) ─────────────────────────
  function openVoidModal(sale) {
    setVoidModal(sale)
    setVoidReason('')
    setVoidError('')
  }

  async function handleVoidSubmit(e) {
    e.preventDefault()
    if (!voidReason || voidReason.trim().length < 3) {
      setVoidError('Please provide a void reason (at least 3 characters).')
      return
    }

    setVoidSaving(true)
    try {
      const res = await fetch(`/api/sales/${voidModal.id}/void`, {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ void_reason: voidReason.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to void sale.')

      addToast({ type: 'success', message: d.message || 'Sale voided successfully.' })
      setVoidModal(null)
      fetchSales()
      if (showDetail && selectedSale?.id === voidModal.id) {
        openDetailModal(voidModal)
      }
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setVoidSaving(false)
    }
  }

  return (
    <div className="page">
      {/* ── Page Header ────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <h2 className="page-title" id="sales-page-title">Sales Management</h2>
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 700,
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'rgba(5, 150, 105, 0.12)',
                color: '#059669',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Real-time Invoicing & Ledger
            </span>
          </div>
          <p className="page-subtitle">
            Counter cash sales and hotel/party credit billing with immutable historical line rates.
          </p>
        </div>

        <div className="page-actions">
          <button
            className="btn btn-primary"
            id="walkin-sale-btn"
            onClick={openWalkInModal}
            style={{ background: '#059669', borderColor: '#059669' }}
          >
            Fast Walk-In Sale
          </button>
          <button
            className="btn btn-primary"
            id="party-sale-btn"
            onClick={openPartySaleModal}
          >
            + Credit / Party Sale
          </button>
        </div>
      </div>

      {/* ── Guidance Banner ────────────────────────────────────── */}
      <div
        className="card"
        style={{
          background: 'rgba(5, 150, 105, 0.05)',
          borderColor: 'rgba(5, 150, 105, 0.25)',
          padding: '0.85rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.85rem',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><ReceiptText size={22} /></span>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--color-text)' }}>Price Immutability & Financial Math:</strong> Each line item captures the exact rate per kg charged at sale time. Updating daily prices later will <em>never</em> alter historical bills. Immediate payments are atomically recorded in the payment ledger without double-counting.
        </div>
      </div>

      {/* ── Summary Stats ──────────────────────────────────────── */}
      {summary && (
        <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
          <SummaryCard
            label="Total Sales"
            value={summary.total_sales}
            color="var(--color-text)"
          />
          <SummaryCard
            label="Total Revenue"
            value={fmtCurrency(summary.total_revenue)}
            color="var(--color-accent)"
          />
          <SummaryCard
            label="Total Collected"
            value={fmtCurrency(summary.total_collected)}
            color="var(--color-ok)"
          />
          <SummaryCard
            label="Outstanding Due"
            value={fmtCurrency(summary.total_outstanding)}
            color="#b45309"
          />
        </div>
      )}

      {/* ── Search and Filter Bar ──────────────────────────────── */}
      <div className="card" style={{ padding: '1rem 1.25rem' }}>
        <div className="filter-bar" style={{ padding: 0, border: 'none', background: 'transparent' }}>
          <input
            id="sale-search-input"
            type="text"
            className="form-input"
            placeholder="Search Sale #, Customer Name, Party ID…"
            style={{ maxWidth: 280, minWidth: 200 }}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />

          <select
            id="filter-sale-type"
            className="form-input"
            style={{ maxWidth: 180 }}
            value={filterType}
            onChange={(e) => { setFilterType(e.target.value); setPage(1) }}
          >
            <option value="">All Sale Types</option>
            <option value="walkin">Walk-In Retail</option>
            <option value="party_cash">Party (Cash / Paid)</option>
            <option value="party_credit">Party / Regular Credit</option>
          </select>

          <select
            id="filter-payment-status"
            className="form-input"
            style={{ maxWidth: 170 }}
            value={filterPayment}
            onChange={(e) => { setFilterPayment(e.target.value); setPage(1) }}
          >
            <option value="">All Payment States</option>
            <option value="paid">Fully Paid</option>
            <option value="partial">Partially Paid</option>
            <option value="unpaid">Unpaid / Full Credit</option>
          </select>

          <input
            id="filter-sale-from"
            type="date"
            className="form-input"
            style={{ maxWidth: 155 }}
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); setPage(1) }}
            aria-label="From Date"
          />

          <input
            id="filter-sale-to"
            type="date"
            className="form-input"
            style={{ maxWidth: 155 }}
            value={filterTo}
            onChange={(e) => { setFilterTo(e.target.value); setPage(1) }}
            aria-label="To Date"
          />

          {(search || filterType || filterPayment || filterFrom || filterTo) && (
            <button
              className="btn btn-secondary"
              id="clear-sale-filters"
              onClick={() => {
                setSearch('')
                setFilterType('')
                setFilterPayment('')
                setFilterFrom('')
                setFilterTo('')
                setPage(1)
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Sales History Table ────────────────────────────────── */}
      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: '3rem' }}>
            <LoadingState label="Loading sales history…" />
          </div>
        ) : error ? (
          <div style={{ padding: '3rem' }}>
            <ErrorState message={error} onRetry={fetchSales} />
          </div>
        ) : sales.length === 0 ? (
          <div style={{ padding: '3rem' }}>
            <EmptyState
              icon={ReceiptText}
              title="No sales recorded yet"
              message="Record your first counter cash sale or hotel credit bill."
              action={openWalkInModal}
              actionLabel="Fast Walk-In Sale"
            />
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Sale #</th>
                  <th>Date & Time (IST)</th>
                  <th>Customer (Disambiguated)</th>
                  <th>Sale Type</th>
                  <th>Items</th>
                  <th>Total Amount</th>
                  <th>Paid</th>
                  <th>Balance Due</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => {
                  const typeCfg = SALE_TYPE_BADGES[s.sale_type] || SALE_TYPE_BADGES.walkin
                  const isVoided = s.status === 'voided'
                  const isPaid = Number(s.due_amount) <= 0.005
                  return (
                    <tr
                      key={s.id}
                      style={isVoided ? { opacity: 0.6, background: 'rgba(239, 68, 68, 0.03)' } : {}}
                    >
                      {/* Sale Number */}
                      <td>
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontWeight: 700,
                            color: 'var(--color-accent)',
                            fontSize: 'var(--text-sm)',
                          }}
                        >
                          {s.sale_number}
                        </span>
                      </td>

                      {/* Date & Time */}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div>{fmtDateTime(s.sale_timestamp)}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                           By: {s.created_by_name || 'Staff'}
                        </div>
                      </td>

                      {/* Customer with Disambiguation */}
                      <td>
                        {s.party_id ? (
                          <div>
                            <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>
                              {s.party_name}
                            </span>
                            <span
                              style={{
                                marginLeft: 6,
                                fontFamily: 'monospace',
                                fontSize: 'var(--text-xs)',
                                background: 'var(--color-accent-dim)',
                                color: 'var(--color-accent)',
                                padding: '0.1rem 0.4rem',
                                borderRadius: 3,
                              }}
                            >
                              {s.party_code}
                            </span>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 2 }}>
                              <MapPin size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                              {s.party_address || 'No location specified'}
                            </div>
                          </div>
                        ) : (
                          <div style={{ color: 'var(--color-muted)', fontStyle: 'italic', fontSize: 'var(--text-sm)' }}>
                            Walk-In Cash Customer
                          </div>
                        )}
                      </td>

                      {/* Sale Type */}
                      <td>
                        <span
                          style={{
                            fontSize: 'var(--text-xs)',
                            fontWeight: 700,
                            color: typeCfg.color,
                            background: typeCfg.bg,
                            padding: '0.2rem 0.55rem',
                            borderRadius: '999px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {typeCfg.label}
                        </span>
                      </td>

                      {/* Items Count */}
                      <td>
                        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>
                          {s.items_count} item{s.items_count !== 1 ? 's' : ''}
                        </span>
                      </td>

                      {/* Total Amount */}
                      <td>
                        <span style={{ fontWeight: 800, fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
                          {fmtCurrency(s.total_amount)}
                        </span>
                      </td>

                      {/* Paid Amount */}
                      <td>
                        <span style={{ fontWeight: 600, color: 'var(--color-ok)', fontSize: 'var(--text-xs)' }}>
                          {fmtCurrency(s.paid_amount)}
                        </span>
                      </td>

                      {/* Balance Due */}
                      <td>
                        {isPaid ? (
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-ok)', fontWeight: 700 }}>
                            Paid in Full
                          </span>
                        ) : (
                          <span style={{ fontWeight: 800, color: '#b45309', fontSize: 'var(--text-sm)' }}>
                            {fmtCurrency(s.due_amount)}
                          </span>
                        )}
                      </td>

                      {/* Status */}
                      <td>
                        {isVoided ? (
                          <span
                            style={{
                              fontSize: 'var(--text-xs)',
                              fontWeight: 700,
                              color: 'var(--color-error)',
                              background: 'rgba(239, 68, 68, 0.1)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '999px',
                            }}
                            title={`Voided: ${s.void_reason || 'Cancelled'}`}
                          >
                            Voided
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 'var(--text-xs)',
                              fontWeight: 700,
                              color: 'var(--color-ok)',
                              background: 'rgba(16, 185, 129, 0.1)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '999px',
                            }}
                          >
                            Confirmed
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.55rem' }}
                            onClick={() => openDetailModal(s)}
                            id={`view-sale-${s.sale_number}`}
                            title="View receipt and item breakdown"
                          >
                            Receipt
                          </button>
                          {isAdmin && !isVoided && (
                            <button
                              className="btn btn-secondary"
                              style={{
                                fontSize: 'var(--text-xs)',
                                padding: '0.25rem 0.55rem',
                                color: 'var(--color-error)',
                                borderColor: 'rgba(239, 68, 68, 0.3)',
                              }}
                              id={`void-sale-${s.sale_number}`}
                              onClick={() => openVoidModal(s)}
                              title="Authorized void action"
                            >
                              Void
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

      {/* ── Modal: Record Sale (Walk-in or Credit/Party) ────────── */}
      {showModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="modal" style={{ maxWidth: 680 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">
                {saleMode === 'walkin' ? 'Fast Walk-In Counter Sale' : 'Credit / Party Customer Billing'}
              </h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>x</button>
            </div>

            <form onSubmit={handleSubmitSale}>
              {/* Header Info */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem', marginBottom: '1rem' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="sale-date">Sale Date *</label>
                  <input
                    id="sale-date"
                    type="date"
                    className="form-input"
                    value={saleDate}
                    onChange={(e) => setSaleDate(e.target.value)}
                    required
                  />
                </div>

                {saleMode === 'credit_party' ? (
                  <div className="form-group">
                    <label className="form-label" htmlFor="sale-party-type">Billing Type *</label>
                    <select
                      id="sale-party-type"
                      className="form-input"
                      value={partySaleType}
                      onChange={(e) => setPartySaleType(e.target.value)}
                    >
                      <option value="party_credit">Credit Sale (Tracked on Ledger)</option>
                      <option value="party_cash">Immediate Full Cash / UPI</option>
                    </select>
                  </div>
                ) : (
                  <div className="form-group">
                    <label className="form-label">Customer Profile</label>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', paddingTop: '0.5rem' }}>
                      Retail Walk-In (No account required)
                    </div>
                  </div>
                )}
              </div>

              {/* Customer Selection for Credit / Party Sale */}
              {saleMode === 'credit_party' && (
                <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                  <label className="form-label" htmlFor="select-customer">Select Customer Account *</label>
                  <select
                    id="select-customer"
                    className="form-input"
                    value={selectedParty}
                    onChange={(e) => handlePartySelect(e.target.value)}
                    required
                  >
                    <option value="">Select a customer…</option>
                    {parties.map((p) => (
                      <option key={p.id} value={p.id}>
                        [{p.party_code}] {p.name} — {p.address || 'Location not specified'} {p.credit_enabled ? '(Credit OK)' : '(Cash Only)'}
                      </option>
                    ))}
                  </select>
                  {formErrors.party_id && <span className="form-error">{formErrors.party_id}</span>}
                </div>
              )}

              {/* Line Items Section */}
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <label className="form-label" style={{ margin: 0 }}>Sale Line Items *</label>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 'var(--text-xs)', padding: '0.2rem 0.6rem' }}
                    onClick={addItemRow}
                  >
                    + Add Product
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {saleItems.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr 1fr 1fr auto',
                        gap: '0.5rem',
                        alignItems: 'center',
                        background: 'var(--color-surface)',
                        padding: '0.5rem 0.75rem',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      {/* Product select */}
                      <div>
                        <select
                          className="form-input"
                          style={{ fontSize: 'var(--text-xs)', padding: '0.35rem 0.5rem' }}
                          value={item.product_id}
                          onChange={(e) => handleItemChange(idx, 'product_id', e.target.value)}
                          required
                        >
                          <option value="">Select product…</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.category})
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Quantity in kg */}
                      <div>
                        <input
                          type="number"
                          step="0.001"
                          min="0.001"
                          className="form-input"
                          style={{ fontSize: 'var(--text-xs)', padding: '0.35rem 0.5rem' }}
                          placeholder="kg (e.g. 2.5)"
                          value={item.quantity_kg}
                          onChange={(e) => handleItemChange(idx, 'quantity_kg', e.target.value)}
                          required
                        />
                      </div>

                      {/* Actual Rate per kg */}
                      <div>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          className="form-input"
                          style={{ fontSize: 'var(--text-xs)', padding: '0.35rem 0.5rem' }}
                          placeholder="₹ / kg"
                          value={item.rate_per_kg}
                          onChange={(e) => handleItemChange(idx, 'rate_per_kg', e.target.value)}
                          required
                        />
                      </div>

                      {/* Line total preview */}
                      <div style={{ textAlign: 'right', fontWeight: 700, fontSize: 'var(--text-xs)', color: 'var(--color-text)' }}>
                        {fmtCurrency(item.line_total)}
                      </div>

                      {/* Delete button */}
                      <div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.25rem 0.45rem', fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}
                          onClick={() => removeItemRow(idx)}
                          disabled={saleItems.length <= 1}
                          title="Remove item"
                        >
                          x
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {formErrors.items && <span className="form-error">{formErrors.items}</span>}
              </div>

              {/* Subtotal Banner */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.75rem 1rem',
                  marginBottom: '1rem',
                }}
              >
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Sale Subtotal</span>
                <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--color-text)' }}>
                  {fmtCurrency(calculatedSubtotal)}
                </span>
              </div>

              {/* Payment Section */}
              <div
                style={{
                  background: 'rgba(5, 150, 105, 0.04)',
                  border: '1px solid rgba(5, 150, 105, 0.2)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.85rem 1rem',
                  marginBottom: '1rem',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: '#059669', marginBottom: '0.5rem' }}>
                  Immediate Payment Collection
                </div>

                {saleMode === 'credit_party' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
                    <div className="form-group">
                      <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Payment Option</label>
                      <select
                        className="form-input"
                        value={paymentOption}
                        onChange={(e) => setPaymentOption(e.target.value)}
                      >
                        <option value="none">Full Credit (₹0 Paid Immediately)</option>
                        <option value="partial">Partial Payment (Enter Amount)</option>
                        <option value="full">Full Payment ({fmtCurrency(calculatedSubtotal)})</option>
                      </select>
                    </div>

                    {paymentOption === 'partial' && (
                      <div className="form-group">
                        <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Amount Paid Now (₹) *</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max={calculatedSubtotal}
                          className="form-input"
                          placeholder="e.g. 4000.00"
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                          required
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
                    <div className="form-group">
                      <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Payment Mode</label>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--color-ok)', paddingTop: 4 }}>
                        Paid at Counter ({fmtCurrency(calculatedSubtotal)})
                      </div>
                    </div>
                  </div>
                )}

                {calculatedPaid > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                    <div className="form-group">
                      <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Payment Method</label>
                      <select
                        className="form-input"
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                      >
                        <option value="cash">Cash</option>
                        <option value="upi">UPI (GPay / PhonePe / Paytm)</option>
                        <option value="bank">Bank Transfer</option>
                        <option value="other">Other</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Payment Ref / Txn ID (optional)</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. UPI Ref #123456"
                        value={paymentRef}
                        onChange={(e) => setPaymentRef(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {/* Balance breakdown */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(5, 150, 105, 0.2)', fontSize: 'var(--text-xs)' }}>
                  <span>Amount Paid Now: <strong style={{ color: 'var(--color-ok)' }}>{fmtCurrency(calculatedPaid)}</strong></span>
                  <span>Remaining Due on Bill: <strong style={{ color: calculatedDue > 0 ? '#b45309' : 'var(--color-text)' }}>{fmtCurrency(calculatedDue)}</strong></span>
                </div>
              </div>

              {/* Notes */}
              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label" htmlFor="sale-notes">Bill Notes (optional)</label>
                <textarea
                  id="sale-notes"
                  className="form-input"
                  rows={2}
                  placeholder="Optional remarks or customer instructions"
                  value={saleNotes}
                  onChange={(e) => setSaleNotes(e.target.value)}
                />
              </div>

              {formErrors.general && (
                <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-sm)', marginBottom: '1rem' }}>
                  {formErrors.general}
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  id="submit-sale-btn"
                  disabled={saving || calculatedSubtotal <= 0}
                >
                  {saving ? 'Creating Sale…' : `Confirm & Record Bill (${fmtCurrency(calculatedSubtotal)})`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Receipt / Sale Details Drawer ────────────────── */}
      {showDetail && selectedSale && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowDetail(false) }}>
          <div className="modal" style={{ maxWidth: 640 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">
                Tax Invoice / Sale Receipt — {detailData?.sale?.sale_number || selectedSale?.sale_number || ''}
              </h3>
              <button className="modal-close" onClick={() => setShowDetail(false)}>x</button>
            </div>

            {detailLoading ? (
              <div style={{ padding: '2rem' }}>
                <LoadingState label="Loading receipt details…" />
              </div>
            ) : !detailData?.sale ? (
              <div style={{ padding: '1rem', color: 'var(--color-error)' }}>
                Could not load sale details.
              </div>
            ) : (
              <div>
                {/* Shop Receipt Header */}
                <div style={{ textAlign: 'center', paddingBottom: '1rem', borderBottom: '1px dashed var(--color-border)', marginBottom: '1rem' }}>
                  <div style={{ fontWeight: 800, fontSize: 'var(--text-lg)', color: 'var(--color-text)' }}>
                    BISMILLAH CHICKEN SHOP
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                    Fresh & Quality Chicken · Daily Wholesale & Retail
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-accent)', marginTop: 4 }}>
                    Invoice #{detailData.sale.sale_number} · Date: {fmtDateTime(detailData.sale.sale_timestamp)}
                  </div>
                </div>

                {/* Customer Details */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem', fontSize: 'var(--text-xs)' }}>
                  <div>
                    <span style={{ color: 'var(--color-muted)' }}>Customer: </span>
                    <strong>{detailData.sale.party_name || 'Walk-In Customer'}</strong>
                    {detailData.sale.party_code && (
                      <span style={{ marginLeft: 4, fontFamily: 'monospace' }}>({detailData.sale.party_code})</span>
                    )}
                    {detailData.sale.party_address && (
                      <div style={{ color: 'var(--color-muted)', marginTop: 2 }}>
                        <MapPin size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        {detailData.sale.party_address}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--color-muted)' }}>Billing Type: </span>
                    <strong style={{ textTransform: 'uppercase' }}>{(detailData.sale.sale_type || 'walkin').replace('_', ' ')}</strong>
                    <div style={{ color: 'var(--color-muted)', marginTop: 2 }}>
                      Cashier: {detailData.sale.created_by_name || 'Staff'}
                    </div>
                  </div>
                </div>

                {/* Line Items Table */}
                <div style={{ marginBottom: '1rem', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}>
                  <table style={{ margin: 0 }}>
                    <thead>
                      <tr style={{ background: 'var(--color-surface)' }}>
                        <th style={{ fontSize: 'var(--text-xs)' }}>Item</th>
                        <th style={{ fontSize: 'var(--text-xs)', textAlign: 'right' }}>Weight</th>
                        <th style={{ fontSize: 'var(--text-xs)', textAlign: 'right' }}>Rate / kg</th>
                        <th style={{ fontSize: 'var(--text-xs)', textAlign: 'right' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.items?.map((item) => (
                        <tr key={item.id}>
                          <td style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>
                            {item.product_name}
                          </td>
                          <td style={{ fontSize: 'var(--text-xs)', textAlign: 'right', fontFamily: 'monospace' }}>
                            {fmtKg(item.quantity_kg)}
                          </td>
                          <td style={{ fontSize: 'var(--text-xs)', textAlign: 'right', fontFamily: 'monospace' }}>
                            {fmtCurrency(item.rate_per_kg)}
                          </td>
                          <td style={{ fontSize: 'var(--text-xs)', textAlign: 'right', fontWeight: 700 }}>
                            {fmtCurrency(item.line_total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals Breakdown */}
                <div style={{ background: 'var(--color-surface)', padding: '0.85rem 1rem', borderRadius: 'var(--radius-sm)', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 'var(--text-sm)' }}>
                    <span>Gross Total:</span>
                    <strong>{fmtCurrency(detailData.sale.total_amount)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 'var(--text-sm)', color: 'var(--color-ok)' }}>
                    <span>Amount Paid:</span>
                    <strong>{fmtCurrency(detailData.sale.paid_amount)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px dashed var(--color-border)', fontSize: 'var(--text-base)', fontWeight: 800 }}>
                    <span>Balance Due:</span>
                    <span style={{ color: Number(detailData.sale.due_amount) > 0 ? '#b45309' : 'var(--color-ok)' }}>
                      {fmtCurrency(detailData.sale.due_amount)}
                    </span>
                  </div>
                </div>

                {/* Payments Applied */}
                {detailData.payments && detailData.payments.length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-muted)', marginBottom: 4 }}>
                      Payments Received & Applied
                    </div>
                    {detailData.payments.map((p) => (
                      <div
                        key={p.allocation_id}
                        style={{
                          fontSize: 'var(--text-xs)',
                          padding: '0.4rem 0.6rem',
                          background: 'rgba(16, 185, 129, 0.05)',
                          border: '1px solid rgba(16, 185, 129, 0.2)',
                          borderRadius: 'var(--radius-sm)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginBottom: 4,
                        }}
                      >
                        <span>
                          <strong>{fmtCurrency(p.allocated_amount)}</strong> via {(p.method || 'cash').toUpperCase()}
                          {p.external_ref ? ` (${p.external_ref})` : ''}
                        </span>
                        <span style={{ color: 'var(--color-muted)' }}>{fmtDate(p.payment_date || p.allocated_at)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Void status banner */}
                {detailData.sale.status === 'voided' && (
                  <div
                    style={{
                      padding: '0.75rem',
                      background: 'rgba(239, 68, 68, 0.08)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--color-error)',
                      fontSize: 'var(--text-xs)',
                      marginBottom: '1rem',
                    }}
                  >
                    <strong>VOIDED INVOICE:</strong> {detailData.sale.void_reason || 'Cancelled'}
                    <div style={{ color: 'var(--color-muted)', marginTop: 2 }}>
                      Voided on {fmtDateTime(detailData.sale.voided_at)} by {detailData.sale.voided_by_name || 'Admin'}
                    </div>
                  </div>
                )}

                <div className="modal-footer" style={{ marginTop: '1.25rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowDetail(false)}>
                    Close
                  </button>
                  {isAdmin && detailData.sale.status !== 'voided' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ color: 'var(--color-error)', borderColor: 'rgba(239, 68, 68, 0.4)' }}
                      onClick={() => openVoidModal(detailData.sale)}
                    >
                      Void Sale
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modal: Authorized Void Sale (Admin Only) ────────────── */}
      {voidModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setVoidModal(null) }}>
          <div className="modal" style={{ maxWidth: 460 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title" style={{ color: 'var(--color-error)' }}>
                Authorized Void — {voidModal.sale_number}
              </h3>
              <button className="modal-close" onClick={() => setVoidModal(null)}>x</button>
            </div>

            <form onSubmit={handleVoidSubmit}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)', lineHeight: 1.6, marginBottom: '1rem' }}>
                Are you sure you want to void sale <strong>{voidModal.sale_number}</strong> ({fmtCurrency(voidModal.total_amount)})?
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4 }}>
                  All payment allocations applied to this sale will also be cancelled. This action is permanently logged in the audit trail.
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label" htmlFor="void-reason">Void Reason * (Mandatory for audit trail)</label>
                <textarea
                  id="void-reason"
                  className="form-input"
                  rows={2}
                  placeholder="e.g. Cashier error in product weight or customer returned order"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  required
                  autoFocus
                />
                {voidError && <span className="form-error">{voidError}</span>}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setVoidModal(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)' }}
                  id="confirm-void-sale-btn"
                  disabled={voidSaving}
                >
                  {voidSaving ? 'Voiding Sale…' : 'Confirm Void'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, color }) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: `1px solid ${color}33`,
        borderRadius: 'var(--radius)',
        padding: '0.9rem 1.25rem',
        minWidth: 180,
        flex: 1,
      }}
    >
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color }}>
        {value}
      </div>
    </div>
  )
}
