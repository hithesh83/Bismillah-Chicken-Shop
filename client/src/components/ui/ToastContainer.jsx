/**
 * src/components/ui/ToastContainer.jsx
 *
 * Renders the active toast notifications in the bottom-right corner.
 * Pair with useToast() hook.
 *
 * Usage:
 *   <ToastContainer toasts={toasts} onRemove={removeToast} />
 */
import './ToastContainer.css'

export default function ToastContainer({ toasts, onRemove }) {
  if (!toasts.length) return null

  return (
    <div className="toast-container" aria-live="polite" aria-label="Notifications">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast--${toast.type}`}
          role="alert"
        >
          <span className="toast__icon">{ICONS[toast.type]}</span>
          <span className="toast__message">{toast.message}</span>
          <button
            className="toast__close"
            onClick={() => onRemove(toast.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

const ICONS = {
  success: '✅',
  error:   '⚠️',
  warning: '🔔',
  info:    'ℹ️',
}
