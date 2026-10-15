#!/usr/bin/env node
/**
 * server/scripts/provision-admin.js
 *
 * Securely creates the first Admin account.
 *
 * Usage:
 *   node scripts/provision-admin.js
 *
 * You will be prompted for:
 *   - Display name
 *   - Email address
 *   - Password (hidden input — never echoed to terminal)
 *
 * Safety rules:
 *   - This script refuses to create a duplicate admin for the same email.
 *   - The password is hashed with bcrypt (cost factor 12) before storage.
 *   - The plain-text password is never written to disk or logs.
 *   - If run again for an existing email, the existing account's password
 *     is updated (useful for credential reset).
 *
 * How to reset an admin password:
 *   Run this script again with the same email.
 *   The script will ask for a new password and update the hash.
 *
 * Environment:
 *   Reads DATABASE_URL_DIRECT from .env (project root).
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import readline from 'readline'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import pg from 'pg'

dotenv.config({ path: new URL('../../.env', import.meta.url) })

const { Client } = pg
const BCRYPT_ROUNDS = 12

// ── Helpers ────────────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve))
}

/**
 * Read a password without echoing it to the terminal.
 * Works on macOS/Linux TTYs. Falls back to visible input if no TTY.
 */
function askPassword(promptText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non-interactive (CI, pipe) — reject for safety
      reject(new Error(
        'Cannot read password in non-interactive mode. ' +
        'Run this script directly in a terminal.'
      ))
      return
    }

    process.stdout.write(promptText)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    let password = ''
    const onData = (char) => {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdout.write('\n')
        resolve(password)
      } else if (char === '\u0003') {
        // Ctrl+C
        process.stdin.setRawMode(false)
        process.stdin.pause()
        reject(new Error('Cancelled.'))
      } else if (char === '\u007f' || char === '\b') {
        // Backspace
        password = password.slice(0, -1)
      } else {
        password += char
      }
    }
    process.stdin.on('data', onData)
  })
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║   Bismillah Chicken Shop — Admin Setup   ║')
  console.log('╚══════════════════════════════════════════╝\n')
  console.log('This script creates or updates an admin account.')
  console.log('The password is NEVER stored in plain text.\n')

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    terminal: false,
  })

  let displayName, email, password, confirmPassword

  try {
    displayName = (await ask(rl, 'Display name  : ')).trim()
    if (!displayName) throw new Error('Display name cannot be empty.')

    email = (await ask(rl, 'Email address : ')).trim().toLowerCase()
    if (!email || !email.includes('@')) throw new Error('A valid email address is required.')

    rl.close()

    password = await askPassword('Password      : ')
    if (password.length < 10) throw new Error('Password must be at least 10 characters.')

    confirmPassword = await askPassword('Confirm pass  : ')
    if (password !== confirmPassword) throw new Error('Passwords do not match.')

  } catch (err) {
    rl.close()
    console.error(`\n❌ ${err.message}`)
    process.exit(1)
  }

  // ── Hash ──────────────────────────────────────────────────────────────────
  console.log('\n⏳ Hashing password…')
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  // Immediately overwrite the plain-text password variable
  password        = null
  confirmPassword = null

  // ── Connect ───────────────────────────────────────────────────────────────
  const connectionString = process.env.DATABASE_URL_DIRECT
  if (!connectionString) {
    console.error('❌ DATABASE_URL_DIRECT is not set in .env')
    process.exit(1)
  }

  const isLocal  = connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
  const client   = new Client({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  })

  try {
    await client.connect()
    console.log('✅ Connected to database.\n')

    // Check if user already exists
    const { rows: existing } = await client.query(
      'SELECT id, role FROM users WHERE login_email = $1',
      [email]
    )

    let action

    if (existing.length > 0) {
      // Update existing user — useful for password reset or role promotion
      await client.query(
        `UPDATE users
         SET password_hash         = $1,
             role                  = 'admin',
             is_active             = TRUE,
             failed_login_attempts = 0,
             locked_until          = NULL,
             display_name          = $2,
             updated_at            = NOW()
         WHERE login_email = $3`,
        [passwordHash, displayName, email]
      )
      action = existing[0].role === 'admin'
        ? 'Password updated for existing admin'
        : 'Existing user promoted to admin and password updated'
    } else {
      // Insert new admin
      await client.query(
        `INSERT INTO users (display_name, login_email, password_hash, role, is_active)
         VALUES ($1, $2, $3, 'admin', TRUE)`,
        [displayName, email, passwordHash]
      )
      action = 'New admin account created'
    }

    console.log(`\n✅ ${action}`)
    console.log(`   Name  : ${displayName}`)
    console.log(`   Email : ${email}`)
    console.log(`   Role  : admin`)
    console.log('\nYou can now log in at the application login page.')
    console.log('Keep this terminal output private.\n')

  } catch (err) {
    console.error('❌ Database error:', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
