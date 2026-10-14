import type { HermesSecondBrainClient } from "../client.js";
import { archiveCardTool } from "./archive-card.js";
import { createCardTool } from "./create-card.js";
import { createTaskTool } from "./create-task.js";
import { linkCardTool } from "./link-card.js";
import { moveCardTool } from "./move-card.js";
import { tagCardTool } from "./tag-card.js";

export const createHermesTools = (client: HermesSecondBrainClient) => ({
  createCard: createCardTool(client),
  moveCard: moveCardTool(client),
  tagCard: tagCardTool(client),
  linkCard: linkCardTool(client),
  archiveCard: archiveCardTool(client),
  createTask: createTaskTool(client),
});

export * from "./archive-card.js";
export * from "./create-card.js";
export * from "./create-task.js";
export * from "./link-card.js";
export * from "./move-card.js";
export * from "./tag-card.js";
// Deliberately not part of createHermesTools: delegation is a separate, Central-only capability
// (createCentralDelegationTool) that must never reach a specialist's tool set.
export * from "./delegate-agent.js";
