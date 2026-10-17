/**
 * client/src/pages/ReportsPage.jsx
 *
 * Comprehensive Reports and Exports Page — Phase 12.
 *
 * Core Features:
 *   1. Periods: Daily, Weekly, Monthly, and Custom Date Ranges with Asia/Kolkata boundaries.
 *   2. Financial & Sales Metrics: Total Sales, Paid Immediately, Credit Sales, Collections Received.
 *   3. Separation of Sales vs. Collections: Strict decoupling without double-counting.
 *   4. Historical Period-End Outstanding: Calculated strictly as of period end.
 *   5. Chicken Processing & Weighted Aggregate Wastage: Aggregations & load breakdown.
 *   6. Manual Stock Observations: Recorded physical counts in period.
 *   7. Interactive Visual Charts: Daily sales & collections trends, Category breakdown.
 *   8. Full Tabular Reporting: Product sales, Collections by method, Customer balances, Loads.
 *   9. CSV Export & Print Layout: RFC 4180 CSV export with 100% total reconciliation & @media print.
 *  10. RBAC: Admin & Manager access only; Staff access rejected.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { LoadingState, ErrorState, EmptyState } from '../components/ui/UIStates.jsx'
import {
  Shield,
  TrendingUp,
  Calendar,
  Download,
  Printer,
  RefreshCw,
  Search,
  ChartNoAxesCombined,
  ReceiptText,
  Wallet,
  CircleAlert,
  Truck,
  Boxes,
  UsersRound,
  Drumstick,
} from '../components/ui/Icons.jsx'
import './pages.css'
import './ReportsPage.css'

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

function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export default function ReportsPage({ user, addToast }) {
  // Defensive role check (admin/manager allowed; staff disallowed)
  const isAuthorized = user?.role === 'admin' || user?.role === 'manager'

  const today = useMemo(() => getTodayIST(), [])

  // Period state
  const [period, setPeriod] = useState('daily') // 'daily' | 'weekly' | 'monthly' | 'custom'
  const [selectedDate, setSelectedDate] = useState(today)
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7))
  const [fromDate, setFromDate] = useState(addDays(today, -6))
  const [toDate, setToDate] = useState(today)

  // Active section tab
  const [activeTab, setActiveTab] = useState('overview') // 'overview' | 'sales' | 'collections' | 'outstanding' | 'loads' | 'stock'

  // Table search & filter states
  const [productSearch, setProductSearch] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [onlyOwing, setOnlyOwing] = useState(false)

  // API data state
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState(null)

  // Compute query string from current controls
  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('period', period)
    if (period === 'daily') {
      params.set('date', selectedDate)
    } else if (period === 'weekly') {
      params.set('date', selectedDate)
    } else if (period === 'monthly') {
      params.set('month', selectedMonth)
    } else if (period === 'custom') {
      params.set('from', fromDate)
      params.set('to', toDate)
    }
    return params.toString()
  }, [period, selectedDate, selectedMonth, fromDate, toDate])

  // Fetch report data
  const fetchReport = useCallback(async (isRefresh = false) => {
    if (!isAuthorized) {
      setLoading(false)
      return
    }

    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/reports?${queryString}`, { credentials: 'include' })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.message || `Server returned HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      if (isRefresh && addToast) {
        addToast({ type: 'info', message: 'Report data refreshed.' })
      }
    } catch (err) {
      setError(err.message || 'Failed to load report data.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [isAuthorized, queryString, addToast])

  useEffect(() => {
    fetchReport()
  }, [fetchReport])

  // CSV Export handler
  const handleExportCsv = async () => {
    setExporting(true)
    try {
      const exportUrl = `/api/reports/export?${queryString}`
      const res = await fetch(exportUrl, { credentials: 'include' })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.message || `Export failed: HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const filename = `bismillah-report-${data?.period?.startDate || 'export'}-to-${data?.period?.endDate || 'date'}.csv`
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)

      if (addToast) {
        addToast({ type: 'success', message: `Report exported as ${filename}` })
      }
    } catch (err) {
      if (addToast) {
        addToast({ type: 'error', message: err.message || 'CSV export failed.' })
      }
    } finally {
      setExporting(false)
    }
  }

  // Print handler
  const handlePrint = () => {
    window.print()
  }

  // Quick jump actions
  const jumpToToday = () => {
    setPeriod('daily')
    setSelectedDate(today)
  }

  const jumpToYesterday = () => {
    setPeriod('daily')
    setSelectedDate(addDays(today, -1))
  }

  const jumpDay = (offset) => {
    setSelectedDate(curr => addDays(curr, offset))
  }

  const jumpThisMonth = () => {
    setPeriod('monthly')
    setSelectedMonth(today.slice(0, 7))
  }

  const jumpLastMonth = () => {
    setPeriod('monthly')
    const [y, m] = today.slice(0, 7).split('-').map(Number)
    const prev = new Date(Date.UTC(y, m - 2, 1))
    setSelectedMonth(prev.toISOString().slice(0, 7))
  }

  const jumpLast7Days = () => {
    setPeriod('custom')
    setFromDate(addDays(today, -6))
    setToDate(today)
  }

  const jumpLast30Days = () => {
    setPeriod('custom')
    setFromDate(addDays(today, -29))
    setToDate(today)
  }

  // Unauthorized state
  if (!isAuthorized) {
    return (
      <div className="page reports-page">
        <div className="placeholder-card">
          <span className="placeholder-icon"><Shield size={40} /></span>
          <span className="placeholder-label">Access Restricted</span>
          <p className="placeholder-desc">
            Reports and financial exports require <strong>Admin</strong> or <strong>Manager</strong> credentials.
            Please switch to an authorized account.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return <LoadingState label="Generating business report and reconciling balances…" fullPage />
  }

  if (error) {
    return (
      <div className="page reports-page">
        <ErrorState
          message={`Unable to load report: ${error}`}
          onRetry={() => fetchReport(false)}
        />
      </div>
    )
  }

  // Destructure report sections
  const reportPeriod = data?.period ?? {}
  const salesSummary = data?.sales_summary ?? {}
  const collections = data?.collections ?? {}
  const chickenLoads = data?.chicken_loads ?? {}
  const stockObs = data?.stock_observations ?? {}
  const periodOutstanding = data?.period_end_outstanding ?? {}
  const productSales = data?.sales_by_product ?? []
  const categorySales = data?.sales_by_customer_category ?? []
  const dailyTrends = data?.daily_trends ?? []

  // Filtered product sales
  const filteredProducts = productSales.filter(p =>
    p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.product_category.toLowerCase().includes(productSearch.toLowerCase())
  )

  // Filtered customers
  const filteredCustomers = (periodOutstanding.customers_list ?? []).filter(c => {
    const matchesSearch =
      c.customer_name.toLowerCase().includes(customerSearch.toLowerCase()) ||
      c.party_code.toLowerCase().includes(customerSearch.toLowerCase())
    if (!matchesSearch) return false
    if (onlyOwing && Number(c.period_end_balance) <= 0.005) return false
    return true
  })

  // Wastage status badge
  const wastageNum = chickenLoads.aggregate_wastage_pct != null
    ? Number(chickenLoads.aggregate_wastage_pct)
    : null
  let wastageBadgeClass = 'good'
  if (wastageNum !== null) {
    if (wastageNum > 28) wastageBadgeClass = 'high'
    else if (wastageNum > 24) wastageBadgeClass = 'warning'
  }

  // Trends Chart Max Value Calculation for Scaling
  const maxTrendValue = Math.max(
    ...dailyTrends.map(t => Math.max(Number(t.sales_amount), Number(t.collections_amount))),
    1000
  )

  return (
    <div className="page reports-page">
      {/* ── Printable Header (Appears only on print / PDF) ───────── */}
      <div className="printable-report-banner" aria-hidden="true">
        <h1 className="print-banner-title">Bismillah Chicken Shop — Management Report</h1>
        <div className="print-banner-meta">
          <div><strong>Period:</strong> {reportPeriod.label} ({reportPeriod.startDate} to {reportPeriod.endDate})</div>
          <div><strong>Generated At:</strong> {new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (IST)</div>
        </div>
      </div>

      {/* ── Top Page Header ───────────────────────────────────────── */}
      <header className="reports-header">
        <div>
          <div className="reports-header-title-row">
            <h1 className="page-title">Reports & Business Analytics</h1>
            <span className="reports-period-badge">
              <span><Calendar size={14} /></span>
              <span>{reportPeriod.label || 'Selected Period'}</span>
            </span>
          </div>
        </div>

        <div className="reports-header-actions">
          <button
            type="button"
            className="report-action-btn btn-export"
            onClick={handleExportCsv}
            disabled={exporting}
            title="Download reconciled CSV report"
          >
            <span><Download size={15} /></span>
            <span>{exporting ? 'Exporting…' : 'Export CSV'}</span>
          </button>

          <button
            type="button"
            className="report-action-btn"
            onClick={handlePrint}
            title="Print or Save as PDF"
          >
            <span><Printer size={15} /></span>
            <span>Print Report</span>
          </button>

          <button
            type="button"
            className="report-action-btn"
            onClick={() => fetchReport(true)}
            disabled={refreshing}
            title="Refresh current report calculations"
          >
            <span className={`report-spin-icon ${refreshing ? 'spinning' : ''}`}><RefreshCw size={15} /></span>
            <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </header>

      {/* ── Period Selector & Filter Controls ─────────────────────── */}
      <section className="reports-filter-bar" aria-label="Report Period Selector">
        <div className="period-type-selector">
          <button
            type="button"
            className={`period-pill-btn ${period === 'daily' ? 'active' : ''}`}
            onClick={() => setPeriod('daily')}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 5 }}><Calendar size={14} /></span> Daily
          </button>
          <button
            type="button"
            className={`period-pill-btn ${period === 'weekly' ? 'active' : ''}`}
            onClick={() => setPeriod('weekly')}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 5 }}><Calendar size={14} /></span> Weekly
          </button>
          <button
            type="button"
            className={`period-pill-btn ${period === 'monthly' ? 'active' : ''}`}
            onClick={() => setPeriod('monthly')}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 5 }}><ChartNoAxesCombined size={14} /></span> Monthly
          </button>
          <button
            type="button"
            className={`period-pill-btn ${period === 'custom' ? 'active' : ''}`}
            onClick={() => setPeriod('custom')}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 5 }}><Search size={14} /></span> Custom Range
          </button>
        </div>

        <div className="period-inputs-row">
          <div className="period-inputs-group">
            {period === 'daily' && (
              <label className="period-input-label">
                <span>Select Date:</span>
                <input
                  type="date"
                  className="period-date-input"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                />
              </label>
            )}

            {period === 'weekly' && (
              <label className="period-input-label">
                <span>Week of (Pick any day in week):</span>
                <input
                  type="date"
                  className="period-date-input"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                />
              </label>
            )}

            {period === 'monthly' && (
              <label className="period-input-label">
                <span>Select Month:</span>
                <input
                  type="month"
                  className="period-date-input"
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                />
              </label>
            )}

            {period === 'custom' && (
              <>
                <label className="period-input-label">
                  <span>From Date:</span>
                  <input
                    type="date"
                    className="period-date-input"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </label>
                <label className="period-input-label">
                  <span>To Date:</span>
                  <input
                    type="date"
                    className="period-date-input"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>

          <div className="period-quick-links">
            {period === 'daily' && (
              <>
                <button type="button" className="quick-link-btn" onClick={() => jumpDay(-1)}>‹ Prev Day</button>
                <button type="button" className="quick-link-btn" onClick={jumpToToday}>Today</button>
                <button type="button" className="quick-link-btn" onClick={jumpToYesterday}>Yesterday</button>
                <button type="button" className="quick-link-btn" onClick={() => jumpDay(1)}>Next Day ›</button>
              </>
            )}
            {period === 'weekly' && (
              <>
                <button type="button" className="quick-link-btn" onClick={() => jumpDay(-7)}>‹ Prev Week</button>
                <button type="button" className="quick-link-btn" onClick={jumpToToday}>This Week</button>
                <button type="button" className="quick-link-btn" onClick={() => jumpDay(7)}>Next Week ›</button>
              </>
            )}
            {period === 'monthly' && (
              <>
                <button type="button" className="quick-link-btn" onClick={jumpLastMonth}>Last Month</button>
                <button type="button" className="quick-link-btn" onClick={jumpThisMonth}>This Month</button>
              </>
            )}
            {period === 'custom' && (
              <>
                <button type="button" className="quick-link-btn" onClick={jumpLast7Days}>Last 7 Days</button>
                <button type="button" className="quick-link-btn" onClick={jumpLast30Days}>Last 30 Days</button>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ── Section Navigation Tabs ───────────────────────────────── */}
      <nav className="reports-section-nav" aria-label="Report Views">
        <button
          type="button"
          className={`section-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><ChartNoAxesCombined size={15} /></span> Overview & Trends
        </button>
        <button
          type="button"
          className={`section-tab-btn ${activeTab === 'sales' ? 'active' : ''}`}
          onClick={() => setActiveTab('sales')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><ReceiptText size={15} /></span> Sales & Products ({productSales.length})
        </button>
        <button
          type="button"
          className={`section-tab-btn ${activeTab === 'collections' ? 'active' : ''}`}
          onClick={() => setActiveTab('collections')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><Wallet size={15} /></span> Collections ({collections.payments_count ?? 0})
        </button>
        <button
          type="button"
          className={`section-tab-btn ${activeTab === 'outstanding' ? 'active' : ''}`}
          onClick={() => setActiveTab('outstanding')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><CircleAlert size={15} /></span> Period-End Outstanding ({periodOutstanding.owing_customers_count ?? 0})
        </button>
        <button
          type="button"
          className={`section-tab-btn ${activeTab === 'loads' ? 'active' : ''}`}
          onClick={() => setActiveTab('loads')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><Truck size={15} /></span> Chicken Processing ({chickenLoads.total_loads ?? 0})
        </button>
        <button
          type="button"
          className={`section-tab-btn ${activeTab === 'stock' ? 'active' : ''}`}
          onClick={() => setActiveTab('stock')}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><Boxes size={15} /></span> Stock Observations ({stockObs.count ?? 0})
        </button>
      </nav>

      {/* ── 1. Financial & Operational KPI Cards ──────────────────── */}
      <section className="reports-kpi-grid" aria-label="Key Performance Indicators">
        {/* KPI 1: Invoiced Sales */}
        <div className="report-kpi-card kpi-sales">
          <div className="report-kpi-header">
            <span className="report-kpi-label">Total Invoiced Sales</span>
            <span className="report-kpi-icon"><ReceiptText size={20} /></span>
          </div>
          <div className="report-kpi-value">{fmtCurrency(salesSummary.total_sales)}</div>
          <div className="report-kpi-subtext">
            {salesSummary.sales_count} confirmed sales in period
          </div>
          <div className="report-kpi-breakdown-row">
            <span>Paid Immediately:</span>
            <span className="breakdown-val">{fmtCurrency(salesSummary.paid_sales)}</span>
          </div>
          <div className="report-kpi-breakdown-row">
            <span>Credit Sales:</span>
            <span className="breakdown-val">{fmtCurrency(salesSummary.credit_sales)}</span>
          </div>
        </div>

        {/* KPI 2: Collections Received */}
        <div className="report-kpi-card kpi-collections">
          <div className="report-kpi-header">
            <span className="report-kpi-label">Collections Received</span>
            <span className="report-kpi-icon"><Wallet size={20} /></span>
          </div>
          <div className="report-kpi-value">{fmtCurrency(collections.total_collections)}</div>
          <div className="report-kpi-subtext">
            {collections.payments_count} receipts recorded in period
          </div>
          <div className="report-kpi-breakdown-row">
            <span>Cash:</span>
            <span className="breakdown-val">
              {fmtCurrency(collections.by_method?.find(m => m.method === 'cash')?.total_amount || 0)}
            </span>
          </div>
          <div className="report-kpi-breakdown-row">
            <span>UPI / Bank / Other:</span>
            <span className="breakdown-val">
              {fmtCurrency(
                (Number(collections.total_collections || 0) -
                 Number(collections.by_method?.find(m => m.method === 'cash')?.total_amount || 0)).toFixed(2)
              )}
            </span>
          </div>
        </div>

        {/* KPI 3: Period-End Outstanding */}
        <div className="report-kpi-card kpi-credit">
          <div className="report-kpi-header">
            <span className="report-kpi-label">Period-End Outstanding</span>
            <span className="report-kpi-icon"><CircleAlert size={20} /></span>
          </div>
          <div className="report-kpi-value">{fmtCurrency(periodOutstanding.total_period_end_outstanding)}</div>
          <div className="report-kpi-subtext">
            As of {reportPeriod.endDate} (ignores later transactions)
          </div>
          <div className="report-kpi-breakdown-row">
            <span>Customers with Debt:</span>
            <span className="breakdown-val">{periodOutstanding.owing_customers_count} accounts</span>
          </div>
          <div className="report-kpi-breakdown-row">
            <span>Total Active Accounts:</span>
            <span className="breakdown-val">{periodOutstanding.total_active_customers} customers</span>
          </div>
        </div>

        {/* KPI 4: Chicken Processing & Wastage */}
        <div className="report-kpi-card kpi-processing">
          <div className="report-kpi-header">
            <span className="report-kpi-label">Dressed Chicken Output</span>
            <span className="report-kpi-icon"><Truck size={20} /></span>
          </div>
          <div className="report-kpi-value">{fmtKg(chickenLoads.total_dressed_weight_kg)}</div>
          <div className="report-kpi-subtext">
            From {fmtKg(chickenLoads.total_live_weight_kg)} live across {chickenLoads.total_loads} loads
          </div>
          <div className="report-kpi-breakdown-row">
            <span>Weighted Wastage %:</span>
            <span className={`breakdown-val badge-wastage ${wastageBadgeClass}`}>
              {chickenLoads.aggregate_wastage_pct !== null ? `${Number(chickenLoads.aggregate_wastage_pct).toFixed(2)}%` : 'N/A'}
            </span>
          </div>
          <div className="report-kpi-breakdown-row">
            <span>Wastage Weight:</span>
            <span className="breakdown-val">{fmtKg(chickenLoads.total_wastage_kg)}</span>
          </div>
        </div>
      </section>

      {/* ── 2. Visual Charts (Overview tab) ───────────────────────── */}
      {(activeTab === 'overview' || activeTab === 'sales') && (
        <section className="reports-charts-grid">
          {/* Trend Chart: Daily Sales vs Collections */}
          <div className="report-chart-card">
            <div className="chart-card-header">
              <span className="chart-card-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><TrendingUp size={16} /></span> Daily Sales vs. Collections Trend
              </span>
              <div className="chart-card-legend">
                <span className="legend-item">
                  <span className="legend-dot sales" />
                  <span>Sales Invoiced</span>
                </span>
                <span className="legend-item">
                  <span className="legend-dot collections" />
                  <span>Collections Received</span>
                </span>
              </div>
            </div>

            {dailyTrends.length === 0 ? (
              <EmptyState title="No trend data" message="No activity recorded in this date range." />
            ) : (
              <div className="chart-svg-container">
                <svg className="trend-svg" viewBox="0 0 700 240" preserveAspectRatio="none">
                  {/* Horizontal gridlines */}
                  <line x1="50" y1="20" x2="680" y2="20" className="svg-grid-line" />
                  <line x1="50" y1="75" x2="680" y2="75" className="svg-grid-line" />
                  <line x1="50" y1="130" x2="680" y2="130" className="svg-grid-line" />
                  <line x1="50" y1="185" x2="680" y2="185" className="svg-grid-line" />

                  {/* Y-axis labels */}
                  <text x="40" y="24" className="svg-axis-text" textAnchor="end">
                    ₹{Math.round(maxTrendValue).toLocaleString('en-IN')}
                  </text>
                  <text x="40" y="105" className="svg-axis-text" textAnchor="end">
                    ₹{Math.round(maxTrendValue / 2).toLocaleString('en-IN')}
                  </text>
                  <text x="40" y="188" className="svg-axis-text" textAnchor="end">₹0</text>

                  {/* Render bars for each day */}
                  {dailyTrends.map((t, idx) => {
                    const count = dailyTrends.length
                    const barGroupWidth = Math.min(48, Math.max(12, (620 / count) - 4))
                    const singleBarWidth = Math.max(4, (barGroupWidth / 2) - 2)
                    const xCenter = 60 + (idx * ((620) / count)) + (barGroupWidth / 2)

                    const salesH = Math.max(0, (Number(t.sales_amount) / maxTrendValue) * 165)
                    const collH  = Math.max(0, (Number(t.collections_amount) / maxTrendValue) * 165)

                    const salesY = 185 - salesH
                    const collY  = 185 - collH

                    return (
                      <g key={t.date} className="trend-bar-group">
                        <title>{`${t.date}\nSales: ₹${t.sales_amount}\nCollections: ₹${t.collections_amount}`}</title>
                        {/* Sales bar */}
                        <rect
                          x={xCenter - singleBarWidth - 1}
                          y={salesY}
                          width={singleBarWidth}
                          height={salesH}
                          fill="#3b82f6"
                          rx="2"
                        />
                        {/* Collections bar */}
                        <rect
                          x={xCenter + 1}
                          y={collY}
                          width={singleBarWidth}
                          height={collH}
                          fill="#22c55e"
                          rx="2"
                        />
                        {/* X-axis date label */}
                        {(count <= 14 || idx % Math.ceil(count / 10) === 0) && (
                          <text
                            x={xCenter}
                            y="205"
                            className="svg-axis-text"
                            textAnchor="middle"
                          >
                            {t.date.slice(5)}
                          </text>
                        )}
                      </g>
                    )
                  })}
                </svg>
              </div>
            )}
          </div>

          {/* Sales Breakdown by Customer Category */}
          <div className="report-chart-card">
            <div className="chart-card-header">
              <span className="chart-card-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 6 }}><UsersRound size={16} /></span> Sales by Customer Category
              </span>
            </div>

            {categorySales.length === 0 ? (
              <EmptyState title="No sales recorded" message="No sales recorded in this period." />
            ) : (
              <div className="category-bars-list">
                {categorySales.map(c => (
                  <div key={c.category_key} className="category-bar-item">
                    <div className="cat-bar-header">
                      <span className="cat-bar-label">
                        {c.category_label}
                      </span>
                      <span className="cat-bar-values">
                        <strong>{fmtCurrency(c.total_amount)}</strong> ({c.percentage}%)
                      </span>
                    </div>
                    <div className="cat-bar-track">
                      <div
                        className={`cat-bar-fill ${c.category_key}`}
                        style={{ width: `${Math.min(100, Math.max(2, Number(c.percentage)))}%` }}
                      />
                    </div>
                    <div className="report-kpi-subtext">
                      {c.sales_count} sale {c.sales_count === 1 ? 'invoice' : 'invoices'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── 3. Products Sales Breakdown ────────────────────────────── */}
      {(activeTab === 'overview' || activeTab === 'sales') && (
        <section className="report-section" aria-labelledby="products-breakdown-heading">
          <div className="report-section-header">
            <h2 id="products-breakdown-heading" className="report-section-title">
              <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Drumstick size={18} /></span> Product Sales & Revenue (Historical Charged Rates)
            </h2>
            <input
              type="search"
              className="report-table-search"
              placeholder="Filter by product name or category…"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
            />
          </div>

          {filteredProducts.length === 0 ? (
            <EmptyState
              title={productSales.length === 0 ? "No product sales in period" : "No matching products found"}
              message="Sales will appear here when invoices are generated for this date range."
            />
          ) : (
            <div className="report-table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Product Name</th>
                    <th>Category</th>
                    <th className="num-col">Quantity Sold (kg)</th>
                    <th className="num-col">Total Revenue (₹)</th>
                    <th className="num-col">Avg Rate (₹/kg)</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map(p => (
                    <tr key={p.product_id}>
                      <td><strong>{p.product_name}</strong></td>
                      <td><span className="badge-method">{p.product_category}</span></td>
                      <td className="num-col">{fmtKg(p.total_quantity_kg)}</td>
                      <td className="num-col"><strong>{fmtCurrency(p.total_revenue)}</strong></td>
                      <td className="num-col">{fmtCurrency(p.average_rate_per_kg)}</td>
                    </tr>
                  ))}
                  {/* Totals Row */}
                  <tr className="report-table-totals-row">
                    <td>TOTAL</td>
                    <td>{filteredProducts.length} Products</td>
                    <td className="num-col">
                      {fmtKg(filteredProducts.reduce((acc, p) => acc + Number(p.total_quantity_kg), 0))}
                    </td>
                    <td className="num-col">
                      {fmtCurrency(filteredProducts.reduce((acc, p) => acc + Number(p.total_revenue), 0))}
                    </td>
                    <td className="num-col">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── 4. Collections by Payment Method ───────────────────────── */}
      {(activeTab === 'overview' || activeTab === 'collections') && (
        <section className="report-section" aria-labelledby="collections-breakdown-heading">
          <div className="report-section-header">
            <h2 id="collections-breakdown-heading" className="report-section-title">
              <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Wallet size={18} /></span> Collections Received by Payment Method
            </h2>

          </div>

          {collections.by_method?.length === 0 ? (
            <EmptyState title="No collections in period" message="No payment receipts were recorded in this period." />
          ) : (
            <div className="report-table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Payment Method</th>
                    <th className="num-col">Receipts Count</th>
                    <th className="num-col">Total Collected (₹)</th>
                    <th className="num-col">Share of Collections (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {collections.by_method.map(m => {
                    const tot = Number(collections.total_collections) || 1
                    const pct = ((Number(m.total_amount) / tot) * 100).toFixed(2)
                    return (
                      <tr key={m.method}>
                        <td>
                          <span className="badge-method">
                            {m.method.toUpperCase()}
                          </span>
                        </td>
                        <td className="num-col">{m.count}</td>
                        <td className="num-col"><strong>{fmtCurrency(m.total_amount)}</strong></td>
                        <td className="num-col">{pct}%</td>
                      </tr>
                    )
                  })}
                  <tr className="report-table-totals-row">
                    <td>TOTAL COLLECTIONS</td>
                    <td className="num-col">{collections.payments_count}</td>
                    <td className="num-col">{fmtCurrency(collections.total_collections)}</td>
                    <td className="num-col">100.00%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── 5. Customer Period-End Outstanding Balances ───────────── */}
      {(activeTab === 'overview' || activeTab === 'outstanding') && (
        <section className="report-section" aria-labelledby="outstanding-breakdown-heading">
          <div className="report-section-header">
            <div>
              <h2 id="outstanding-breakdown-heading" className="report-section-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><CircleAlert size={18} /></span> Period-End Customer Outstanding (As of {reportPeriod.endDate})
              </h2>

            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: 'var(--text-xs)', color: 'var(--color-muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={onlyOwing}
                  onChange={(e) => setOnlyOwing(e.target.checked)}
                />
                <span>Only Outstanding &gt; ₹0</span>
              </label>

              <input
                type="search"
                className="report-table-search"
                placeholder="Search by customer name or code…"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
              />
            </div>
          </div>

          {filteredCustomers.length === 0 ? (
            <EmptyState
              title={periodOutstanding.customers_list?.length === 0 ? "No active customer accounts" : "No matching customers found"}
              message="Customer balances will appear here when accounts are established."
            />
          ) : (
            <div className="report-table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Party Code</th>
                    <th>Customer Name</th>
                    <th>Type</th>
                    <th className="num-col">Opening Balance</th>
                    <th className="num-col">Credit Sales</th>
                    <th className="num-col">Payments Made</th>
                    <th className="num-col">Adjustments</th>
                    <th className="num-col">Period-End Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map(c => {
                    const bal = Number(c.period_end_balance)
                    return (
                      <tr key={c.party_id}>
                        <td><code>{c.party_code}</code></td>
                        <td>
                          <strong>{c.customer_name}</strong>
                          {c.phone && <div className="report-kpi-subtext">{c.phone}</div>}
                        </td>
                        <td><span className="badge-method">{c.party_type}</span></td>
                        <td className="num-col">{fmtCurrency(c.opening_balance)}</td>
                        <td className="num-col">{fmtCurrency(c.credit_sales_through_end)}</td>
                        <td className="num-col">{fmtCurrency(c.payments_through_end)}</td>
                        <td className="num-col">{fmtCurrency(c.adjustments_through_end)}</td>
                        <td className="num-col" style={{ color: bal > 0.005 ? 'var(--color-error)' : 'var(--color-ok)', fontWeight: '700' }}>
                          {fmtCurrency(bal)}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="report-table-totals-row">
                    <td>TOTAL</td>
                    <td>{filteredCustomers.length} Customers</td>
                    <td>—</td>
                    <td className="num-col">
                      {fmtCurrency(filteredCustomers.reduce((acc, c) => acc + Number(c.opening_balance), 0))}
                    </td>
                    <td className="num-col">
                      {fmtCurrency(filteredCustomers.reduce((acc, c) => acc + Number(c.credit_sales_through_end), 0))}
                    </td>
                    <td className="num-col">
                      {fmtCurrency(filteredCustomers.reduce((acc, c) => acc + Number(c.payments_through_end), 0))}
                    </td>
                    <td className="num-col">
                      {fmtCurrency(filteredCustomers.reduce((acc, c) => acc + Number(c.adjustments_through_end), 0))}
                    </td>
                    <td className="num-col">
                      {fmtCurrency(filteredCustomers.reduce((acc, c) => acc + Number(c.period_end_balance), 0))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── 6. Chicken Loads & Wastage Breakdown ──────────────────── */}
      {(activeTab === 'overview' || activeTab === 'loads') && (
        <section className="report-section" aria-labelledby="loads-breakdown-heading">
          <div className="report-section-header">
            <div>
              <h2 id="loads-breakdown-heading" className="report-section-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Truck size={18} /></span> Chicken Processing & Wastage Breakdown
              </h2>

            </div>
          </div>

          {chickenLoads.loads_list?.length === 0 ? (
            <EmptyState
              title="No chicken loads recorded in period"
              message="Loads received in this date range will appear here with live and dressed weights."
            />
          ) : (
            <div className="report-table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Load Number</th>
                    <th>Date</th>
                    <th>Supplier / Ref</th>
                    <th className="num-col">Live Wt (kg)</th>
                    <th className="num-col">Dressed Wt (kg)</th>
                    <th className="num-col">Wastage %</th>
                    <th className="num-col">Remaining Stock (kg)</th>
                    <th>Recorded By</th>
                  </tr>
                </thead>
                <tbody>
                  {chickenLoads.loads_list.map(load => {
                    const lWastage = load.wastage_pct != null ? Number(load.wastage_pct) : null
                    let wCls = 'good'
                    if (lWastage !== null) {
                      if (lWastage > 28) wCls = 'high'
                      else if (lWastage > 24) wCls = 'warning'
                    }
                    return (
                      <tr key={load.id}>
                        <td><strong>#{load.load_number}</strong></td>
                        <td>{load.load_date}</td>
                        <td>{load.supplier_ref || '—'}</td>
                        <td className="num-col">{fmtKg(load.live_weight_kg)}</td>
                        <td className="num-col"><strong>{fmtKg(load.dressed_weight_kg)}</strong></td>
                        <td className="num-col">
                          <span className={`badge-wastage ${wCls}`}>
                            {lWastage !== null ? `${lWastage.toFixed(2)}%` : '—'}
                          </span>
                        </td>
                        <td className="num-col">{load.remaining_stock_kg ? fmtKg(load.remaining_stock_kg) : '—'}</td>
                        <td>{load.created_by_name || '—'}</td>
                      </tr>
                    )
                  })}
                  <tr className="report-table-totals-row">
                    <td>TOTAL</td>
                    <td>{chickenLoads.total_loads} Loads</td>
                    <td>—</td>
                    <td className="num-col">{fmtKg(chickenLoads.total_live_weight_kg)}</td>
                    <td className="num-col">{fmtKg(chickenLoads.total_dressed_weight_kg)}</td>
                    <td className="num-col">
                      <span className={`badge-wastage ${wastageBadgeClass}`}>
                        {chickenLoads.aggregate_wastage_pct !== null ? `${Number(chickenLoads.aggregate_wastage_pct).toFixed(2)}%` : 'N/A'}
                      </span>
                    </td>
                    <td className="num-col">—</td>
                    <td>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── 7. Manual Physical Stock Observations ─────────────────── */}
      {(activeTab === 'overview' || activeTab === 'stock') && (
        <section className="report-section" aria-labelledby="stock-breakdown-heading">
          <div className="report-section-header">
            <div>
              <h2 id="stock-breakdown-heading" className="report-section-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}><Boxes size={18} /></span> Manual Physical Stock Observations
              </h2>

            </div>
          </div>

          {stockObs.observations_list?.length === 0 ? (
            <EmptyState
              title="No physical stock readings in period"
              message="Stock readings recorded via the Remaining Stock page will appear here."
            />
          ) : (
            <div className="report-table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Category</th>
                    <th className="num-col">Observed Weight (kg)</th>
                    <th>Observed Time (IST)</th>
                    <th>Recorded By</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {stockObs.observations_list.map(obs => (
                    <tr key={obs.id}>
                      <td><strong>{obs.product_name}</strong></td>
                      <td><span className="badge-method">{obs.product_category}</span></td>
                      <td className="num-col"><strong>{fmtKg(obs.quantity_kg)}</strong></td>
                      <td>{fmtDateTime(obs.observed_at)}</td>
                      <td>{obs.created_by_name}</td>
                      <td>{obs.notes || '—'}</td>
                    </tr>
                  ))}
                  <tr className="report-table-totals-row">
                    <td>TOTAL OBSERVED</td>
                    <td>{stockObs.unique_products_count} Products</td>
                    <td className="num-col">{fmtKg(stockObs.total_observed_kg)}</td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
