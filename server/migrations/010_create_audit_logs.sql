-- Migration: 010_create_audit_logs.sql
-- Application-level audit trail for sensitive business changes.
--
-- Guarantees and limitations:
--   • Records are written within the same database transaction as the change.
--     If the change rolls back, so does the audit log entry.
--   • A database administrator with full access could modify audit rows.
--     This is NOT a tamper-proof system; it prevents casual data loss and
--     supports investigation. Legal-grade audit trails require a separate
--     append-only service (Phase 3+ decision).
--   • Never log credentials, passwords, connection strings, or tokens.
--   • change_metadata (JSONB) may contain before/after field values for
--     financial records. Do not log PII without reviewing data-retention policy.

BEGIN;

CREATE TABLE audit_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL actor_id = system-generated event
  actor_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action_type     TEXT        NOT NULL
                    CHECK (action_type IN (
                      'CREATE', 'UPDATE', 'VOID', 'CORRECT',
                      'ALLOCATE', 'LOGIN', 'SYSTEM'
                    )),
  entity_type     TEXT        NOT NULL,
  entity_id       UUID,
  -- JSONB for before/after metadata. Keep small; no secrets.
  change_metadata JSONB
);

COMMENT ON TABLE  audit_logs                IS
  'Application-level audit trail. Not tamper-proof; admin can modify rows. See migration comment.';
COMMENT ON COLUMN audit_logs.actor_id       IS 'NULL = system event. SET NULL on user deactivation preserves audit history.';
COMMENT ON COLUMN audit_logs.change_metadata IS 'Before/after field values as JSONB. Never log credentials or secrets.';

COMMIT;
