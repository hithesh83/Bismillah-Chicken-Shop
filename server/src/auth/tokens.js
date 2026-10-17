/**
 * server/src/auth/tokens.js
 *
 * JWT creation and verification helpers.
 *
 * Token design:
 *   - Algorithm: HS256 (symmetric, secret known only to server)
 *   - Expiry:    8 hours (one full working shift)
 *   - Delivery:  HTTP-only, SameSite=Strict cookie (XSS-safe)
 *   - Payload:   { sub: userId, role, email }
 *     (minimal — never put sensitive data in a JWT payload)
 *
 * The JWT_SECRET must be at least 32 random bytes.
 * Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
 */

import jwt from 'jsonwebtoken'
import { readEnvRequired } from '../config.js'

export const TOKEN_EXPIRY_SECONDS = 8 * 60 * 60   // 8 hours
const COOKIE_NAME = 'bcs_token'

/**
 * Sign a JWT and set it as an HTTP-only cookie on the response.
 *
 * @param {import('express').Response} res  Express response object
 * @param {{ id: string, role: string, login_email: string, display_name: string }} user
 */
export function issueTokenCookie(res, user) {
  const secret = readEnvRequired('JWT_SECRET')

  const token = jwt.sign(
    {
      sub:   user.id,
      role:  user.role,
      email: user.login_email,
      name:  user.display_name,
    },
    secret,
    {
      expiresIn: TOKEN_EXPIRY_SECONDS,
      algorithm: 'HS256',
    }
  )

  const isProd = process.env.NODE_ENV === 'production'
  const rawSameSite = (process.env.COOKIE_SAME_SITE || '').toLowerCase().trim()
  const sameSite = rawSameSite === 'none'
    ? 'none'
    : (rawSameSite === 'strict' ? 'strict' : (rawSameSite === 'lax' ? 'lax' : (isProd ? 'none' : 'lax')))

  // Browsers strictly require secure: true whenever sameSite is 'none'
  const secure = sameSite === 'none' || isProd

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,                     // JS cannot read this cookie
    sameSite,
    secure,
    maxAge:   TOKEN_EXPIRY_SECONDS * 1000,
    path:     '/',
  })
}

/**
 * Clear the auth cookie (logout).
 *
 * @param {import('express').Response} res
 */
export function clearTokenCookie(res) {
  const isProd = process.env.NODE_ENV === 'production'
  const rawSameSite = (process.env.COOKIE_SAME_SITE || '').toLowerCase().trim()
  const sameSite = rawSameSite === 'none'
    ? 'none'
    : (rawSameSite === 'strict' ? 'strict' : (rawSameSite === 'lax' ? 'lax' : (isProd ? 'none' : 'lax')))
  const secure = sameSite === 'none' || isProd

  res.clearCookie(COOKIE_NAME, {
    path:     '/',
    httpOnly: true,
    sameSite,
    secure,
  })
}

/**
 * Verify a JWT string and return its decoded payload.
 * Throws if the token is invalid or expired.
 *
 * @param {string} token
 * @returns {{ sub: string, role: string, email: string, name: string, iat: number, exp: number }}
 */
export function verifyToken(token) {
  const secret = readEnvRequired('JWT_SECRET')
  return jwt.verify(token, secret, { algorithms: ['HS256'] })
}

export { COOKIE_NAME }
