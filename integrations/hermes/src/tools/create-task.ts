import {
  CreateTaskBodySchema,
  TaskSchema,
  type CreateTaskBody,
  type Task,
} from "@personal-intelligence-hub/contracts";

import type { HermesSecondBrainClient } from "../client.js";

export const createTaskTool = (client: HermesSecondBrainClient) => ({
  inputSchema: CreateTaskBodySchema,
  execute: (input: CreateTaskBody): Promise<Task> =>
    client.mutate({
      method: "POST",
      path: "/v1/tasks",
      body: CreateTaskBodySchema.parse(input),
      responseSchema: TaskSchema,
    }),
});
