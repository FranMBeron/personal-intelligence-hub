import {
  CardSchema,
  PositionSchema,
  UuidSchema,
  type Card,
} from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import type { HermesSecondBrainClient } from "../client.js";

export const MoveCardInputSchema = z
  .object({
    cardId: UuidSchema,
    columnId: UuidSchema,
    position: PositionSchema,
  })
  .strict();
export type MoveCardInput = z.infer<typeof MoveCardInputSchema>;

export const moveCardTool = (client: HermesSecondBrainClient) => ({
  inputSchema: MoveCardInputSchema,
  execute: (input: MoveCardInput): Promise<Card> => {
    const parsed = MoveCardInputSchema.parse(input);
    return client.withEtag(`/v1/cards/${parsed.cardId}`, CardSchema, (etag) =>
      client.mutate({
        method: "PATCH",
        path: `/v1/cards/${parsed.cardId}`,
        body: { columnId: parsed.columnId, position: parsed.position },
        ifMatch: etag,
        responseSchema: CardSchema,
      }),
    );
  },
});
