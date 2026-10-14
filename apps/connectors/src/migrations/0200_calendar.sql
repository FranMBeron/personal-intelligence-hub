CREATE TABLE calendar_connections (
  actor_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available', 'degraded', 'requires_reauthorization')),
  refresh_token_ciphertext TEXT NOT NULL,
  primary_calendar_binding_ciphertext TEXT,
  granted_scopes_json TEXT NOT NULL,
  selection_version INTEGER NOT NULL CHECK (selection_version > 0),
  last_success_at TEXT,
  safe_reason_code TEXT CHECK (safe_reason_code IS NULL OR safe_reason_code IN ('calendar_selection_required', 'provider_temporarily_unavailable', 'reauthorization_required', 'provider_permission_denied')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE calendar_oauth_transactions (
  state_hash TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  authorization_completed_at TEXT,
  CHECK (authorization_completed_at IS NULL OR consumed_at IS NOT NULL)
) STRICT;
CREATE INDEX calendar_oauth_transactions_expiry_idx ON calendar_oauth_transactions(expires_at);

CREATE TABLE calendar_allowlist (
  actor_id TEXT NOT NULL,
  calendar_ref TEXT NOT NULL,
  provider_calendar_id_ciphertext TEXT NOT NULL,
  provider_calendar_blind_index TEXT NOT NULL,
  display_name_ciphertext TEXT NOT NULL,
  provider_access_role TEXT NOT NULL CHECK (provider_access_role IN ('free_busy_reader', 'reader', 'writer', 'owner')),
  read_enabled INTEGER NOT NULL CHECK (read_enabled IN (0, 1)),
  write_enabled INTEGER NOT NULL CHECK (write_enabled IN (0, 1)),
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  last_verified_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, calendar_ref),
  UNIQUE (actor_id, provider_calendar_blind_index),
  CHECK (write_enabled = 0 OR provider_access_role IN ('writer', 'owner')),
  CHECK (is_primary = 0 OR read_enabled = 1 OR write_enabled = 1),
  FOREIGN KEY (actor_id) REFERENCES calendar_connections(actor_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE calendar_event_refs (
  actor_id TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  calendar_ref TEXT NOT NULL,
  provider_event_id_ciphertext TEXT NOT NULL,
  provider_event_blind_index TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, event_ref),
  UNIQUE (actor_id, calendar_ref, provider_event_blind_index),
  FOREIGN KEY (actor_id, calendar_ref) REFERENCES calendar_allowlist(actor_id, calendar_ref) ON DELETE CASCADE
) STRICT;
CREATE INDEX calendar_event_refs_retention_idx ON calendar_event_refs(last_observed_at);

CREATE TABLE calendar_change_proposals (
  actor_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'completed', 'rejected', 'expired', 'conflict', 'failed')),
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'cancel', 'respond_invitation')),
  event_ref TEXT,
  encrypted_payload TEXT,
  payload_purged_at TEXT,
  provider_etag_ciphertext TEXT,
  created_by_actor_type TEXT NOT NULL CHECK (created_by_actor_type IN ('human', 'agent', 'service')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  safe_reason_code TEXT CHECK (safe_reason_code IS NULL OR safe_reason_code IN ('proposal_expired', 'provider_state_changed', 'provider_permission_denied', 'provider_temporarily_unavailable', 'cancel_not_permitted')),
  PRIMARY KEY (actor_id, id),
  CHECK (payload_purged_at IS NULL OR encrypted_payload IS NULL),
  FOREIGN KEY (actor_id) REFERENCES calendar_connections(actor_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id, event_ref) REFERENCES calendar_event_refs(actor_id, event_ref) ON DELETE CASCADE
) STRICT;
CREATE INDEX calendar_change_proposals_executing_idx ON calendar_change_proposals(status, created_at, id);

CREATE TABLE calendar_change_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  proposal_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('connect', 'disconnect', 'selection_change', 'create', 'update', 'cancel', 'respond_invitation')),
  outcome TEXT NOT NULL CHECK (outcome IN ('connected', 'revoked', 'local_credentials_erased', 'selection_updated', 'proposed', 'completed', 'rejected', 'expired', 'conflict', 'failed')),
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX calendar_change_audit_actor_time_idx ON calendar_change_audit(actor_id, occurred_at);

CREATE TABLE calendar_idempotency (
  actor_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key_hash),
  UNIQUE (actor_id, proposal_id),
  FOREIGN KEY (actor_id, proposal_id) REFERENCES calendar_change_proposals(actor_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX calendar_idempotency_retention_idx ON calendar_idempotency(created_at);
