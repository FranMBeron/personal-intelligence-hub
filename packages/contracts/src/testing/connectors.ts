import {
  AgentSummarySchema,
  ConversationSchema,
  ConversationSelectionSchema,
  DelegationSchema,
  MessageSchema,
  type AgentSummary,
  type Conversation,
  type ConversationSelection,
  type Delegation,
  type Message,
} from "../hermes.js";
import {
  CalendarAgendaSchema,
  CalendarChangeProposalSchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  type CalendarAgenda,
  type CalendarChangeProposal,
  type CalendarSelection,
  type CalendarSourceStatus,
} from "../calendar.js";
import {
  SourceStatusSchema,
  type SourceStatus,
} from "../connectors.js";
import {
  UserPreferencesSchema,
  type UserPreferences,
} from "../preferences.js";

const fixtureTime = "2026-10-12T12:00:00.000Z";

export const sourceStatusFixture = (
  overrides: Partial<SourceStatus> = {},
): SourceStatus => SourceStatusSchema.parse({
  id: "fictional-source",
  state: "available",
  checkedAt: fixtureTime,
  lastSuccessAt: fixtureTime,
  stale: false,
  capabilities: [],
  ...overrides,
});

export const preferencesFixture = (
  overrides: Partial<UserPreferences> = {},
): UserPreferences => UserPreferencesSchema.parse({
  timeZone: "Etc/UTC",
  version: 1,
  ...overrides,
});

export const conversationFixture = (
  overrides: Partial<Conversation> = {},
): Conversation => ConversationSchema.parse({
  id: "fictional-conversation",
  agentId: "fictional-agent",
  kind: "direct",
  title: "Fictional conversation",
  archived: false,
  isMain: true,
  version: 1,
  createdAt: fixtureTime,
  updatedAt: fixtureTime,
  ...overrides,
});

export const messageFixture = (
  overrides: Partial<Message> = {},
): Message => MessageSchema.parse({
  id: "fictional-message",
  conversationId: "fictional-conversation",
  role: "assistant",
  parts: [{ kind: "text", text: "Fictional message" }],
  deliveryState: "completed",
  createdAt: fixtureTime,
  ...overrides,
});

export const selectionFixture = (
  overrides: Partial<ConversationSelection> = {},
): ConversationSelection => ConversationSelectionSchema.parse({
  agentId: "fictional-agent",
  conversationId: "fictional-conversation",
  version: 1,
  updatedAt: fixtureTime,
  ...overrides,
});

export const agentFixture = (
  overrides: Partial<AgentSummary> = {},
): AgentSummary => AgentSummarySchema.parse({
  id: "fictional-agent",
  displayName: "Fictional Agent",
  availability: "online",
  execution: "idle",
  result: "none",
  attention: "none",
  checkedAt: fixtureTime,
  ...overrides,
});

export const delegationFixture = (
  overrides: Partial<Delegation> = {},
): Delegation => DelegationSchema.parse({
  id: "fictional-delegation",
  sourceAgentId: "fictional-agent",
  targetAgentId: "fictional-specialist",
  sourceConversationId: "fictional-conversation",
  state: "completed",
  safeSummary: "Fictional delegated task",
  resultSummary: "Fictional result",
  createdAt: fixtureTime,
  updatedAt: fixtureTime,
  completedAt: fixtureTime,
  ...overrides,
});

export const calendarStatusFixture = (
  overrides: Partial<CalendarSourceStatus> = {},
): CalendarSourceStatus => CalendarSourceStatusSchema.parse({
  state: "not_configured",
  checkedAt: fixtureTime,
  stale: false,
  canRead: false,
  canProposeChanges: false,
  primaryCalendarConfigured: false,
  additionalCalendarCount: 0,
  ...overrides,
});

export const calendarSelectionFixture = (
  overrides: Partial<CalendarSelection> = {},
): CalendarSelection => CalendarSelectionSchema.parse({
  version: 0,
  items: [],
  ...overrides,
});

export const agendaFixture = (
  overrides: Partial<CalendarAgenda> = {},
): CalendarAgenda => CalendarAgendaSchema.parse({
  timeZone: "Etc/UTC",
  from: "2026-10-12T00:00:00.000Z",
  to: "2026-10-13T00:00:00.000Z",
  generatedAt: fixtureTime,
  items: [],
  ...overrides,
});

export const proposalFixture = (
  overrides: Partial<CalendarChangeProposal> = {},
): CalendarChangeProposal => CalendarChangeProposalSchema.parse({
  id: "fictional-proposal",
  version: 0,
  status: "pending",
  summary: {
    operation: "create",
    calendarDisplayName: "Fictional calendar",
    timeZone: "Etc/UTC",
    recurrenceScope: "single",
    organizerRelationship: "self",
    guestNotification: "none",
  },
  createdAt: "2026-10-12T11:00:00.000Z",
  expiresAt: "2026-10-12T13:00:00.000Z",
  ...overrides,
});
