/**
 * client/src/pages/SettingsPage.jsx
 *
 * Full Application Settings Interface — Admin Only.
 *
 * Settings Categories:
 *   1. Shop Profile: Name, Tagline, Phone, Email, Physical Address, Tax ID / GSTIN
 *   2. Business Preferences: Timezone (Asia/Kolkata), Currency (INR ₹), Date Format, Weight Unit
 *   3. Operational Defaults: Low stock threshold kg, Default credit limit, Payment mode, Receipt printing
 *   4. Security & Audit: Session timeout, Brute-force lockout policy, Password policy, Settings Audit Trail, and Change Own Password.
 */

import { useState, useEffect, useCallback } from 'react'
import { LoadingState, ErrorState, EmptyState } from '../components/ui/UIStates.jsx'
import {
  Shield,
  Store,
  Globe,
  Settings,
  Lock,
  Key,
  ScrollText,
  RefreshCw,
} from '../components/ui/Icons.jsx'
import './pages.css'
import './SettingsPage.css'

function fmtDateTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
}

export default function SettingsPage({ user, addToast }) {
  const isAdmin = user?.role === 'admin'

  const [activeTab, setActiveTab] = useState('profile') // 'profile' | 'business' | 'operational' | 'security'
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Audit trail state
  const [auditLogs, setAuditLogs] = useState([])
  const [loadingAudit, setLoadingAudit] = useState(false)

  // Password change form state
  const [changingPass, setChangingPass] = useState(false)

  // Fetch settings from server
  const fetchSettings = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings', { credentials: 'include' })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.message || `Server returned HTTP ${res.status}`)
      }
      const data = await res.json()
      setSettings(data.settings || {})
    } catch (err) {
      setError(err.message || 'Failed to load settings.')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  // Fetch audit trail
  const fetchAudit = useCallback(async () => {
    if (!isAdmin) return
    setLoadingAudit(true)
    try {
      const res = await fetch('/api/settings/audit', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load settings audit trail.')
      const data = await res.json()
      setAuditLogs(data.audit || [])
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setLoadingAudit(false)
    }
  }, [isAdmin, addToast])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  useEffect(() => {
    if (activeTab === 'security') {
      fetchAudit()
    }
  }, [activeTab, fetchAudit])

  // Save settings category
  const handleSaveCategory = async (key, payload) => {
    setSaving(true)
    try {
      const res = await fetch(`/api/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || 'Failed to save settings.')

      if (addToast) addToast({ type: 'success', message: json.message })
      fetchSettings()
      if (activeTab === 'security') fetchAudit()
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  // Handle own password change
  const handleChangePassword = async (e) => {
    e.preventDefault()
    setChangingPass(true)
    const formData = new FormData(e.target)
    const current_password = formData.get('current_password')
    const new_password = formData.get('new_password')
    const confirm_password = formData.get('confirm_password')

    if (new_password !== confirm_password) {
      if (addToast) addToast({ type: 'error', message: 'New passwords do not match.' })
      setChangingPass(false)
      return
    }

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ current_password, new_password }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message || 'Failed to change password.')

      if (addToast) addToast({ type: 'success', message: 'Your password was changed successfully.' })
      e.target.reset()
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: err.message })
    } finally {
      setChangingPass(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="page settings-page">
        <div className="placeholder-card">
          <span className="placeholder-icon"><Shield size={40} /></span>
          <span className="placeholder-label">Access Restricted</span>
          <p className="placeholder-desc">
            Application settings require <strong>Administrator</strong> credentials.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return <LoadingState label="Loading application settings and system preferences…" fullPage />
  }

  if (error) {
    return (
      <div className="page settings-page">
        <ErrorState message={error} onRetry={fetchSettings} />
      </div>
    )
  }

  const shopProfile = settings?.shop_profile ?? {}
  const businessPrefs = settings?.business_preferences ?? {}
  const operationalPrefs = settings?.operational_preferences ?? {}
  const securityPolicy = settings?.security_policy ?? {}

  return (
    <div className="page settings-page">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Application Settings</h1>
          <p className="page-subtitle">
            Configure shop identity, regional standards, operational defaults, and security policies.
          </p>
        </div>
      </div>

      {/* ── Tabs Navigation ─────────────────────────────────────── */}
      <nav className="settings-tabs-nav" aria-label="Settings Categories">
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'profile' ? 'active' : ''}`}
          onClick={() => setActiveTab('profile')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><Store size={16} /></span> Shop Profile
        </button>
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'business' ? 'active' : ''}`}
          onClick={() => setActiveTab('business')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><Globe size={16} /></span> Business Preferences
        </button>
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'operational' ? 'active' : ''}`}
          onClick={() => setActiveTab('operational')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><Settings size={16} /></span> Operational Defaults
        </button>
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'security' ? 'active' : ''}`}
          onClick={() => setActiveTab('security')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><Lock size={16} /></span> Security & Policy
        </button>
      </nav>

      {/* ── Tab 1: Shop Profile ─────────────────────────────────── */}
      {activeTab === 'profile' && (
        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h2 className="settings-section-title"><span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Store size={20} /></span> Shop Identity & Contact</h2>
              <p className="page-subtitle">
                Information displayed on invoices, customer receipts, and report exports.
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.target)
              handleSaveCategory('shop_profile', {
                shop_name: fd.get('shop_name'),
                tagline:   fd.get('tagline'),
                phone:     fd.get('phone'),
                email:     fd.get('email'),
                address:   fd.get('address'),
                tax_id:    fd.get('tax_id'),
              })
            }}
          >
            <div className="settings-form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="shop_name">Shop Name *</label>
                <input
                  id="shop_name"
                  name="shop_name"
                  className="form-input"
                  defaultValue={shopProfile.shop_name || 'Bismillah Chicken Shop'}
                  required
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="tagline">Tagline / Slogan</label>
                <input
                  id="tagline"
                  name="tagline"
                  className="form-input"
                  defaultValue={shopProfile.tagline || ''}
                  placeholder="e.g. Fresh & Quality Halal Poultry"
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="phone">Contact Phone</label>
                <input
                  id="phone"
                  name="phone"
                  className="form-input"
                  defaultValue={shopProfile.phone || ''}
                  placeholder="e.g. +91 98765 43210"
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="email">Contact Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  className="form-input"
                  defaultValue={shopProfile.email || ''}
                  placeholder="e.g. contact@bismillahchicken.com"
                  disabled={saving}
                />
              </div>

              <div className="form-group settings-full-width">
                <label className="form-label" htmlFor="address">Physical Address</label>
                <textarea
                  id="address"
                  name="address"
                  className="form-input"
                  rows={2}
                  defaultValue={shopProfile.address || ''}
                  placeholder="Main Market Road, Near Jamia Masjid, Bengaluru, Karnataka 560001"
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="tax_id">GSTIN / Tax ID</label>
                <input
                  id="tax_id"
                  name="tax_id"
                  className="form-input"
                  defaultValue={shopProfile.tax_id || ''}
                  placeholder="e.g. 29AAAAA0000A1Z5"
                  disabled={saving}
                />
              </div>
            </div>

            <div className="settings-card-footer">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving Profile…' : 'Save Shop Profile'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Tab 2: Business Preferences ─────────────────────────── */}
      {activeTab === 'business' && (
        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h2 className="settings-section-title"><span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Globe size={20} /></span> Regional & Display Standards</h2>
              <p className="page-subtitle">
                Timezone, currency symbols, and display units. Historical stored accounting values are preserved.
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.target)
              handleSaveCategory('business_preferences', {
                timezone:        fd.get('timezone'),
                currency_code:   fd.get('currency_code'),
                currency_symbol: fd.get('currency_symbol'),
                date_format:     fd.get('date_format'),
                weight_unit:     fd.get('weight_unit'),
              })
            }}
          >
            <div className="settings-form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="timezone">Business Timezone *</label>
                <select
                  id="timezone"
                  name="timezone"
                  className="form-select"
                  defaultValue={businessPrefs.timezone || 'Asia/Kolkata'}
                  disabled={saving}
                >
                  <option value="Asia/Kolkata">Asia/Kolkata (IST — UTC+05:30)</option>
                  <option value="UTC">UTC (Coordinated Universal Time)</option>
                </select>
                <span className="form-hint">All daily cutoffs and shop clocks use this timezone.</span>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="currency_symbol">Currency Symbol *</label>
                <input
                  id="currency_symbol"
                  name="currency_symbol"
                  className="form-input"
                  defaultValue={businessPrefs.currency_symbol || '₹'}
                  required
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="currency_code">Currency Code *</label>
                <input
                  id="currency_code"
                  name="currency_code"
                  className="form-input"
                  defaultValue={businessPrefs.currency_code || 'INR'}
                  required
                  disabled={saving}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="weight_unit">Standard Weight Unit *</label>
                <select
                  id="weight_unit"
                  name="weight_unit"
                  className="form-select"
                  defaultValue={businessPrefs.weight_unit || 'kg'}
                  disabled={saving}
                >
                  <option value="kg">Kilograms (kg)</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="date_format">Date Format</label>
                <select
                  id="date_format"
                  name="date_format"
                  className="form-select"
                  defaultValue={businessPrefs.date_format || 'YYYY-MM-DD'}
                  disabled={saving}
                >
                  <option value="YYYY-MM-DD">YYYY-MM-DD (ISO)</option>
                  <option value="DD/MM/YYYY">DD/MM/YYYY (Indian Standard)</option>
                </select>
              </div>
            </div>

            <div className="settings-card-footer">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save Business Preferences'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Tab 3: Operational Defaults ─────────────────────────── */}
      {activeTab === 'operational' && (
        <div className="settings-card">
          <div className="settings-card-header">
            <div>
              <h2 className="settings-section-title"><span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Settings size={20} /></span> Shop-Floor Operational Defaults</h2>
              <p className="page-subtitle">
                Inventory alert thresholds, customer credit policies, and point-of-sale defaults.
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.target)
              handleSaveCategory('operational_preferences', {
                low_stock_threshold_kg:        Number(fd.get('low_stock_threshold_kg')),
                max_credit_limit_default:      Number(fd.get('max_credit_limit_default')),
                default_payment_mode:          fd.get('default_payment_mode'),
                print_receipt_on_sale:         fd.get('print_receipt_on_sale') === 'on',
                allow_credit_sales_for_walkin: fd.get('allow_credit_sales_for_walkin') === 'on',
              })
            }}
          >
            <div className="settings-form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="low_stock">Low Stock Warning Threshold (kg)</label>
                <input
                  id="low_stock"
                  name="low_stock_threshold_kg"
                  type="number"
                  step="0.1"
                  min="0"
                  className="form-input"
                  defaultValue={operationalPrefs.low_stock_threshold_kg ?? 50.0}
                  disabled={saving}
                />
                <span className="form-hint">Triggers inventory warning badges when stock falls below this weight.</span>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="max_credit">Default Customer Credit Limit (₹)</label>
                <input
                  id="max_credit"
                  name="max_credit_limit_default"
                  type="number"
                  step="100"
                  min="0"
                  className="form-input"
                  defaultValue={operationalPrefs.max_credit_limit_default ?? 25000.0}
                  disabled={saving}
                />
                <span className="form-hint">Pre-filled default credit ceiling for newly registered credit customers.</span>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="default_mode">Default Payment Mode</label>
                <select
                  id="default_mode"
                  name="default_payment_mode"
                  className="form-select"
                  defaultValue={operationalPrefs.default_payment_mode || 'cash'}
                  disabled={saving}
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI / QR Code</option>
                  <option value="bank">Bank Transfer</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="form-group settings-full-width">
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    name="print_receipt_on_sale"
                    className="settings-checkbox-input"
                    defaultChecked={operationalPrefs.print_receipt_on_sale ?? true}
                    disabled={saving}
                  />
                  <span>Prompt to print thermal receipt upon confirming each walk-in or credit sale</span>
                </label>
              </div>

              <div className="form-group settings-full-width">
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    name="allow_credit_sales_for_walkin"
                    className="settings-checkbox-input"
                    defaultChecked={operationalPrefs.allow_credit_sales_for_walkin ?? false}
                    disabled={saving}
                  />
                  <span>Allow credit sales for walk-in accounts (Requires customer party account if unchecked)</span>
                </label>
              </div>
            </div>

            <div className="settings-card-footer">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save Operational Defaults'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Tab 4: Security Policy & Audit ──────────────────────── */}
      {activeTab === 'security' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Security Standards Card */}
          <div className="settings-card">
            <div className="settings-card-header">
              <div>
                <h2 className="settings-section-title"><span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Lock size={20} /></span> Authentication & Brute-Force Policy</h2>
                <p className="page-subtitle">
                  Configure session lifecycle and login lockout thresholds. Secrets are never stored or displayed.
                </p>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                const fd = new FormData(e.target)
                handleSaveCategory('security_policy', {
                  session_timeout_hours:        Number(fd.get('session_timeout_hours')),
                  max_login_attempts:           Number(fd.get('max_login_attempts')),
                  lockout_minutes:              Number(fd.get('lockout_minutes')),
                  password_min_length:          Number(fd.get('password_min_length')),
                  require_password_change_days: Number(fd.get('require_password_change_days')),
                })
              }}
            >
              <div className="settings-form-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="session_timeout">Session Token Lifetime (hours)</label>
                  <input
                    id="session_timeout"
                    name="session_timeout_hours"
                    type="number"
                    min="1"
                    max="72"
                    className="form-input"
                    defaultValue={securityPolicy.session_timeout_hours ?? 8}
                    disabled={saving}
                  />
                  <span className="form-hint">Standard shift duration: 8 hours.</span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="max_attempts">Max Failed Login Attempts</label>
                  <input
                    id="max_attempts"
                    name="max_login_attempts"
                    type="number"
                    min="3"
                    max="15"
                    className="form-input"
                    defaultValue={securityPolicy.max_login_attempts ?? 5}
                    disabled={saving}
                  />
                  <span className="form-hint">Consecutive failures trigger automatic temporary lockout.</span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="lockout_mins">Lockout Duration (minutes)</label>
                  <input
                    id="lockout_mins"
                    name="lockout_minutes"
                    type="number"
                    min="5"
                    max="120"
                    className="form-input"
                    defaultValue={securityPolicy.lockout_minutes ?? 15}
                    disabled={saving}
                  />
                  <span className="form-hint">Account is locked against brute force for this duration.</span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="pw_len">Minimum Password Length</label>
                  <input
                    id="pw_len"
                    name="password_min_length"
                    type="number"
                    min="8"
                    max="32"
                    className="form-input"
                    defaultValue={securityPolicy.password_min_length ?? 8}
                    disabled={saving}
                  />
                  <span className="form-hint">Enforced across all new accounts and password resets.</span>
                </div>

                <div className="settings-info-box settings-full-width">
                  <strong><Shield size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} /> System Security Guarantee:</strong>
                  <span>• Passwords are consistently hashed using bcrypt with salt cost factor 12.</span>
                  <span>• Authentication uses HTTP-Only, SameSite Same-Origin JWT cookies.</span>
                  <span>• All sensitive financial, customer, and administrative modifications write immutable records to the audit log.</span>
                </div>
              </div>

              <div className="settings-card-footer">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save Security Policy'}
                </button>
              </div>
            </form>
          </div>

          {/* Own Password Change Card */}
          <div className="settings-card">
            <div className="settings-card-header">
              <div>
                <h2 className="settings-section-title"><span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Key size={20} /></span> Change Your Password</h2>
                <p className="page-subtitle">
                  Update your administrator login credentials. Requires your current password.
                </p>
              </div>
            </div>

            <form onSubmit={handleChangePassword}>
              <div className="settings-form-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="current_password">Current Password *</label>
                  <input
                    id="current_password"
                    name="current_password"
                    type="password"
                    className="form-input"
                    required
                    disabled={changingPass}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="new_pw">New Password *</label>
                  <input
                    id="new_pw"
                    name="new_password"
                    type="password"
                    minLength={8}
                    className="form-input"
                    required
                    disabled={changingPass}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="confirm_pw">Confirm New Password *</label>
                  <input
                    id="confirm_pw"
                    name="confirm_password"
                    type="password"
                    minLength={8}
                    className="form-input"
                    required
                    disabled={changingPass}
                  />
                </div>
              </div>

              <div className="settings-card-footer">
                <button type="submit" className="btn btn-primary" disabled={changingPass}>
                  {changingPass ? 'Updating Password…' : 'Update My Password'}
                </button>
              </div>
            </form>
          </div>

          {/* Settings Audit Trail */}
          <div className="settings-card">
            <div className="settings-card-header">
              <div>
                <h2 className="settings-section-title"><span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><ScrollText size={20} /></span> Settings Audit Trail</h2>
                <p className="page-subtitle">
                  Chronological history of configuration and policy changes made by administrators.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={fetchAudit}
                disabled={loadingAudit}
              >
                <span><RefreshCw size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Refresh Trail</span>
              </button>
            </div>

            {loadingAudit ? (
              <LoadingState label="Loading audit trail…" />
            ) : auditLogs.length === 0 ? (
              <EmptyState title="No settings modifications yet" message="Audit logs will appear here when settings are updated." />
            ) : (
              <div className="audit-timeline">
                {auditLogs.map((log) => (
                  <div key={log.id} className="audit-item">
                    <div className="audit-item-header">
                      <span className="audit-action-badge">{log.action_type}</span>
                      <span className="audit-timestamp">{fmtDateTime(log.event_timestamp)}</span>
                    </div>
                    <div className="audit-actor">
                      Modified by: <strong>{log.actor_name || 'Administrator'}</strong>
                    </div>
                    {log.change_metadata && (
                      <pre className="audit-meta-json">
                        {JSON.stringify(log.change_metadata, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
