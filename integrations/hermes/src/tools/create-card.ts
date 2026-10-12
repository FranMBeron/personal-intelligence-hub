import {
  CardSchema,
  CreateCardBodySchema,
  type Card,
  type CreateCardBody,
} from "@personal-intelligence-hub/contracts";

import type { HermesSecondBrainClient } from "../client.js";

export const createCardTool = (client: HermesSecondBrainClient) => ({
  inputSchema: CreateCardBodySchema,
  execute: (input: CreateCardBody): Promise<Card> =>
    client.mutate({
      method: "POST",
      path: "/v1/cards",
      body: CreateCardBodySchema.parse(input),
      responseSchema: CardSchema,
    }),
});
