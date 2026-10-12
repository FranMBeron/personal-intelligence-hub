-- Retain proposals and their idempotency keys when event references age out
-- or a calendar is deselected. The event reference is a historical pointer,
-- not an ownership relationship.
CREATE TABLE calendar_change_proposals_v2 (
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
  FOREIGN KEY (actor_id) REFERENCES calendar_connections(actor_id) ON DELETE CASCADE
) STRICT;

INSERT INTO calendar_change_proposals_v2(
  actor_id, id, version, status, operation, event_ref, encrypted_payload,
  payload_purged_at, provider_etag_ciphertext, created_by_actor_type,
  created_at, expires_at, completed_at, safe_reason_code
)
SELECT
  actor_id, id, version, status, operation, event_ref, encrypted_payload,
  payload_purged_at, provider_etag_ciphertext, created_by_actor_type,
  created_at, expires_at, completed_at, safe_reason_code
FROM calendar_change_proposals;

CREATE INDEX calendar_change_proposals_v2_executing_idx
  ON calendar_change_proposals_v2(status, created_at, id);

CREATE TABLE calendar_idempotency_v2 (
  actor_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key_hash),
  UNIQUE (actor_id, proposal_id),
  FOREIGN KEY (actor_id, proposal_id) REFERENCES calendar_change_proposals_v2(actor_id, id) ON DELETE CASCADE
) STRICT;

INSERT INTO calendar_idempotency_v2(actor_id, idempotency_key_hash, request_hash, proposal_id, created_at)
SELECT actor_id, idempotency_key_hash, request_hash, proposal_id, created_at
FROM calendar_idempotency;

CREATE INDEX calendar_idempotency_v2_retention_idx ON calendar_idempotency_v2(created_at);

DROP TABLE calendar_idempotency;
DROP TABLE calendar_change_proposals;

ALTER TABLE calendar_change_proposals_v2 RENAME TO calendar_change_proposals;
ALTER TABLE calendar_idempotency_v2 RENAME TO calendar_idempotency;
