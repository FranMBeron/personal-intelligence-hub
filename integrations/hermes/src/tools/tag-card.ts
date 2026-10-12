import {
  CardSchema,
  CardTagMembershipSchema,
  UuidSchema,
  type CardTagMembership,
} from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import type { HermesSecondBrainClient } from "../client.js";

export const TagCardInputSchema = z
  .object({
    cardId: UuidSchema,
    tagId: UuidSchema,
    operation: z.enum(["add", "remove"]),
  })
  .strict();
export type TagCardInput = z.infer<typeof TagCardInputSchema>;

export const tagCardTool = (client: HermesSecondBrainClient) => ({
  inputSchema: TagCardInputSchema,
  execute: (input: TagCardInput): Promise<CardTagMembership> => {
    const parsed = TagCardInputSchema.parse(input);
    return client.withEtag(`/v1/cards/${parsed.cardId}`, CardSchema, (etag) =>
      client.mutate({
        method: parsed.operation === "add" ? "PUT" : "DELETE",
        path: `/v1/cards/${parsed.cardId}/tags/${parsed.tagId}`,
        ...(parsed.operation === "add" ? { body: {} } : {}),
        ifMatch: etag,
        responseSchema: CardTagMembershipSchema,
      }),
    );
  },
});
