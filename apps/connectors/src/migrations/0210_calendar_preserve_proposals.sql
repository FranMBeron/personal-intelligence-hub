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
--
-- The trigger only detaches. It changes no status, version, completion time,
-- or reason code: state transitions belong to the application, which owns the
-- clock and the audit trail. Before it removes event references, the
-- application rejects affected pending proposals in the same transaction;
-- executing proposals stay executing so the executor or reconciler settles
-- them from retained_event_ref. event_ref stays NULL afterwards, so a later
-- re-selection that recreates the same opaque reference never re-attaches
-- the proposal.
CREATE TRIGGER calendar_event_refs_retain_proposals
BEFORE DELETE ON calendar_event_refs
BEGIN
  UPDATE calendar_change_proposals
  SET retained_event_ref = OLD.event_ref,
      event_ref = NULL
  WHERE actor_id = OLD.actor_id AND event_ref = OLD.event_ref;
END;

-- Hazard: never write calendar_event_refs with a REPLACE conflict resolution
-- (INSERT OR REPLACE, REPLACE INTO, UPDATE OR REPLACE). REPLACE deletes the
-- conflicting row without firing the trigger above while recursive_triggers
-- is off (the SQLite default, and how the connector database runs), so the
-- 0200 ON DELETE CASCADE deletes the referencing proposals and, through them,
-- their idempotency rows. Use INSERT ... ON CONFLICT DO UPDATE instead. A
-- BEFORE INSERT guard cannot tell REPLACE from an ON CONFLICT DO UPDATE upsert
-- (both fire it before conflict resolution), so the repository tests enforce
-- this rule instead.

-- The trigger above and the retention purge's live-proposal check look up
-- proposals by (actor_id, event_ref); without this index each deleted event
-- reference scans the actor's proposals.
CREATE INDEX IF NOT EXISTS calendar_change_proposals_event_ref_idx
ON calendar_change_proposals(actor_id, event_ref);
