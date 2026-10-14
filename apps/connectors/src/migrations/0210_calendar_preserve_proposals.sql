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
-- A detached proposal can no longer be executed against the provider state
-- it was confirmed for, so a live one leaves the state machine through an
-- edge the plan already defines: pending -> rejected and executing ->
-- conflict, both with safe reason provider_state_changed, a version bump
-- for compare-and-set callers, and a completion time. Terminal proposals keep
-- their status. event_ref stays NULL afterwards, so a later re-selection that
-- recreates the same opaque reference never re-attaches the proposal.
CREATE TRIGGER calendar_event_refs_retain_proposals
BEFORE DELETE ON calendar_event_refs
BEGIN
  UPDATE calendar_change_proposals
  SET retained_event_ref = OLD.event_ref,
      event_ref = NULL,
      status = CASE status WHEN 'pending' THEN 'rejected' WHEN 'executing' THEN 'conflict' ELSE status END,
      version = CASE WHEN status IN ('pending', 'executing') THEN version + 1 ELSE version END,
      completed_at = CASE WHEN status IN ('pending', 'executing') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
      safe_reason_code = CASE WHEN status IN ('pending', 'executing') THEN 'provider_state_changed' ELSE safe_reason_code END
  WHERE actor_id = OLD.actor_id AND event_ref = OLD.event_ref;
END;
