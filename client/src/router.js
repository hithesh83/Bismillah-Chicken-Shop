/**
 * src/router.js
 *
 * Lightweight hash-based router for the Bismillah Chicken Shop app.
 *
 * Why hash routing:
 *   - Works with the Vite dev proxy without any historyApiFallback config.
 *   - All navigation is #/route — no server needs to handle SPA redirects.
 *   - Zero dependencies.
 *
 * Usage:
 *   import { NAV_ITEMS, getRouteId } from './router'
 *
 * Each nav item has:
 *   id       — unique identifier, used as the current "page" key
 *   label    — display name in sidebar
 *   icon     — emoji icon (no extra icon library needed)
 *   hash     — window.location.hash value, e.g. '#/dashboard'
 *   roles    — array of roles allowed to see this item ('admin','manager','staff')
 *              If empty → all authenticated users can see it.
 *   section  — optional section heading above this item
 */

import {
  LayoutDashboard,
  Package,
  Truck,
  IndianRupee,
  Boxes,
  UsersRound,
  ReceiptText,
  Wallet,
  CircleAlert,
  ChartNoAxesCombined,
  Users,
  Settings,
} from './components/ui/Icons.jsx'

export const NAV_ITEMS = [
  // ── Main ──────────────────────────────────────────────────
  {
    id:      'dashboard',
    label:   'Dashboard',
    icon:    LayoutDashboard,
    hash:    '#/dashboard',
    roles:   [],           // all roles
  },

  // ── Stock ─────────────────────────────────────────────────
  {
    id:      'products',
    label:   'Products',
    icon:    Package,
    hash:    '#/products',
    roles:   [],
    section: 'Stock',
  },
  {
    id:      'chicken-loads',
    label:   'Chicken Loads',
    icon:    Truck,
    hash:    '#/chicken-loads',
    roles:   [],
  },
  {
    id:      'daily-prices',
    label:   'Daily Prices',
    icon:    IndianRupee,
    hash:    '#/daily-prices',
    roles:   [],
  },
  {
    id:      'remaining-stock',
    label:   'Remaining Stock',
    icon:    Boxes,
    hash:    '#/remaining-stock',
    roles:   [],
  },

  // ── Sales ─────────────────────────────────────────────────
  {
    id:      'customers',
    label:   'Customers',
    icon:    UsersRound,
    hash:    '#/customers',
    roles:   [],
    section: 'Sales',
  },
  {
    id:      'sales',
    label:   'Sales',
    icon:    ReceiptText,
    hash:    '#/sales',
    roles:   [],
  },
  {
    id:      'payments',
    label:   'Payments',
    icon:    Wallet,
    hash:    '#/payments',
    roles:   [],
  },
  {
    id:      'outstanding',
    label:   'Outstanding',
    icon:    CircleAlert,
    hash:    '#/outstanding',
    roles:   [],
  },

  // ── Reports ───────────────────────────────────────────────
  {
    id:      'reports',
    label:   'Reports',
    icon:    ChartNoAxesCombined,
    hash:    '#/reports',
    roles:   ['admin', 'manager'],
    section: 'Reports',
  },

  // ── Admin-only ────────────────────────────────────────────
  {
    id:      'user-management',
    label:   'User Management',
    icon:    Users,
    hash:    '#/user-management',
    roles:   ['admin'],          // admin only
    section: 'Admin',
  },
  {
    id:      'settings',
    label:   'Settings',
    icon:    Settings,
    hash:    '#/settings',
    roles:   ['admin'],          // admin only
  },
]

/** Default hash for authenticated users */
export const DEFAULT_HASH = '#/dashboard'

/**
 * Get the nav item id from a hash string.
 * Falls back to 'dashboard' for unrecognised routes.
 *
 * @param {string} hash  e.g. '#/sales'
 * @returns {string}     e.g. 'sales'
 */
export function getRouteId(hash) {
  const found = NAV_ITEMS.find(item => item.hash === hash)
  return found?.id ?? 'dashboard'
}

/**
 * Navigate to a route by setting window.location.hash.
 * Triggers the hashchange event which the router hook listens to.
 *
 * @param {string} hash  e.g. '#/sales'
 */
export function navigate(hash) {
  window.location.hash = hash
}

/**
 * Check whether a user is allowed to view a nav item.
 *
 * @param {object} item   Nav item definition
 * @param {object} user   { role: 'admin'|'manager'|'staff' }
 * @returns {boolean}
 */
export function canAccess(item, user) {
  if (!item.roles || item.roles.length === 0) return true
  return item.roles.includes(user.role)
}
