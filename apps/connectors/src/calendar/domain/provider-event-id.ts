import { createHash } from "node:crypto";

/**
 * Google event id for a create proposal: "pih" plus the first 48 lowercase hex characters of
 * SHA-256 over the local proposal id. Every character is in Google's base32hex alphabet, and the
 * id is reproducible, so an ambiguous create can be looked up instead of being repeated.
 */
export const providerEventIdForProposal = (proposalId: string): string => {
  if (typeof proposalId !== "string" || proposalId.length === 0) throw new Error("calendar_proposal_id_invalid");
  return "pih" + createHash("sha256").update(proposalId, "utf8").digest("hex").slice(0, 48);
};
