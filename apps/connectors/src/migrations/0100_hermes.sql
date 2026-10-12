CREATE TABLE hermes_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE hermes_conversations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES hermes_profiles(id),
  kind TEXT NOT NULL CHECK (kind = 'direct'),
  title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  is_main INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  provision_state TEXT NOT NULL CHECK (provision_state IN ('pending', 'ready', 'failed')),
  upstream_session_id TEXT NOT NULL UNIQUE,
  event_floor_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_floor_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX hermes_one_main_conversation ON hermes_conversations(actor_id, agent_id) WHERE is_main = 1;
CREATE INDEX hermes_conversations_actor_page ON hermes_conversations(actor_id, updated_at DESC, id DESC);

CREATE TABLE hermes_conversation_selection (
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES hermes_conversations(id),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, agent_id)
) STRICT;

CREATE TABLE hermes_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  upstream_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('sending', 'accepted', 'streaming', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX hermes_messages_page ON hermes_messages(conversation_id, created_at DESC, id DESC);

CREATE TABLE hermes_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX hermes_events_replay ON hermes_events(conversation_id, sequence);

CREATE TABLE hermes_idempotency (
  actor_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES hermes_messages(id),
  assistant_message_id TEXT NOT NULL REFERENCES hermes_messages(id),
  run_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'admitted', 'terminal')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, conversation_id, idempotency_key)
) STRICT;

CREATE TABLE hermes_uploads (
  reference TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_path TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  claimed_by_admission TEXT,
  consumed_at TEXT
) STRICT;

CREATE TABLE hermes_delegations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL REFERENCES hermes_profiles(id),
  target_agent_id TEXT NOT NULL REFERENCES hermes_profiles(id),
  source_conversation_id TEXT REFERENCES hermes_conversations(id),
  upstream_session_id TEXT NOT NULL,
  upstream_run_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  safe_summary TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (actor_id, source_agent_id, idempotency_key)
) STRICT;
