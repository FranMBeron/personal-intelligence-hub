CREATE TABLE connector_migrations (
  name TEXT PRIMARY KEY NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  applied_at TEXT NOT NULL
);

CREATE TABLE user_preferences (
  actor_id TEXT PRIMARY KEY NOT NULL,
  time_zone TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
