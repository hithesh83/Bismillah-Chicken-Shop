/**
 * src/components/ui/UIStates.jsx
 *
 * Reusable standardised states:
 *   <LoadingState label="…" />           — spinner with optional label
 *   <ErrorState message="…" onRetry />   — error box with optional retry button
 *   <EmptyState title icon action />     — empty list/result placeholder
 *   <SuccessState message />             — success confirmation
 */
import './UIStates.css'

/** Inline or full-area loading spinner */
export function LoadingState({ label = 'Loading…', fullPage = false }) {
  return (
    <div className={`ui-state ui-state--loading ${fullPage ? 'ui-state--full' : ''}`}
         role="status" aria-label={label}>
      <span className="ui-spinner" />
      {label && <span className="ui-state__label">{label}</span>}
    </div>
  )
}

/** Error state with optional retry */
export function ErrorState({ message = 'Something went wrong.', onRetry }) {
  return (
    <div className="ui-state ui-state--error" role="alert">
      <span className="ui-state__icon">⚠️</span>
      <p className="ui-state__label">{message}</p>
      {onRetry && (
        <button className="ui-state__action" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

/** Empty list / no results placeholder */
export function EmptyState({
  icon    = '📭',
  title   = 'Nothing here yet',
  message = 'Records will appear here once they are added.',
  action,
  actionLabel = 'Add New',
}) {
  return (
    <div className="ui-state ui-state--empty">
      <span className="ui-state__icon">{icon}</span>
      <h3 className="ui-state__title">{title}</h3>
      {message && <p className="ui-state__label">{message}</p>}
      {action && (
        <button className="ui-state__action" onClick={action}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

/** Inline success confirmation */
export function SuccessState({ message = 'Done!' }) {
  return (
    <div className="ui-state ui-state--success" role="status">
      <span className="ui-state__icon">✅</span>
      <span className="ui-state__label">{message}</span>
    </div>
  )
}

/** Role badge pill */
export function RoleBadge({ role }) {
  const config = {
    admin:   { label: 'Admin',   cls: 'badge--admin' },
    manager: { label: 'Manager', cls: 'badge--manager' },
    staff:   { label: 'Staff',   cls: 'badge--staff' },
  }
  const { label, cls } = config[role] ?? { label: role, cls: '' }
  return <span className={`role-badge ${cls}`}>{label}</span>
}

/** Status dot + label */
export function StatusBadge({ status }) {
  const config = {
    active:   { label: 'Active',   cls: 'status--ok' },
    inactive: { label: 'Inactive', cls: 'status--muted' },
    locked:   { label: 'Locked',   cls: 'status--error' },
    pending:  { label: 'Pending',  cls: 'status--warning' },
    paid:     { label: 'Paid',     cls: 'status--ok' },
    partial:  { label: 'Partial',  cls: 'status--warning' },
    unpaid:   { label: 'Unpaid',   cls: 'status--error' },
  }
  const { label, cls } = config[status] ?? { label: status, cls: '' }
  return <span className={`status-badge ${cls}`}>{label}</span>
}
