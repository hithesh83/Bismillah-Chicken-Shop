/**
 * src/hooks/useRoute.js
 *
 * React hook that tracks window.location.hash and returns the current route id.
 * Updates automatically when the user navigates (back/forward or link click).
 */
import { useState, useEffect } from 'react'
import { getRouteId, DEFAULT_HASH } from '../router.js'

export function useRoute() {
  const [routeId, setRouteId] = useState(() => {
    // Initialise from current hash, default to dashboard
    const hash = window.location.hash || DEFAULT_HASH
    if (!window.location.hash) window.location.hash = DEFAULT_HASH
    return getRouteId(hash)
  })

  useEffect(() => {
    function onHashChange() {
      setRouteId(getRouteId(window.location.hash || DEFAULT_HASH))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return routeId
}
