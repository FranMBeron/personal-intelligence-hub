import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { providerEventIdForProposal } from "./provider-event-id.js";

describe("deterministic provider event id", () => {
  it("derives pih plus the first 48 hex characters of SHA-256 over the proposal id", () => {
    const proposalId = "00000000-0000-4000-8000-0000000000aa";
    const expected = "pih" + createHash("sha256").update(proposalId, "utf8").digest("hex").slice(0, 48);
    expect(providerEventIdForProposal(proposalId)).toBe(expected);
    expect(providerEventIdForProposal(proposalId)).toBe(providerEventIdForProposal(proposalId));
  });

  it("satisfies Google's base32hex event id constraints and differs per proposal", () => {
    const first = providerEventIdForProposal("00000000-0000-4000-8000-0000000000aa");
    expect(first).toMatch(/^[a-v0-9]{5,1024}$/u);
    expect(first).toHaveLength(51);
    expect(providerEventIdForProposal("00000000-0000-4000-8000-0000000000ab")).not.toBe(first);
  });

  it("rejects an empty proposal id", () => {
    expect(() => providerEventIdForProposal("")).toThrow("calendar_proposal_id_invalid");
  });
});
