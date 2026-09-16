import {
  PostgresUnitOfWork,
  createDatabaseClient,
  createPostgresQueryPorts,
} from "@personal-intelligence-hub/database";

import { createServer, listen } from "./server.js";
import { loadPrivateConfig } from "./config/private.js";
import { EventBus } from "./events/event-bus.js";
import {
  OutboxDispatcher,
  PostgresOutboxStore,
} from "./events/outbox-dispatcher.js";

const main = async (): Promise<void> => {
  const config = loadPrivateConfig();
  const database = createDatabaseClient({ connectionString: config.databaseUrl });
  const unitOfWork = new PostgresUnitOfWork(database.pool);
  const eventBus = new EventBus();
  const outboxStore = new PostgresOutboxStore(database.pool, {
    retentionDays: config.outboxRetentionDays,
  });
  const dispatcher = new OutboxDispatcher(outboxStore, eventBus);
  const app = createServer(config, {
    unitOfWork,
    queries: createPostgresQueryPorts(unitOfWork),
    readinessCheck: async () => {
      await database.pool.query("SELECT 1");
      return { status: "ready" };
    },
    publicConfig: {
      apiVersion: "v1",
      productName: "Personal Intelligence Hub",
      publicOidcIssuer: config.oidcIssuer,
      enabledUiCapabilities: ["second-brain"],
    },
    synchronization: { eventBus, outboxStore },
  });

  const dispatchTimer = setInterval(() => {
    void dispatcher.runOnce().catch(() => undefined);
  }, 1_000);
  dispatchTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(dispatchTimer);
    await database.close();
  });

  const shutdown = (): void => {
    void app.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await listen(app, config);
  await dispatcher.runOnce();
};

void main().catch(() => {
  process.stderr.write("Personal Intelligence Hub API failed to start.\n");
  process.exitCode = 1;
});
