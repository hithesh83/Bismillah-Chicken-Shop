/**
 * client/src/utils/api.js
 *
 * Centralized API base URL resolver.
 * - In local development (with Vite dev proxy) or in production with Vercel rewrites:
 *   VITE_API_URL is empty -> apiUrl('/api/foo') resolves to relative path '/api/foo'
 * - In production when calling Render directly across origins:
 *   VITE_API_URL is configured (e.g. 'https://bismillah-api.onrender.com') ->
 *   apiUrl('/api/foo') resolves to 'https://bismillah-api.onrender.com/api/foo'
 */
const RAW_URL = import.meta.env.VITE_API_URL || ''
export const API_BASE_URL = RAW_URL.replace(/\/+$/, '')

/**
 * Resolves an API path to an absolute or relative URL based on environment configuration.
 * @param {string} path - e.g. '/api/sales' or 'api/sales'
 * @returns {string} - Full URL or relative path
 */
export function apiUrl(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE_URL}${normalized}`
}

export default apiUrl
