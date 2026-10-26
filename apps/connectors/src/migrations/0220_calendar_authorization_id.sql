-- Bind every derived write to the exact authorization that produced it.
-- A fresh opaque identifier is assigned on every authorization replacement,
-- so stale requests are rejected even when all other metadata is equal.
ALTER TABLE calendar_connections ADD COLUMN authorization_id TEXT NOT NULL DEFAULT '';

UPDATE calendar_connections SET authorization_id = lower(hex(randomblob(16))) WHERE authorization_id = '';

-- Rows inserted by an older runtime that does not know this column still
-- receive an opaque identifier, keeping the schema rollback compatible.
CREATE TRIGGER calendar_connections_authorization_id_default
AFTER INSERT ON calendar_connections
WHEN NEW.authorization_id = ''
BEGIN
  UPDATE calendar_connections SET authorization_id = lower(hex(randomblob(16)))
  WHERE actor_id = NEW.actor_id AND authorization_id = '';
END;

CREATE TRIGGER calendar_connections_authorization_id_update
BEFORE UPDATE OF authorization_id ON calendar_connections
WHEN length(NEW.authorization_id) < 32
BEGIN
  SELECT RAISE(ABORT, 'calendar_authorization_id_invalid');
END;
