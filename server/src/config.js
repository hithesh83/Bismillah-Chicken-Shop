/**
 * server/src/config.js
 *
 * Centralised environment variable access.
 * Validates required variables at startup without printing their values.
 */

/**
 * Read a required environment variable.
 * Throws a clear error if it is missing or empty.
 * Never prints the value.
 *
 * @param {string} name  Environment variable name
 * @returns {string}     The variable's value
 */
export function readEnvRequired(name) {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Copy .env.example to .env and fill in the value for ${name}.`
    )
  }
  return value.trim()
}

/**
 * Read an optional environment variable with a default fallback.
 *
 * @param {string} name          Environment variable name
 * @param {string} defaultValue  Value to return when variable is absent
 * @returns {string}
 */
export function readEnvOptional(name, defaultValue = '') {
  const value = process.env[name]
  return (value && value.trim()) ? value.trim() : defaultValue
}
