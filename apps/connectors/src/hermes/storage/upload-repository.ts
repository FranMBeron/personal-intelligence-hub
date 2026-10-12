import type { SqliteHandle } from "../../foundation/database.js";
const fail=(code:string):never=>{throw new Error(code);};
export interface StoredUpload {
  readonly reference:string; readonly actorId:string; readonly conversationId:string; readonly originalName:string;
  readonly mimeType:string; readonly sizeBytes:number; readonly storagePath:string; readonly expiresAt:string;
  readonly claimedByAdmission?:string; readonly consumedAt?:string;
}
export interface ClaimOwnedUploads { readonly actorId:string; readonly conversationId:string; readonly references:readonly string[]; readonly admissionId:string; readonly now:string; }
export interface ClaimedUploadLookup { readonly actorId:string; readonly conversationId:string; readonly reference:string; readonly admissionId:string; readonly now:string; }
export interface ConsumeClaimedUploads extends ClaimOwnedUploads { readonly consumedAt:string; }
interface Row { reference:string; actor_id:string; conversation_id:string; original_name:string; mime_type:string; size_bytes:number; storage_path:string; expires_at:string; claimed_by_admission:string|null; consumed_at:string|null; }
const mapRow=(r:Row):StoredUpload=>({reference:r.reference,actorId:r.actor_id,conversationId:r.conversation_id,originalName:r.original_name,mimeType:r.mime_type,sizeBytes:r.size_bytes,storagePath:r.storage_path,expiresAt:r.expires_at,...(r.claimed_by_admission===null?{}:{claimedByAdmission:r.claimed_by_admission}),...(r.consumed_at===null?{}:{consumedAt:r.consumed_at})});
const uploadColumns="reference,actor_id,conversation_id,original_name,mime_type,size_bytes,storage_path,expires_at,claimed_by_admission,consumed_at";
export class UploadRepository {
  insert(connection:SqliteHandle,upload:StoredUpload):void {
    const result=connection.prepare(
      "INSERT INTO hermes_uploads(reference,actor_id,conversation_id,original_name,mime_type,size_bytes,storage_path,expires_at) " +
      "SELECT :reference,:actorId,:conversationId,:originalName,:mimeType,:sizeBytes,:storagePath,:expiresAt WHERE EXISTS " +
      "(SELECT 1 FROM hermes_conversations WHERE id=:conversationId AND actor_id=:actorId)",
    ).run({reference:upload.reference,actorId:upload.actorId,conversationId:upload.conversationId,originalName:upload.originalName,mimeType:upload.mimeType,sizeBytes:upload.sizeBytes,storagePath:upload.storagePath,expiresAt:upload.expiresAt});
    if(result.changes!==1) fail("hermes_upload_conversation_not_found");
  }
  claimMany(connection:SqliteHandle,input:ClaimOwnedUploads):readonly StoredUpload[] {
    if(new Set(input.references).size!==input.references.length) fail("hermes_upload_reference_invalid");
    const records:StoredUpload[]=[];
    for(const reference of input.references) {
      const row=connection.prepare("SELECT "+uploadColumns+" FROM hermes_uploads WHERE reference=:reference AND actor_id=:actorId AND conversation_id=:conversationId AND expires_at>:now AND consumed_at IS NULL")
        .get<Row>({reference,actorId:input.actorId,conversationId:input.conversationId,now:input.now});
      if(row===undefined || (row.claimed_by_admission!==null && row.claimed_by_admission!==input.admissionId)) return fail("hermes_upload_unavailable");
      const result=connection.prepare("UPDATE hermes_uploads SET claimed_by_admission=:admissionId WHERE reference=:reference AND actor_id=:actorId AND conversation_id=:conversationId AND expires_at>:now AND consumed_at IS NULL AND (claimed_by_admission IS NULL OR claimed_by_admission=:admissionId)")
        .run({reference,actorId:input.actorId,conversationId:input.conversationId,now:input.now,admissionId:input.admissionId});
      if(result.changes!==1) fail("hermes_upload_unavailable");
      records.push(mapRow({...row,claimed_by_admission:input.admissionId}));
    }
    return records;
  }
  requireClaimed(connection:SqliteHandle,input:ClaimedUploadLookup):StoredUpload {
    const row=connection.prepare("SELECT "+uploadColumns+" FROM hermes_uploads WHERE reference=:reference AND actor_id=:actorId AND conversation_id=:conversationId AND claimed_by_admission=:admissionId AND consumed_at IS NULL AND expires_at>:now")
      .get<Row>({reference:input.reference,actorId:input.actorId,conversationId:input.conversationId,admissionId:input.admissionId,now:input.now});
    return row===undefined?fail("hermes_upload_unavailable"):mapRow(row);
  }
  consumeClaimed(connection:SqliteHandle,input:ConsumeClaimedUploads):void {
    for(const reference of input.references) {
      const result=connection.prepare("UPDATE hermes_uploads SET consumed_at=:consumedAt WHERE reference=:reference AND actor_id=:actorId AND conversation_id=:conversationId AND claimed_by_admission=:admissionId AND consumed_at IS NULL AND expires_at>:now")
        .run({reference,actorId:input.actorId,conversationId:input.conversationId,now:input.now,admissionId:input.admissionId,consumedAt:input.consumedAt});
      if(result.changes!==1) fail("hermes_upload_unavailable");
    }
  }
  deleteExpired(connection:SqliteHandle,now:string):readonly string[] {
    const paths=connection.prepare("SELECT storage_path FROM hermes_uploads WHERE expires_at<=:now").all<{storage_path:string}>({now}).map(({storage_path})=>storage_path);
    connection.prepare("DELETE FROM hermes_uploads WHERE expires_at<=:now").run({now});
    return paths;
  }
}
