import { Buffer } from "node:buffer";
import {
  DelegationListSchema,
  DelegationListQuerySchema,
  DelegationSchema,
  type Delegation,
  type DelegationList,
  type DelegationListQuery as ContractDelegationListQuery,
} from "@personal-intelligence-hub/contracts";
import type { SqliteHandle } from "../../foundation/database.js";
const fail=(code:string):never=>{throw new Error(code);};
const encode=(createdAt:string,id:string)=>Buffer.from(JSON.stringify({createdAt,id})).toString("base64url");
const decode=(cursor:string):{createdAt:string;id:string}=>{try{const x=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")) as {createdAt?:unknown;id?:unknown};if(typeof x.createdAt!=="string"||typeof x.id!=="string")throw new Error();return {createdAt:x.createdAt,id:x.id};}catch{return fail("hermes_cursor_invalid");}};
export interface DelegationReservation {
  readonly id:string; readonly actorId:string; readonly sourceAgentId:string; readonly targetAgentId:string;
  readonly sourceConversationId?:string; readonly upstreamSessionId:string; readonly upstreamRunId?:string;
  readonly idempotencyKey:string; readonly requestHash:string;
  readonly state:"queued"|"running"|"completed"|"failed"|"cancelled";
  readonly safeSummary?:string; readonly resultSummary?:string; readonly createdAt:string; readonly updatedAt:string; readonly completedAt?:string;
}
export interface DelegationTransition {
  readonly actorId:string; readonly id:string; readonly expectedState:DelegationReservation["state"];
  readonly state:DelegationReservation["state"]; readonly updatedAt:string;
  readonly completedAt?:string; readonly safeSummary?:string; readonly resultSummary?:string;
}
export type DelegationListQuery = ContractDelegationListQuery;
export interface StoredDelegation extends Delegation { readonly actorId:string; readonly upstreamSessionId:string; readonly idempotencyKey:string; readonly requestHash:string; readonly upstreamRunId?:string; }
interface Row {id:string;actor_id:string;source_agent_id:string;target_agent_id:string;source_conversation_id:string|null;upstream_session_id:string;upstream_run_id:string|null;idempotency_key:string;request_hash:string;state:Delegation["state"];safe_summary:string|null;result_summary:string|null;created_at:string;updated_at:string;completed_at:string|null;}
const map=(r:Row):StoredDelegation=>({
  ...DelegationSchema.parse({id:r.id,sourceAgentId:r.source_agent_id,targetAgentId:r.target_agent_id,sourceConversationId:r.source_conversation_id,state:r.state,...(r.safe_summary===null?{}:{safeSummary:r.safe_summary}),...(r.result_summary===null?{}:{resultSummary:r.result_summary}),createdAt:r.created_at,updatedAt:r.updated_at,...(r.completed_at===null?{}:{completedAt:r.completed_at})}),
  actorId:r.actor_id,upstreamSessionId:r.upstream_session_id,idempotencyKey:r.idempotency_key,requestHash:r.request_hash,...(r.upstream_run_id===null?{}:{upstreamRunId:r.upstream_run_id})
});
const columns="id,actor_id,source_agent_id,target_agent_id,source_conversation_id,upstream_session_id,upstream_run_id,idempotency_key,request_hash,state,safe_summary,result_summary,created_at,updated_at,completed_at";
export class DelegationRepository {
  reserve(connection:SqliteHandle,input:DelegationReservation):StoredDelegation {
    const result=connection.prepare(
      "INSERT INTO hermes_delegations(id,actor_id,source_agent_id,target_agent_id,source_conversation_id,upstream_session_id,upstream_run_id,idempotency_key,request_hash,state,safe_summary,result_summary,created_at,updated_at,completed_at) " +
      "SELECT :id,:actorId,:sourceAgentId,:targetAgentId,:sourceConversationId,:upstreamSessionId,:upstreamRunId,:idempotencyKey,:requestHash,:state,:safeSummary,:resultSummary,:createdAt,:updatedAt,:completedAt " +
      "WHERE :sourceConversationId IS NULL OR EXISTS (SELECT 1 FROM hermes_conversations WHERE id=:sourceConversationId AND actor_id=:actorId AND agent_id=:sourceAgentId)",
    ).run({...input,sourceConversationId:input.sourceConversationId??null,upstreamRunId:input.upstreamRunId??null,safeSummary:input.safeSummary??null,resultSummary:input.resultSummary??null,completedAt:input.completedAt??null});
    if(result.changes!==1)fail("hermes_delegation_conversation_not_found");
    return this.getOwned(connection,input.actorId,input.id)??fail("hermes_delegation_missing");
  }
  attachRun(connection:SqliteHandle,actorId:string,id:string,runId:string):void {
    const result=connection.prepare("UPDATE hermes_delegations SET upstream_run_id=:runId WHERE actor_id=:actorId AND id=:id AND state IN ('queued','running')").run({actorId,id,runId});
    if(result.changes!==1)fail("hermes_delegation_state_conflict");
  }
  transition(connection:SqliteHandle,input:DelegationTransition):void {
    const result=connection.prepare(
      "UPDATE hermes_delegations SET state=:state,updated_at=:updatedAt,completed_at=COALESCE(:completedAt,completed_at),safe_summary=COALESCE(:safeSummary,safe_summary),result_summary=COALESCE(:resultSummary,result_summary) " +
      "WHERE actor_id=:actorId AND id=:id AND state=:expectedState",
    ).run({...input,completedAt:input.completedAt??null,safeSummary:input.safeSummary??null,resultSummary:input.resultSummary??null});
    if(result.changes!==1)fail("hermes_delegation_state_conflict");
  }
  listOwned(connection:SqliteHandle,actorId:string,input:DelegationListQuery):DelegationList {
    const query=DelegationListQuerySchema.parse(input);const where=["actor_id=:actorId"];const params:Record<string,string|number>={actorId,limit:query.limit+1};
    if(query.sourceAgentId){where.push("source_agent_id=:sourceAgentId");params.sourceAgentId=query.sourceAgentId;}
    if(query.targetAgentId){where.push("target_agent_id=:targetAgentId");params.targetAgentId=query.targetAgentId;}
    if(query.sourceConversationId){where.push("source_conversation_id=:sourceConversationId");params.sourceConversationId=query.sourceConversationId;}
    if(query.state){where.push("state=:state");params.state=query.state;}
    if(query.cursor){const c=decode(query.cursor);where.push("(created_at<:cursorAt OR (created_at=:cursorAt AND id<:cursorId))");params.cursorAt=c.createdAt;params.cursorId=c.id;}
    const rows=connection.prepare("SELECT "+columns+" FROM hermes_delegations WHERE "+where.join(" AND ")+" ORDER BY created_at DESC,id DESC LIMIT :limit").all<Row>(params);
    const hasNextPage=rows.length>query.limit;const page=rows.slice(0,query.limit);
    return DelegationListSchema.parse({items:page.map((row)=>{const {actorId:_actorId,upstreamSessionId:_session,idempotencyKey:_key,requestHash:_hash,upstreamRunId:_run,...item}=map(row);return item;}),pageInfo:{hasNextPage,nextCursor:hasNextPage&&page.length?encode(page[page.length-1]!.created_at,page[page.length-1]!.id):null}}) as DelegationList;
  }
  getByIdempotency(connection:SqliteHandle,actorId:string,sourceAgentId:string,idempotencyKey:string):StoredDelegation|null {
    const row=connection.prepare("SELECT "+columns+" FROM hermes_delegations WHERE actor_id=:actorId AND source_agent_id=:sourceAgentId AND idempotency_key=:idempotencyKey").get<Row>({actorId,sourceAgentId,idempotencyKey});
    return row===undefined?null:map(row);
  }
  /** Oldest-first page of queued or running delegations for background reconciliation. */
  listOpen(connection:SqliteHandle,limit:number):readonly StoredDelegation[] {
    if(!Number.isInteger(limit)||limit<1||limit>500)fail("hermes_delegation_limit_invalid");
    return connection.prepare("SELECT "+columns+" FROM hermes_delegations WHERE state IN ('queued','running') ORDER BY created_at,id LIMIT :limit").all<Row>({limit}).map(map);
  }
  /** The owner's direct conversation in the source profile bound to an upstream session, if any. */
  findSourceConversation(connection:SqliteHandle,actorId:string,sourceAgentId:string,upstreamSessionId:string):string|null {
    const row=connection.prepare("SELECT id FROM hermes_conversations WHERE actor_id=:actorId AND agent_id=:sourceAgentId AND upstream_session_id=:upstreamSessionId AND provision_state='ready'").get<{id:string}>({actorId,sourceAgentId,upstreamSessionId});
    return row?.id??null;
  }
  getOwned(connection:SqliteHandle,actorId:string,id:string):StoredDelegation|null {
    const row=connection.prepare("SELECT "+columns+" FROM hermes_delegations WHERE actor_id=:actorId AND id=:id").get<Row>({actorId,id});
    return row===undefined?null:map(row);
  }
}
