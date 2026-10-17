/**
 * src/components/ui/ToastContainer.jsx
 *
 * Renders the active toast notifications in the bottom-right corner.
 * Pair with useToast() hook.
 *
 * Usage:
 *   <ToastContainer toasts={toasts} onRemove={removeToast} />
 */
import { CircleCheck, CircleX, TriangleAlert, Info, X } from './Icons.jsx'
import './ToastContainer.css'

const ICONS = {
  success: <CircleCheck size={18} />,
  error:   <CircleX size={18} />,
  warning: <TriangleAlert size={18} />,
  info:    <Info size={18} />,
}

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
          <span className="toast__icon">{ICONS[toast.type] || <Info size={18} />}</span>
          <span className="toast__message">{toast.message}</span>
          <button
            className="toast__close"
            onClick={() => onRemove(toast.id)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
