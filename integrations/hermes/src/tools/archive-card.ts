import {
  CardSchema,
  UuidSchema,
  type Card,
} from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import type { HermesSecondBrainClient } from "../client.js";

export const ArchiveCardInputSchema = z.object({ cardId: UuidSchema }).strict();
export type ArchiveCardInput = z.infer<typeof ArchiveCardInputSchema>;

export const archiveCardTool = (client: HermesSecondBrainClient) => ({
  inputSchema: ArchiveCardInputSchema,
  execute: (input: ArchiveCardInput): Promise<Card> => {
    const parsed = ArchiveCardInputSchema.parse(input);
    return client.withEtag(`/v1/cards/${parsed.cardId}`, CardSchema, (etag) =>
      client.mutate({
        method: "PATCH",
        path: `/v1/cards/${parsed.cardId}`,
        body: { archived: true },
        ifMatch: etag,
        responseSchema: CardSchema,
      }),
    );
  },
});
