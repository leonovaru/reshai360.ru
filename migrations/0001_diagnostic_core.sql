-- Решай360: core diagnostic storage (D1 / SQLite)
-- Migration: 0001_diagnostic_core
-- This migration creates new tables only. It does not read, alter, or delete KV data.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS diagnostic_progress (
  token TEXT NOT NULL,
  diagnostic_id TEXT NOT NULL,
  diagnostic_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS'
    CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'LOCKED')),
  drafts_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(drafts_json)),
  marked_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(marked_json)),
  last_operation_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token, diagnostic_id, diagnostic_version)
);

CREATE TABLE IF NOT EXISTS diagnostic_attempts (
  attempt_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  diagnostic_id TEXT NOT NULL,
  diagnostic_version TEXT NOT NULL,
  question_id TEXT NOT NULL,
  component_id TEXT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  operation_id TEXT NOT NULL,
  submitted_value_json TEXT NOT NULL CHECK (json_valid(submitted_value_json)),
  correctness TEXT NOT NULL
    CHECK (correctness IN ('CORRECT', 'INCORRECT', 'PARTIAL', 'UNASSESSED')),
  source TEXT NOT NULL CHECK (source IN ('USER_CHECK', 'FINALIZE_DRAFT')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token, diagnostic_id, diagnostic_version, operation_id),
  FOREIGN KEY (token, diagnostic_id, diagnostic_version)
    REFERENCES diagnostic_progress(token, diagnostic_id, diagnostic_version)
);

CREATE INDEX IF NOT EXISTS idx_attempts_token_question
  ON diagnostic_attempts(token, diagnostic_id, diagnostic_version, question_id, created_at);

CREATE TABLE IF NOT EXISTS diagnostic_completions (
  completion_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  diagnostic_id TEXT NOT NULL,
  diagnostic_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version >= 1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_checksum TEXT,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token, diagnostic_id, diagnostic_version),
  FOREIGN KEY (token, diagnostic_id, diagnostic_version)
    REFERENCES diagnostic_progress(token, diagnostic_id, diagnostic_version)
);

CREATE TABLE IF NOT EXISTS report_deliveries (
  delivery_id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'TELEGRAM')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  destination_hash TEXT,
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (completion_id) REFERENCES diagnostic_completions(completion_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_report_delivery_completion_channel
  ON report_deliveries(completion_id, channel);

CREATE TABLE IF NOT EXISTS promo_issuances (
  issuance_id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL UNIQUE,
  promo_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (status IN ('ISSUED', 'REDEEMED', 'REVOKED')),
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  FOREIGN KEY (completion_id) REFERENCES diagnostic_completions(completion_id)
);

CREATE TABLE IF NOT EXISTS diagnostic_operations (
  token TEXT NOT NULL,
  diagnostic_id TEXT NOT NULL,
  diagnostic_version TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('SAVE_PROGRESS', 'CHECK_ANSWER', 'COMPLETE', 'SEND_REPORT')),
  request_hash TEXT,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token, diagnostic_id, diagnostic_version, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_operations_created
  ON diagnostic_operations(created_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('ISSUE_PROMO', 'SEND_EMAIL', 'SEND_TELEGRAM')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (completion_id, event_type),
  FOREIGN KEY (completion_id) REFERENCES diagnostic_completions(completion_id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_ready
  ON outbox_events(status, next_attempt_at, locked_until);

CREATE TABLE IF NOT EXISTS legacy_migrations (
  token TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
  checksum TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token, source_key, source_version, target_version)
);

CREATE INDEX IF NOT EXISTS idx_legacy_migrations_status
  ON legacy_migrations(status, updated_at);
