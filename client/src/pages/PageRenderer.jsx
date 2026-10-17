/**
 * src/pages/PageRenderer.jsx
 *
 * Maps the current route id to the correct page component.
 * Falls back to DashboardPage for unknown routes.
 *
 * Role-based guard: if the user tries to access an admin-only page
 * (e.g. by manually typing the hash), render a 403 message.
 * Server-side enforcement remains the authoritative check.
 */
import { canAccess, NAV_ITEMS } from '../router.js'
import { Shield } from '../components/ui/Icons.jsx'

import DashboardPage      from './DashboardPage.jsx'
import ProductsPage       from './ProductsPage.jsx'
import ChickenLoadsPage   from './ChickenLoadsPage.jsx'
import DailyPricesPage    from './DailyPricesPage.jsx'
import RemainingStockPage from './RemainingStockPage.jsx'
import CustomersPage      from './CustomersPage.jsx'
import SalesPage          from './SalesPage.jsx'
import PaymentsPage       from './PaymentsPage.jsx'
import OutstandingPage    from './OutstandingPage.jsx'
import ReportsPage        from './ReportsPage.jsx'
import UserManagementPage from './UserManagementPage.jsx'
import SettingsPage       from './SettingsPage.jsx'
import ErrorBoundary      from '../components/ui/ErrorBoundary.jsx'
import './pages.css'

const PAGE_MAP = {
  'dashboard':       DashboardPage,
  'products':        ProductsPage,
  'chicken-loads':   ChickenLoadsPage,
  'daily-prices':    DailyPricesPage,
  'remaining-stock': RemainingStockPage,
  'customers':       CustomersPage,
  'sales':           SalesPage,
  'payments':        PaymentsPage,
  'outstanding':     OutstandingPage,
  'reports':         ReportsPage,
  'user-management': UserManagementPage,
  'settings':        SettingsPage,
}

export default function PageRenderer({ routeId, user, addToast }) {
  // Check role-based access for this route
  const navItem = NAV_ITEMS.find(item => item.id === routeId)
  if (navItem && !canAccess(navItem, user)) {
    return (
      <div className="page">
        <div className="placeholder-card">
          <span className="placeholder-icon"><Shield size={40} /></span>
          <span className="placeholder-label">Access Denied</span>
          <p className="placeholder-desc">
            You do not have permission to view this page.
            Contact your administrator if you need access.
          </p>
        </div>
      </div>
    )
  }

  const Page = PAGE_MAP[routeId] ?? DashboardPage
  return (
    <ErrorBoundary key={routeId}>
      <Page user={user} addToast={addToast} />
    </ErrorBoundary>
  )
}
