-- Retain proposals and their idempotency keys when event references age out
-- or a calendar is deselected. The event reference is a historical pointer,
-- not an ownership relationship.
--
-- 0200 declares calendar_change_proposals(actor_id, event_ref) with an
-- ON DELETE CASCADE foreign key to calendar_event_refs. Removing it would need
-- a table rebuild, which packaged provider migrations must not do: an older
-- runtime has to keep serving this schema after a release rollback. Instead,
-- this migration is strictly additive.
ALTER TABLE calendar_change_proposals ADD COLUMN retained_event_ref TEXT;

-- Before an event reference is deleted (directly by retention, or through the
-- allowlist cascade when a calendar is deselected), detach referencing
-- proposals and keep the opaque reference in retained_event_ref. The cascade
-- then finds no children, so proposals and their idempotency rows survive.
-- The trigger lives in the schema, so it also protects deletes issued by an
-- older runtime that does not know about retained_event_ref.
CREATE TRIGGER calendar_event_refs_retain_proposals
BEFORE DELETE ON calendar_event_refs
BEGIN
  UPDATE calendar_change_proposals
  SET retained_event_ref = OLD.event_ref, event_ref = NULL
  WHERE actor_id = OLD.actor_id AND event_ref = OLD.event_ref;
END;
