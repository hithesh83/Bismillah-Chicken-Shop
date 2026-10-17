/**
 * client/src/pages/CustomersPage.jsx
 *
 * Phase 08 — Customer Management (Hotels, Parties, and Regular Credit Customers)
 *
 * Core Business Rules Enforced in UI:
 *   • Duplicate Names vs. Unique Party IDs:
 *       - Multiple customers can share identical names (e.g. two "Taj Hotel"s).
 *       - party_code is strictly unique and highlighted everywhere.
 *   • Disambiguation in Display & Selection:
 *       - Party ID, Customer Name, and Address/Location are displayed together
 *         in all table rows and dropdowns so identically-named customers are never confused.
 *   • Auditable Opening Balances:
 *       - Recorded as ledger adjustment records, never an untracked mutable field.
 *   • Safe Deactivation:
 *       - Inactive accounts are deactivated (is_active=FALSE), never deleted,
 *         preserving all ledger and transaction history.
 *   • Role Permissions:
 *       - Staff + Admin can create and edit customer profiles.
 *       - Admin only can toggle active/inactive status.
 */

import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState, StatusBadge } from '../components/ui/UIStates.jsx'
import { UsersRound, MapPin } from '../components/ui/Icons.jsx'
import './pages.css'

// ── Currency and Format Helpers ─────────────────────────────
function fmtCurrency(v) {
  if (v === null || v === undefined) return '₹0.00'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(v))
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

const TYPE_CONFIG = {
  hotel:  { label: 'Hotel / Restaurant', badgeCls: 'badge--hotel',  color: '#2563eb', bg: 'rgba(37, 99, 235, 0.1)' },
  party:  { label: 'Party / Event',       badgeCls: 'badge--party',  color: '#7c3aed', bg: 'rgba(124, 58, 237, 0.1)' },
  retail: { label: 'Regular Credit',      badgeCls: 'badge--retail', color: '#059669', bg: 'rgba(5, 150, 105, 0.1)' },
}

export default function CustomersPage({ user, addToast }) {
  const isAdmin = user?.role === 'admin'

  // ── State: List & summary ─────────────────────────────────
  const [customers,  setCustomers]  = useState([])
  const [summary,    setSummary]    = useState(null)
  const [total,      setTotal]      = useState(0)
  const [page,       setPage]       = useState(1)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  // ── State: Filters ────────────────────────────────────────
  const [search,        setSearch]        = useState('')
  const [filterType,    setFilterType]    = useState('')
  const [filterStatus,  setFilterStatus]  = useState('all')
  const [filterCredit,  setFilterCredit]  = useState('')

  // ── State: Create / Edit Modal ────────────────────────────
  const [showModal,    setShowModal]    = useState(false)
  const [editingParty, setEditingParty] = useState(null) // null = Create, object = Edit
  const [formData,     setFormData]     = useState({
    name:                   '',
    party_code:             '',
    phone:                  '',
    address:                '',
    party_type:             'hotel',
    credit_enabled:         false,
    opening_balance:        '',
    opening_balance_reason: '',
  })
  const [formErrors,   setFormErrors]   = useState({})
  const [saving,       setSaving]       = useState(false)

  // ── State: Details & Audit Drawer ─────────────────────────
  const [showDetail,     setShowDetail]     = useState(false)
  const [selectedParty,  setSelectedParty]  = useState(null)
  const [detailData,     setDetailData]     = useState(null)
  const [detailLoading,  setDetailLoading]  = useState(false)

  // ── State: Deactivation Confirmation Modal ────────────────
  const [statusModal,   setStatusModal]   = useState(null) // { party, newStatus }
  const [statusSaving,  setStatusSaving]  = useState(false)

  // ── Fetch Customers List ──────────────────────────────────
  const fetchCustomers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page,
        limit: 50,
      })
      if (search.trim())        params.set('search', search.trim())
      if (filterType)           params.set('party_type', filterType)
      if (filterStatus !== 'all') params.set('status', filterStatus)
      if (filterCredit)         params.set('credit_enabled', filterCredit)

      const res = await fetch(`/api/customers?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server returned error ${res.status}`)
      const d = await res.json()
      setCustomers(d.customers || [])
      setTotal(d.total || 0)
      setSummary(d.summary || null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [page, search, filterType, filterStatus, filterCredit])

  useEffect(() => {
    fetchCustomers()
  }, [fetchCustomers])

  // ── Modal Open: Create New Customer ───────────────────────
  function openCreateModal() {
    setEditingParty(null)
    setFormData({
      name:                   '',
      party_code:             '',
      phone:                  '',
      address:                '',
      party_type:             'hotel',
      credit_enabled:         false,
      opening_balance:        '',
      opening_balance_reason: '',
    })
    setFormErrors({})
    setShowModal(true)
  }

  // ── Modal Open: Edit Customer ─────────────────────────────
  function openEditModal(party) {
    setEditingParty(party)
    setFormData({
      name:                   party.name || '',
      party_code:             party.party_code || '',
      phone:                  party.phone || '',
      address:                party.address || '',
      party_type:             party.party_type || 'hotel',
      credit_enabled:         Boolean(party.credit_enabled),
      opening_balance:        party.opening_balance > 0 ? String(party.opening_balance) : '',
      opening_balance_reason: '',
    })
    setFormErrors({})
    setShowModal(true)
  }

  // ── Handle Save Customer (Create or Edit) ─────────────────
  async function handleFormSubmit(e) {
    e.preventDefault()
    setFormErrors({})

    const errors = {}
    if (!formData.name || formData.name.trim().length < 2) {
      errors.name = 'Customer name is required (at least 2 characters).'
    }
    if (formData.phone && !/^[0-9+\-\s()]{7,15}$/.test(formData.phone.trim())) {
      errors.phone = 'Please enter a valid phone number (7 to 15 digits).'
    }
    if (formData.opening_balance && (isNaN(Number(formData.opening_balance)) || Number(formData.opening_balance) < 0)) {
      errors.opening_balance = 'Opening balance must be zero or a positive amount.'
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors)
      return
    }

    setSaving(true)
    try {
      const isEdit = Boolean(editingParty)
      const url    = isEdit ? `/api/customers/${editingParty.id}` : '/api/customers'
      const method = isEdit ? 'PUT' : 'POST'

      const payload = {
        name:                   formData.name.trim(),
        party_code:             formData.party_code.trim() || undefined,
        phone:                  formData.phone.trim() || undefined,
        address:                formData.address.trim() || undefined,
        party_type:             formData.party_type,
        credit_enabled:         formData.credit_enabled,
        opening_balance:        formData.opening_balance !== '' ? Number(formData.opening_balance) : undefined,
        opening_balance_reason: formData.opening_balance_reason?.trim() || undefined,
      }

      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify(payload),
      })

      const d = await res.json()
      if (res.status === 400) {
        setFormErrors(d.errors || { general: d.error || 'Validation error' })
        return
      }
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to save customer.')

      addToast({ type: 'success', message: d.message || 'Customer saved successfully.' })
      setShowModal(false)
      fetchCustomers()
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setSaving(false)
    }
  }

  // ── Handle Toggle Status (Deactivate / Activate) ──────────
  async function handleStatusChangeConfirm() {
    if (!statusModal) return
    const { party, newStatus } = statusModal

    setStatusSaving(true)
    try {
      const res = await fetch(`/api/customers/${party.id}/status`, {
        method:      'PATCH',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ is_active: newStatus }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to update customer status.')

      addToast({
        type:    'success',
        message: d.message || `Customer ${party.name} is now ${newStatus ? 'active' : 'inactive'}.`,
      })
      setStatusModal(null)
      fetchCustomers()
    } catch (e) {
      addToast({ type: 'error', message: e.message })
    } finally {
      setStatusSaving(false)
    }
  }

  // ── Open Detail & Audit Modal ─────────────────────────────
  async function openDetailModal(party) {
    setSelectedParty(party)
    setShowDetail(true)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/customers/${party.id}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Server returned error ${res.status}`)
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
            <h2 className="page-title" id="customers-page-title">Customer Management</h2>
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 700,
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'rgba(16, 185, 129, 0.12)',
                color: '#059669',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Auditable Ledger Accounts
            </span>
          </div>
          <p className="page-subtitle">
            Hotels, party buyers, and regular credit customer profiles with auditable opening balances.
          </p>
        </div>

        <div className="page-actions">
          <button
            className="btn btn-primary"
            id="new-customer-btn"
            onClick={openCreateModal}
          >
            + New Customer
          </button>
        </div>
      </div>

      {/* ── Disambiguation & Walk-In Notice ─────────────────────── */}
      <div
        className="card"
        style={{
          background: 'rgba(37, 99, 235, 0.05)',
          borderColor: 'rgba(37, 99, 235, 0.25)',
          padding: '0.85rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.85rem',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><UsersRound size={22} /></span>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--color-text)' }}>Disambiguation & Cash Customer Rules:</strong> Multiple customers may share identical business names (e.g. multiple <em>Taj Hotel</em>s). The <strong>Party ID</strong> and <strong>Address/Location</strong> are displayed together to eliminate confusion. Walk-in cash customers do not require a profile.
        </div>
      </div>

      {/* ── Summary Stats ──────────────────────────────────────── */}
      {summary && (
        <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
          <SummaryCard
            label="Total Accounts"
            value={summary.total_customers}
            color="var(--color-text)"
          />
          <SummaryCard
            label="Active Accounts"
            value={summary.active_customers}
            color="var(--color-ok)"
          />
          <SummaryCard
            label="Credit Allowed"
            value={summary.credit_enabled_customers}
            color="var(--color-accent)"
          />
          <SummaryCard
            label="Total Opening Balances"
            value={fmtCurrency(summary.total_opening_balance)}
            color="#b45309"
          />
        </div>
      )}

      {/* ── Search and Filter Bar ──────────────────────────────── */}
      <div className="card" style={{ padding: '1rem 1.25rem' }}>
        <div className="filter-bar" style={{ padding: 0, border: 'none', background: 'transparent' }}>
          {/* Text search by Name, Party ID, or Phone */}
          <input
            id="customer-search-input"
            type="text"
            className="form-input"
            placeholder="Search Name, Party ID, Phone…"
            style={{ maxWidth: 280, minWidth: 200 }}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />

          {/* Customer Type filter */}
          <select
            id="filter-customer-type"
            className="form-input"
            style={{ maxWidth: 190 }}
            value={filterType}
            onChange={(e) => { setFilterType(e.target.value); setPage(1) }}
          >
            <option value="">All Customer Types</option>
            <option value="hotel">Hotels / Restaurants</option>
            <option value="party">Party / Events</option>
            <option value="retail">Regular Credit Customers</option>
          </select>

          {/* Active / Inactive Status filter */}
          <select
            id="filter-customer-status"
            className="form-input"
            style={{ maxWidth: 150 }}
            value={filterStatus}
            onChange={(e) => { setFilterStatus(e.target.value); setPage(1) }}
          >
            <option value="all">All Statuses</option>
            <option value="active">Active Only</option>
            <option value="inactive">Inactive Only</option>
          </select>

          {/* Credit Allowed filter */}
          <select
            id="filter-customer-credit"
            className="form-input"
            style={{ maxWidth: 160 }}
            value={filterCredit}
            onChange={(e) => { setFilterCredit(e.target.value); setPage(1) }}
          >
            <option value="">Credit: All</option>
            <option value="true">Credit Enabled</option>
            <option value="false">Credit Disabled</option>
          </select>

          {(search || filterType || filterStatus !== 'all' || filterCredit) && (
            <button
              className="btn btn-secondary"
              id="clear-customer-filters"
              onClick={() => {
                setSearch('')
                setFilterType('')
                setFilterStatus('all')
                setFilterCredit('')
                setPage(1)
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Customers Table ────────────────────────────────────── */}
      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: '3rem' }}>
            <LoadingState label="Loading customer accounts…" />
          </div>
        ) : error ? (
          <div style={{ padding: '3rem' }}>
            <ErrorState message={error} onRetry={fetchCustomers} />
          </div>
        ) : customers.length === 0 ? (
          <div style={{ padding: '3rem' }}>
            <EmptyState
              icon={UsersRound}
              title="No customer accounts found"
              message="No profiles match your search criteria. Create a customer to start tracking ledger accounts."
              action={openCreateModal}
              actionLabel="+ Add First Customer"
            />
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Party ID</th>
                  <th>Customer Name & Location (Disambiguation)</th>
                  <th>Customer Type</th>
                  <th>Phone</th>
                  <th>Credit Status</th>
                  <th>Opening Balance</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((party) => {
                  const typeCfg = TYPE_CONFIG[party.party_type] || TYPE_CONFIG.hotel
                  return (
                    <tr
                      key={party.id}
                      style={!party.is_active ? { opacity: 0.6, background: 'rgba(239, 68, 68, 0.03)' } : {}}
                    >
                      {/* Party ID */}
                      <td>
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontWeight: 700,
                            color: 'var(--color-accent)',
                            fontSize: 'var(--text-sm)',
                            background: 'var(--color-accent-dim)',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '4px',
                          }}
                        >
                          {party.party_code}
                        </span>
                      </td>

                      {/* Name & Address for Disambiguation */}
                      <td>
                        <div>
                          <span style={{ fontWeight: 700, color: 'var(--color-text)', fontSize: 'var(--text-sm)' }}>
                            {party.name}
                          </span>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 2 }}>
                            <MapPin size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                            {party.address || 'Location not specified'}
                          </div>
                        </div>
                      </td>

                      {/* Customer Type */}
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

                      {/* Phone */}
                      <td>
                        <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'monospace' }}>
                          {party.phone || '—'}
                        </span>
                      </td>

                      {/* Credit Status */}
                      <td>
                        {party.credit_enabled ? (
                          <span
                            style={{
                              fontSize: 'var(--text-xs)',
                              fontWeight: 700,
                              color: 'var(--color-ok)',
                              background: 'rgba(16, 185, 129, 0.12)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '999px',
                            }}
                          >
                            Credit Allowed
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 'var(--text-xs)',
                              color: 'var(--color-muted)',
                              background: 'rgba(100, 116, 139, 0.1)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '999px',
                            }}
                          >
                            Cash Only
                          </span>
                        )}
                      </td>

                      {/* Opening Balance */}
                      <td>
                        <span style={{ fontWeight: 700, fontSize: 'var(--text-sm)', color: party.opening_balance > 0 ? '#b45309' : 'var(--color-text)' }}>
                          {fmtCurrency(party.opening_balance)}
                        </span>
                      </td>

                      {/* Active / Inactive Status */}
                      <td>
                        <StatusBadge status={party.is_active ? 'active' : 'inactive'} />
                      </td>

                      {/* Actions */}
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.55rem' }}
                            onClick={() => openDetailModal(party)}
                            id={`view-party-${party.party_code}`}
                            title="View audit trail and ledger balance"
                          >
                            Details
                          </button>
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 'var(--text-xs)', padding: '0.25rem 0.55rem' }}
                            onClick={() => openEditModal(party)}
                            id={`edit-party-${party.party_code}`}
                          >
                            Edit
                          </button>
                          {isAdmin && (
                            <button
                              className="btn btn-secondary"
                              style={{
                                fontSize: 'var(--text-xs)',
                                padding: '0.25rem 0.55rem',
                                color: party.is_active ? 'var(--color-error)' : 'var(--color-ok)',
                                borderColor: party.is_active ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)',
                              }}
                              id={`toggle-status-${party.party_code}`}
                              onClick={() => setStatusModal({ party, newStatus: !party.is_active })}
                            >
                              {party.is_active ? 'Deactivate' : 'Activate'}
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

      {/* ── Modal: Create / Edit Customer Profile ──────────────── */}
      {showModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="modal" style={{ maxWidth: 540 }} role="dialog" aria-modal="true" aria-labelledby="customer-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="customer-modal-title">
                {editingParty ? `Edit Customer — ${editingParty.party_code}` : 'Create New Customer Account'}
              </h3>
              <button className="modal-close" onClick={() => setShowModal(false)} aria-label="Close">x</button>
            </div>

            <form onSubmit={handleFormSubmit}>
              {/* Customer Name */}
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label className="form-label" htmlFor="input-customer-name">Customer / Business Name *</label>
                <input
                  id="input-customer-name"
                  type="text"
                  className="form-input"
                  placeholder="e.g. Taj Hotel"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  autoFocus
                />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 3 }}>
                  Multiple customers may share identical business names. Party ID distinguishes them.
                </span>
                {formErrors.name && <span className="form-error">{formErrors.name}</span>}
              </div>

              {/* Party ID & Type Row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem', marginBottom: '1rem' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="input-party-code">Party ID (Unique Code)</label>
                  <input
                    id="input-party-code"
                    type="text"
                    className="form-input"
                    placeholder="e.g. HTL-001 (or auto-assigned)"
                    value={formData.party_code}
                    onChange={(e) => setFormData({ ...formData, party_code: e.target.value.toUpperCase() })}
                  />
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 3 }}>
                    Leave blank to auto-generate (e.g. PTY-00001).
                  </span>
                  {formErrors.party_code && <span className="form-error">{formErrors.party_code}</span>}
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="input-party-type">Customer Type *</label>
                  <select
                    id="input-party-type"
                    className="form-input"
                    value={formData.party_type}
                    onChange={(e) => setFormData({ ...formData, party_type: e.target.value })}
                  >
                    <option value="hotel">Hotel / Restaurant</option>
                    <option value="party">Party / Event Buyer</option>
                    <option value="retail">Regular Credit Customer</option>
                  </select>
                  {formErrors.party_type && <span className="form-error">{formErrors.party_type}</span>}
                </div>
              </div>

              {/* Phone & Address */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem', marginBottom: '1rem' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="input-customer-phone">Phone Number</label>
                  <input
                    id="input-customer-phone"
                    type="tel"
                    className="form-input"
                    placeholder="e.g. 9876543210"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  />
                  {formErrors.phone && <span className="form-error">{formErrors.phone}</span>}
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="input-customer-address">Address / Location</label>
                  <input
                    id="input-customer-address"
                    type="text"
                    className="form-input"
                    placeholder="e.g. Market Road, Shop #4"
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  />
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 3 }}>
                    Used in dropdowns to disambiguate identical names.
                  </span>
                  {formErrors.address && <span className="form-error">{formErrors.address}</span>}
                </div>
              </div>

              {/* Credit Enabled Checkbox */}
              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
                  <input
                    id="input-credit-enabled"
                    type="checkbox"
                    checked={formData.credit_enabled}
                    onChange={(e) => setFormData({ ...formData, credit_enabled: e.target.checked })}
                    style={{ width: 16, height: 16 }}
                  />
                  <strong style={{ color: 'var(--color-text)' }}>Enable Credit Sales</strong>
                  <span style={{ color: 'var(--color-muted)', fontSize: 'var(--text-xs)' }}>
                    (Allows billing credit sales to this party account)
                  </span>
                </label>
              </div>

              {/* Opening Balance (Auditable Ledger Field) */}
              <div
                style={{
                  background: 'var(--color-surface)',
                  border: '1px dashed var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '1rem',
                  marginBottom: '1.25rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                  <label className="form-label" htmlFor="input-opening-balance" style={{ margin: 0 }}>
                    Opening Balance (₹)
                  </label>
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: '#b45309' }}>
                    Auditable Ledger Entry
                  </span>
                </div>
                <input
                  id="input-opening-balance"
                  type="number"
                  step="0.01"
                  min="0"
                  className="form-input"
                  placeholder="0.00"
                  value={formData.opening_balance}
                  onChange={(e) => setFormData({ ...formData, opening_balance: e.target.value })}
                />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: 4, display: 'block' }}>
                  Amount the customer owes before system adoption. Recorded in <code>account_adjustments</code>.
                </span>
                {formErrors.opening_balance && <span className="form-error">{formErrors.opening_balance}</span>}

                {editingParty && (
                  <div style={{ marginTop: '0.65rem' }}>
                    <label className="form-label" htmlFor="input-opening-reason" style={{ fontSize: 'var(--text-xs)' }}>
                      Reason for opening balance change
                    </label>
                    <input
                      id="input-opening-reason"
                      type="text"
                      className="form-input"
                      placeholder="e.g. Corrected ledger opening figure"
                      value={formData.opening_balance_reason}
                      onChange={(e) => setFormData({ ...formData, opening_balance_reason: e.target.value })}
                    />
                  </div>
                )}
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
                  id="submit-customer-btn"
                  disabled={saving}
                >
                  {saving ? 'Saving Profile…' : editingParty ? 'Save Changes' : 'Create Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Safe Deactivation Confirmation (Admin Only) ──── */}
      {statusModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setStatusModal(null) }}>
          <div className="modal" style={{ maxWidth: 460 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title" style={{ color: statusModal.newStatus ? 'var(--color-ok)' : 'var(--color-error)' }}>
                {statusModal.newStatus ? 'Activate Account' : 'Deactivate Customer Account'}
              </h3>
              <button className="modal-close" onClick={() => setStatusModal(null)}>x</button>
            </div>

            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)', lineHeight: 1.6, marginBottom: '1.25rem' }}>
              Are you sure you want to {statusModal.newStatus ? 'activate' : 'deactivate'} <strong>{statusModal.party.name}</strong> ({statusModal.party.party_code})?
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)', marginTop: '0.6rem' }}>
                <em>Audit Rule:</em> Customer records are never hard-deleted. Historical sales, payments, and opening ledger entries are preserved.
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setStatusModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{
                  background: statusModal.newStatus ? 'var(--color-ok)' : 'var(--color-error)',
                  borderColor: statusModal.newStatus ? 'var(--color-ok)' : 'var(--color-error)',
                }}
                id="confirm-toggle-status"
                disabled={statusSaving}
                onClick={handleStatusChangeConfirm}
              >
                {statusSaving ? 'Updating…' : statusModal.newStatus ? 'Activate Customer' : 'Confirm Deactivation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Details & Audit Drawer ───────────────────────── */}
      {showDetail && selectedParty && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowDetail(false) }}>
          <div className="modal" style={{ maxWidth: 640 }} role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">
                Customer Details & Ledger Audit — {selectedParty.name}
              </h3>
              <button className="modal-close" onClick={() => setShowDetail(false)}>x</button>
            </div>

            {detailLoading ? (
              <div style={{ padding: '2rem' }}>
                <LoadingState label="Loading audit details…" />
              </div>
            ) : !detailData?.customer ? (
              <div style={{ padding: '1rem', color: 'var(--color-error)' }}>
                Could not load customer details.
              </div>
            ) : (
              <div>
                {/* Profile Overview */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Party ID</div>
                    <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 'var(--text-base)', color: 'var(--color-accent)' }}>
                      {detailData.customer.party_code}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Customer Type</div>
                    <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', textTransform: 'capitalize' }}>
                      {detailData.customer.party_type}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Phone</div>
                    <div style={{ fontSize: 'var(--text-sm)' }}>{detailData.customer.phone || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Address / Location</div>
                    <div style={{ fontSize: 'var(--text-sm)' }}>{detailData.customer.address || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Current Opening Balance</div>
                    <div style={{ fontWeight: 800, fontSize: 'var(--text-base)', color: '#b45309' }}>
                      {fmtCurrency(detailData.customer.opening_balance)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>Account Created</div>
                    <div style={{ fontSize: 'var(--text-xs)' }}>
                      {fmtDateTime(detailData.customer.created_at)} by {detailData.customer.created_by_name || 'Staff'}
                    </div>
                  </div>
                </div>

                {/* Auditable Opening Balance Entries */}
                <div style={{ marginTop: '1.25rem', marginBottom: '1.25rem' }}>
                  <h4 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-muted)', marginBottom: '0.5rem' }}>
                    Opening Balance Ledger History
                  </h4>
                  {detailData.openingBalances && detailData.openingBalances.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {detailData.openingBalances.map((adj) => (
                        <div
                          key={adj.id}
                          style={{
                            padding: '0.65rem 0.85rem',
                            borderRadius: 'var(--radius-sm)',
                            background: adj.voided_at ? 'rgba(239, 68, 68, 0.05)' : 'rgba(16, 185, 129, 0.05)',
                            border: `1px solid ${adj.voided_at ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'}`,
                            fontSize: 'var(--text-xs)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <strong>{fmtCurrency(adj.balance_effect)}</strong>
                            <span>{fmtDate(adj.effective_date)}</span>
                          </div>
                          <div style={{ marginTop: 2, color: 'var(--color-muted)' }}>
                            Reason: {adj.reason}
                          </div>
                          {adj.voided_at && (
                            <div style={{ color: 'var(--color-error)', marginTop: 4, fontWeight: 600 }}>
                              VOIDED on {fmtDateTime(adj.voided_at)}: {adj.void_reason || 'Voided on balance update'}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted)' }}>
                      No opening balance recorded.
                    </div>
                  )}
                </div>

                {/* Audit Trail */}
                <div style={{ marginTop: '1.25rem' }}>
                  <h4 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-muted)', marginBottom: '0.5rem' }}>
                    Audit Log History
                  </h4>
                  {detailData.audit && detailData.audit.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: 180, overflowY: 'auto' }}>
                      {detailData.audit.map((al) => (
                        <div
                          key={al.id}
                          style={{
                            fontSize: 'var(--text-xs)',
                            padding: '0.45rem 0.75rem',
                            background: 'var(--color-surface)',
                            border: '1px solid var(--color-border)',
                            borderRadius: 'var(--radius-sm)',
                            display: 'flex',
                            justifyContent: 'space-between',
                          }}
                        >
                          <div>
                            <strong style={{ color: al.action_type === 'CREATE' ? 'var(--color-ok)' : 'var(--color-accent)' }}>
                              [{al.action_type}]
                            </strong> by {al.actor_name || 'System'}
                          </div>
                          <span style={{ color: 'var(--color-muted)' }}>{fmtDateTime(al.event_timestamp)}</span>
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
