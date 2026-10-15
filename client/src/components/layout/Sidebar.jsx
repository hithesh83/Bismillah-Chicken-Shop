/**
 * src/components/layout/Sidebar.jsx
 *
 * Collapsible sidebar navigation.
 *
 * Desktop (≥768px): always visible, fixed on the left.
 * Mobile (<768px):  hidden off-screen; opens as a drawer overlay when
 *                   the user taps the hamburger in the Header.
 *
 * Props:
 *   user      — { name, email, role }
 *   currentId — currently active route id
 *   isOpen    — mobile drawer open state
 *   onClose   — close the mobile drawer
 */
import { NAV_ITEMS, canAccess, navigate } from '../../router.js'
import './Sidebar.css'

export default function Sidebar({ user, currentId, isOpen, onClose }) {
  function handleNav(item) {
    navigate(item.hash)
    onClose()   // close drawer on mobile after navigation
  }

  // Group items into sections
  const sections = []
  let currentSection = null

  for (const item of NAV_ITEMS) {
    if (!canAccess(item, user)) continue

    if (item.section && item.section !== currentSection) {
      currentSection = item.section
      sections.push({ type: 'section', label: item.section })
    }
    sections.push({ type: 'item', item })
  }

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isOpen && (
        <div
          className="sidebar-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <nav
        className={`sidebar ${isOpen ? 'sidebar--open' : ''}`}
        aria-label="Main navigation"
      >
        {/* Brand */}
        <div className="sidebar-brand">
          <span className="sidebar-brand-icon">🍗</span>
          <span className="sidebar-brand-name">Bismillah</span>
        </div>

        {/* Nav items */}
        <ul className="sidebar-nav">
          {sections.map((entry, i) => {
            if (entry.type === 'section') {
              return (
                <li key={`section-${i}`} className="sidebar-section-label">
                  {entry.label}
                </li>
              )
            }

            const { item } = entry
            const isActive = item.id === currentId

            return (
              <li key={item.id}>
                <button
                  className={`sidebar-item ${isActive ? 'sidebar-item--active' : ''}`}
                  onClick={() => handleNav(item)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="sidebar-item-icon">{item.icon}</span>
                  <span className="sidebar-item-label">{item.label}</span>
                  {isActive && <span className="sidebar-item-dot" aria-hidden="true" />}
                </button>
              </li>
            )
          })}
        </ul>

        {/* User info at bottom */}
        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-user-avatar" aria-hidden="true">
              {(user.name ?? user.email)[0].toUpperCase()}
            </div>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{user.name ?? user.email}</span>
              <span className="sidebar-user-role">{user.role}</span>
            </div>
          </div>
        </div>
      </nav>
    </>
  )
}
