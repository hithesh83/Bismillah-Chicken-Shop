/**
 * src/components/layout/AppShell.jsx
 *
 * The full authenticated application shell.
 * Composes: Sidebar + Header + page content area + ToastContainer.
 *
 * Props:
 *   user      — authenticated user object { id, name, email, role }
 *   onLogout  — logout handler from App.jsx
 */
import { useState } from 'react'
import { useRoute } from '../../hooks/useRoute.js'
import { useToast } from '../../hooks/useToast.js'
import { NAV_ITEMS }  from '../../router.js'
import Sidebar         from './Sidebar.jsx'
import Header          from './Header.jsx'
import ToastContainer  from '../ui/ToastContainer.jsx'
import PageRenderer    from '../../pages/PageRenderer.jsx'
import './AppShell.css'

export default function AppShell({ user, onLogout }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const routeId                       = useRoute()
  const { toasts, addToast, removeToast } = useToast()

  // Derive the current page title from the nav config
  const currentItem = NAV_ITEMS.find(item => item.id === routeId)
  const pageTitle   = currentItem?.label ?? 'Dashboard'

  return (
    <div className="app-shell">
      {/* Sidebar navigation */}
      <Sidebar
        user={user}
        currentId={routeId}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main area (header + content) */}
      <div className="app-main">
        <Header
          user={user}
          pageTitle={pageTitle}
          onMenuOpen={() => setSidebarOpen(true)}
          onLogout={onLogout}
        />

        {/* Page content */}
        <main className="app-content" id="main-content" aria-labelledby="page-title">
          <PageRenderer
            routeId={routeId}
            user={user}
            addToast={addToast}
          />
        </main>
      </div>

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}
