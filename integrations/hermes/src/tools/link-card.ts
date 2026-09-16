import {
  CreateRelationBodySchema,
  RelationSchema,
  type CreateRelationBody,
  type Relation,
} from "@personal-intelligence-hub/contracts";

import type { HermesSecondBrainClient } from "../client.js";

export const linkCardTool = (client: HermesSecondBrainClient) => ({
  inputSchema: CreateRelationBodySchema,
  execute: (input: CreateRelationBody): Promise<Relation> =>
    client.mutate({
      method: "POST",
      path: "/v1/relations",
      body: CreateRelationBodySchema.parse(input),
      responseSchema: RelationSchema,
    }),
});
