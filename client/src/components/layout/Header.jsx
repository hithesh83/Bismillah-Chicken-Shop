/**
 * src/components/layout/Header.jsx
 *
 * Top header bar. Shown above the main content area.
 *
 * Responsibilities:
 *   - Hamburger button to open sidebar on mobile
 *   - Current page title
 *   - User name + role badge
 *   - Logout button
 */
import { RoleBadge } from '../ui/UIStates.jsx'
import './Header.css'

export default function Header({ user, pageTitle, onMenuOpen, onLogout }) {
  return (
    <header className="app-header" role="banner">
      {/* Hamburger — mobile only */}
      <button
        id="menu-btn"
        className="header-menu-btn"
        onClick={onMenuOpen}
        aria-label="Open navigation menu"
        aria-expanded="false"
      >
        <span className="hamburger-line" />
        <span className="hamburger-line" />
        <span className="hamburger-line" />
      </button>

      {/* Page title */}
      <h1 className="header-title" id="page-title">
        {pageTitle}
      </h1>

      {/* Right side: user info + logout */}
      <div className="header-actions">
        <div className="header-user" aria-label={`Signed in as ${user.name ?? user.email}`}>
          <span className="header-user-name">{user.name ?? user.email}</span>
          <RoleBadge role={user.role} />
        </div>

        <button
          id="logout-btn"
          className="header-logout-btn"
          onClick={onLogout}
          aria-label="Sign out"
        >
          Sign Out
        </button>
      </div>
    </header>
  )
}
