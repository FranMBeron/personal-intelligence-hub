import type { SqliteHandle } from "../../foundation/database.js";
const fail = (code: string): never => { throw new Error(code); };
export interface IdempotencyReservation {
  readonly actorId: string; readonly conversationId: string; readonly idempotencyKey: string; readonly requestHash: string;
  readonly messageId: string; readonly assistantMessageId: string; readonly createdAt: string; readonly expiresAt: string;
}
export interface AttachRun { readonly actorId: string; readonly conversationId: string; readonly idempotencyKey: string; readonly runId: string; }
export interface IdempotencyLookup { readonly actorId: string; readonly conversationId: string; readonly idempotencyKey: string; }
export type MarkIdempotencyTerminal = IdempotencyLookup;
export type IdempotencyKeysetCursor = IdempotencyLookup & Readonly<{ createdAt: string }>;
export interface StoredIdempotency extends IdempotencyReservation { readonly runId?: string; readonly state: "reserved" | "admitted" | "terminal"; }
interface Row { actor_id:string; conversation_id:string; idempotency_key:string; request_hash:string; message_id:string; assistant_message_id:string; run_id:string|null; state:"reserved"|"admitted"|"terminal"; created_at:string; expires_at:string; }
const mapRow=(r:Row):StoredIdempotency=>({ actorId:r.actor_id, conversationId:r.conversation_id, idempotencyKey:r.idempotency_key, requestHash:r.request_hash,
  messageId:r.message_id, assistantMessageId:r.assistant_message_id, createdAt:r.created_at, expiresAt:r.expires_at, state:r.state,
  ...(r.run_id===null?{}:{runId:r.run_id}) });
export class IdempotencyRepository {
  reserve(connection: SqliteHandle, input: IdempotencyReservation): "created" | "replay" | "conflict" {
    const prior = connection.prepare("SELECT * FROM hermes_idempotency WHERE actor_id=:actorId AND conversation_id=:conversationId AND idempotency_key=:idempotencyKey")
      .get<Row>({ actorId:input.actorId, conversationId:input.conversationId, idempotencyKey:input.idempotencyKey });
    if (prior !== undefined) return prior.request_hash === input.requestHash ? "replay" : "conflict";
    const result = connection.prepare(
      "INSERT INTO hermes_idempotency(actor_id,conversation_id,idempotency_key,request_hash,message_id,assistant_message_id,state,created_at,expires_at) " +
      "SELECT :actorId,:conversationId,:idempotencyKey,:requestHash,:messageId,:assistantMessageId,'reserved',:createdAt,:expiresAt " +
      "WHERE EXISTS (SELECT 1 FROM hermes_conversations c WHERE c.id=:conversationId AND c.actor_id=:actorId) " +
      "AND EXISTS (SELECT 1 FROM hermes_messages m WHERE m.id=:messageId AND m.conversation_id=:conversationId) " +
      "AND EXISTS (SELECT 1 FROM hermes_messages m WHERE m.id=:assistantMessageId AND m.conversation_id=:conversationId)",
    ).run({ actorId:input.actorId,conversationId:input.conversationId,idempotencyKey:input.idempotencyKey,requestHash:input.requestHash,messageId:input.messageId,assistantMessageId:input.assistantMessageId,createdAt:input.createdAt,expiresAt:input.expiresAt });
    if (result.changes !== 1) fail("hermes_idempotency_resource_mismatch");
    return "created";
  }
  attachRun(connection: SqliteHandle, input: AttachRun): void {
    const result=connection.prepare("UPDATE hermes_idempotency SET run_id=:runId,state='admitted' WHERE actor_id=:actorId AND conversation_id=:conversationId AND idempotency_key=:idempotencyKey AND state='reserved'")
      .run({ actorId:input.actorId,conversationId:input.conversationId,idempotencyKey:input.idempotencyKey,runId:input.runId });
    if (result.changes!==1) fail("hermes_idempotency_state_conflict");
  }
  get(connection: SqliteHandle, input: IdempotencyLookup): StoredIdempotency|null {
    const row=connection.prepare("SELECT * FROM hermes_idempotency WHERE actor_id=:actorId AND conversation_id=:conversationId AND idempotency_key=:idempotencyKey")
      .get<Row>({ actorId:input.actorId,conversationId:input.conversationId,idempotencyKey:input.idempotencyKey });
    return row===undefined?null:mapRow(row);
  }
  markTerminalIfState(connection: SqliteHandle, input: MarkIdempotencyTerminal, expectedState:"reserved"|"admitted"): boolean {
    return connection.prepare("UPDATE hermes_idempotency SET state='terminal' WHERE actor_id=:actorId AND conversation_id=:conversationId AND idempotency_key=:idempotencyKey AND state=:expectedState")
      .run({...input,expectedState}).changes===1;
  }
  /**
   * Oldest-first page of records in one state, for bounded startup and background
   * reconciliation. `after` continues strictly past a prior record in the same
   * total order (keyset), so a rotating caller visits every record in turn.
   */
  listByState(connection: SqliteHandle, state: "reserved" | "admitted", limit: number, after?: IdempotencyKeysetCursor): readonly StoredIdempotency[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("hermes_idempotency_limit_invalid");
    const order = "ORDER BY created_at, actor_id, conversation_id, idempotency_key LIMIT :limit";
    if (after === undefined) {
      return connection.prepare("SELECT * FROM hermes_idempotency WHERE state=:state " + order).all<Row>({ state, limit }).map(mapRow);
    }
    return connection.prepare("SELECT * FROM hermes_idempotency WHERE state=:state AND " +
      "(created_at, actor_id, conversation_id, idempotency_key) > (:createdAt, :actorId, :conversationId, :idempotencyKey) " + order)
      .all<Row>({ state, limit, createdAt: after.createdAt, actorId: after.actorId, conversationId: after.conversationId, idempotencyKey: after.idempotencyKey })
      .map(mapRow);
  }
  /**
   * Purge expired records that are already terminal. A reserved or admitted record
   * is never removed: it is the only durable handle on its admission, and the
   * resume/reconcile workers own its lifetime until they terminalize it.
   */
  deleteExpired(connection: SqliteHandle, now: string): number {
    return connection.prepare("DELETE FROM hermes_idempotency WHERE state='terminal' AND expires_at<=:now").run({now}).changes;
  }
}
