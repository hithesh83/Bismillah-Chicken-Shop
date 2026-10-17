# Database Backup & Disaster Recovery Guide

This guide describes how to back up and restore the PostgreSQL database for **Bismillah Chicken Shop Management System** using native PostgreSQL utilities (`pg_dump`, `pg_restore`).

---

## 1. Overview & Architecture

- **Database Provider:** Supabase Managed PostgreSQL.
- **Connection Types:**
  - `DATABASE_URL_DIRECT` (port 5432): Required for `pg_dump`, `pg_restore`, and migrations. Bypasses transaction pooler.
  - `DATABASE_URL` (port 6543 or 5432): Used by the live application for query pooling.
- **Backup Format:** PostgreSQL Custom Archive Format (`.dump`, compressed binary). Allows selective table restore, object filtering, and parallel restoration.

---

## 2. Taking a Backup

### Using the Automated Script
From the `server/` directory:
```bash
# Ensure DATABASE_URL_DIRECT is set in environment or source .env
export DATABASE_URL_DIRECT="postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres"

chmod +x scripts/backup.sh
./scripts/backup.sh
```

### Manual Backup Command
```bash
pg_dump "$DATABASE_URL_DIRECT" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="backups/bismillah_backup_$(date +%Y%m%d_%H%M%S).dump"
```

### Recommended Retention Schedule
1. **Daily Backups:** Retain for 14 days.
2. **Weekly Backups:** Retain for 8 weeks.
3. **Monthly Backups:** Retain for 12 months.
4. **Storage:** Keep backups off-site in private encrypted storage (AWS S3 with SSE, Cloudflare R2, or Google Cloud Storage). **Never commit `.dump` files to Git.**

---

## 3. Restoring from a Backup

> [!CAUTION]
> Restoring drops and replaces existing tables in the target database. Always verify the target connection string before proceeding.

### Safe Test Database Verification (Recommended)
Before restoring to any shared or production environment, always test the restore archive against your isolated local test database:
```bash
# 1. Restore to isolated test database
chmod +x scripts/restore.sh
./scripts/restore.sh backups/bismillah_backup_YYYYMMDD_HHMMSS.dump "$DATABASE_URL_TEST"

# 2. Verify schema and migration state
npm run db:status
```

### Production Disaster Recovery
In a genuine disaster recovery scenario:
```bash
# Requires explicit confirmation prompt: user must type 'RESTORE'
CONFIRM_PRODUCTION_OVERWRITE=YES ./scripts/restore.sh backups/bismillah_backup_YYYYMMDD_HHMMSS.dump "$DATABASE_URL_DIRECT"
```

---

## 4. Verification & Health Checks
After any restore operation:
1. Verify migrations:
   ```bash
   npm run db:status
   ```
2. Verify table integrity:
   ```bash
   npm run db:verify
   ```
3. Verify application health check endpoint:
   ```bash
   curl -i http://localhost:5001/api/health/ready
   ```
