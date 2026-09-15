import type { CardTagMembership } from "@personal-intelligence-hub/contracts";
import type { PoolClient } from "pg";

import { getCard } from "./cards.js";
import { RepositoryError } from "./types.js";

export const getCardTagMembership = async (
  client: PoolClient,
  cardId: string,
  tagId: string,
): Promise<CardTagMembership> => {
  const card = await getCard(client, cardId);
  if (card === null) throw new RepositoryError("not_found");
  return { cardId, tagId, cardVersion: card.version, tags: card.tags };
};
