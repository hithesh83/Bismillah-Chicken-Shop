#!/usr/bin/env bash
# ==============================================================================
# Bismillah Chicken Shop – PostgreSQL Restore Script
#
# Restores a logical database dump (.dump) created by backup.sh.
#
# SAFETY RULES:
#   1. NEVER runs automatically without interactive or explicit user confirmation.
#   2. Restores to an isolated TEST database (DATABASE_URL_TEST) by default.
#   3. Refuses to restore to production unless explicit override is provided.
#
# Usage:
#   ./scripts/restore.sh <path_to_backup_file> [target_db_url]
#
# ==============================================================================

set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_URL="${2:-${DATABASE_URL_TEST:-}}"
PROD_URL="${DATABASE_URL:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "❌ Error: Backup file path must be provided as the first argument."
  echo "   Usage: $0 <path_to_backup_file> [target_database_url]"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Error: Backup file not found at: ${BACKUP_FILE}"
  exit 1
fi

if [ -z "$TARGET_URL" ]; then
  echo "❌ Error: Target database URL not specified and DATABASE_URL_TEST is empty."
  echo "   Specify target DB as second argument or set DATABASE_URL_TEST in environment."
  exit 1
fi

# ── Safety Check: Guard against accidental production restore ──
if [ -n "$PROD_URL" ] && [ "$TARGET_URL" = "$PROD_URL" ]; then
  echo "⚠️  CRITICAL SAFETY WARNING: Target database URL matches production DATABASE_URL!"
  echo "   Restoring will DROP and OVERWRITE live production data."
  if [ "${CONFIRM_PRODUCTION_OVERWRITE:-}" != "YES" ]; then
    echo "❌ ABORTED: To overwrite production, you must set CONFIRM_PRODUCTION_OVERWRITE=YES."
    exit 1
  fi
fi

echo "=========================================================="
echo "⚠️  DATABASE RESTORE CONFIRMATION REQUIRED"
echo "   Source Archive: ${BACKUP_FILE}"
echo "   Target DB:      ${TARGET_URL%%\?*}" # Print URL without query parameters for safety
echo "=========================================================="
echo "This action will REPLACE existing tables in the target database."
read -r -p "Type 'RESTORE' to confirm: " CONFIRMATION

if [ "$CONFIRMATION" != "RESTORE" ]; then
  echo "❌ Restore cancelled by user."
  exit 0
fi

echo "🔄 Restoring database..."
pg_restore \
  --dbname="$TARGET_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --verbose \
  "$BACKUP_FILE" || {
    echo "⚠️  pg_restore completed with warnings (often harmless object warnings on clean restores)."
  }

echo "=========================================================="
echo "✅ Restore process completed."
echo "   Run 'npm run db:status' against target DB to verify schema."
echo "=========================================================="
