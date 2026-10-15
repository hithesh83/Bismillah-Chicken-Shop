/**
 * src/hooks/useToast.js
 *
 * Lightweight toast notification system.
 *
 * Usage:
 *   const { toasts, addToast, removeToast } = useToast()
 *   addToast({ message: 'Saved!', type: 'success' })   // type: success|error|warning|info
 *
 * Pair with <ToastContainer toasts={toasts} onRemove={removeToast} />
 */
import { useState, useCallback, useRef } from 'react'

let nextId = 1

export function useToast() {
  const [toasts, setToasts] = useState([])
  const timers = useRef({})

  const removeToast = useCallback((id) => {
    clearTimeout(timers.current[id])
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const addToast = useCallback(({ message, type = 'info', duration = 4000 }) => {
    const id = nextId++
    setToasts(prev => [...prev, { id, message, type }])
    if (duration > 0) {
      timers.current[id] = setTimeout(() => removeToast(id), duration)
    }
    return id
  }, [removeToast])

  return { toasts, addToast, removeToast }
}
