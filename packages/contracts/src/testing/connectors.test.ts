import { describe, expect, it } from "vitest";

import * as productionContracts from "../index.js";
import {
  AgentSummarySchema,
  ConversationSchema,
  ConversationSelectionSchema,
  DelegationSchema,
  MessageSchema,
} from "../hermes.js";
import {
  CalendarAgendaSchema,
  CalendarChangeProposalSchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
} from "../calendar.js";
import { SourceStatusSchema } from "../connectors.js";
import { UserPreferencesSchema } from "../preferences.js";
import {
  agendaFixture,
  agentFixture,
  calendarSelectionFixture,
  calendarStatusFixture,
  conversationFixture,
  delegationFixture,
  messageFixture,
  preferencesFixture,
  proposalFixture,
  selectionFixture,
  sourceStatusFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";

describe("private connector fixtures", () => {
  it("keeps existing schema-valid fictional fixtures only from the testing subpath", () => {
    expect(SourceStatusSchema.parse(sourceStatusFixture()).id).toBe("fictional-source");
    expect(UserPreferencesSchema.parse(preferencesFixture()).version).toBe(1);
    expect(productionContracts).not.toHaveProperty("sourceStatusFixture");
    expect(productionContracts).not.toHaveProperty("preferencesFixture");
  });

  it("provides schema-parsed Hermes fixtures with typed overrides", () => {
    expect(ConversationSchema.parse(conversationFixture())).toMatchObject({
      id: "fictional-conversation",
      kind: "direct",
      agentId: "fictional-agent",
    });
    expect(conversationFixture({ archived: true })).toMatchObject({ archived: true });
    expect(MessageSchema.parse(messageFixture())).toMatchObject({
      conversationId: "fictional-conversation",
      role: "assistant",
    });
    expect(ConversationSelectionSchema.parse(selectionFixture())).toMatchObject({
      agentId: "fictional-agent",
      conversationId: "fictional-conversation",
    });
    expect(() => selectionFixture({ version: -1 })).toThrow();
    expect(() => selectionFixture({ providerPayload: "private" } as never)).toThrow();
    expect(() => messageFixture({ parts: [] })).toThrow();
    expect(() => messageFixture({ upstreamRunId: "private" } as never)).toThrow();
    expect(AgentSummarySchema.parse(agentFixture())).toMatchObject({ id: "fictional-agent" });
    expect(DelegationSchema.parse(delegationFixture())).toMatchObject({
      sourceAgentId: "fictional-agent",
      targetAgentId: "fictional-specialist",
    });
  });

  it("provides schema-parsed Calendar fixtures with typed overrides", () => {
    expect(CalendarSourceStatusSchema.parse(calendarStatusFixture())).toMatchObject({
      state: "not_configured",
      canRead: false,
    });
    expect(CalendarSelectionSchema.parse(calendarSelectionFixture())).toEqual({ version: 0, items: [] });
    expect(calendarSelectionFixture({ version: 2 })).toMatchObject({ version: 2 });
    expect(() => calendarSelectionFixture({ version: -1 })).toThrow();
    expect(() => calendarSelectionFixture({ providerPayload: "private" } as never)).toThrow();
    expect(CalendarAgendaSchema.parse(agendaFixture())).toMatchObject({
      timeZone: "Etc/UTC",
      items: [],
    });
    expect(CalendarChangeProposalSchema.parse(proposalFixture())).toMatchObject({
      id: "fictional-proposal",
      status: "pending",
    });
    expect(() => proposalFixture({ version: -1 })).toThrow();
    expect(() => proposalFixture({ connectorToken: "private" } as never)).toThrow();
  });

  it("keeps every fixture out of production exports", () => {
    for (const fixtureName of [
      "conversationFixture",
      "messageFixture",
      "selectionFixture",
      "agentFixture",
      "delegationFixture",
      "calendarStatusFixture",
      "calendarSelectionFixture",
      "agendaFixture",
      "proposalFixture",
    ]) {
      expect(productionContracts).not.toHaveProperty(fixtureName);
    }
  });
});
