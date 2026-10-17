#!/usr/bin/env bash
# ==============================================================================
# Bismillah Chicken Shop – PostgreSQL Backup Script
#
# Generates a timestamped logical backup of the database using pg_dump.
# Compatible with Supabase (Free, Pro, Team) and local PostgreSQL.
#
# Usage:
#   ./scripts/backup.sh [optional_target_directory]
#
# Environment variables used:
#   DATABASE_URL_DIRECT (or DATABASE_URL)
# ==============================================================================

set -euo pipefail

# 1. Determine target directory
BACKUP_DIR="${1:-./backups}"
mkdir -p "$BACKUP_DIR"

# 2. Resolve database connection string (Direct connection port 5432 preferred)
DB_CONN="${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}"

if [ -z "$DB_CONN" ]; then
  echo "❌ Error: Neither DATABASE_URL_DIRECT nor DATABASE_URL is set."
  echo "   Please export DATABASE_URL_DIRECT or source your .env file."
  exit 1
fi

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/bismillah_backup_${TIMESTAMP}.dump"

echo "=========================================================="
echo "📦 Starting Bismillah Chicken Shop Database Backup"
echo "   Destination: ${BACKUP_FILE}"
echo "   Timestamp:   ${TIMESTAMP}"
echo "=========================================================="

# 3. Execute pg_dump
# Flags explained:
#   --format=custom   : Compressed binary format for flexible, selective restore
#   --no-owner        : Suppress ownership statements to allow restoring across roles
#   --no-privileges   : Suppress GRANT/REVOKE commands
#   --verbose         : Emit progress logging
pg_dump "$DB_CONN" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$BACKUP_FILE"

FILESIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo "=========================================================="
echo "✅ Backup successfully created!"
echo "   File: ${BACKUP_FILE} (${FILESIZE})"
echo "   NOTE: Store backup archives securely. Never commit to Git."
echo "=========================================================="
