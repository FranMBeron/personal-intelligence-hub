import {
  CardSchema,
  CreateRelationBodySchema,
  RelationSchema,
  type CreateRelationBody,
  type Relation,
} from "@personal-intelligence-hub/contracts";

import type { HermesSecondBrainClient } from "../client.js";

export const linkCardTool = (client: HermesSecondBrainClient) => ({
  inputSchema: CreateRelationBodySchema,
  execute: (input: CreateRelationBody): Promise<Relation> =>
    client.withEtag(
      `/v1/cards/${input.fromCardId}`,
      CardSchema,
      (ifMatch) =>
        client.mutate({
          method: "POST",
          path: "/v1/relations",
          body: CreateRelationBodySchema.parse(input),
          responseSchema: RelationSchema,
          ifMatch,
        }),
    ),
});
