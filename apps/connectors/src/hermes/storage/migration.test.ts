import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openConnectorDatabase, type ConnectorDatabase } from "../../foundation/database.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
const now = "2026-10-12T12:00:00.000Z";

const createDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-hermes-migration-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  return database;
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Hermes projection migration", () => {
  it("creates the required Hermes tables without provider credentials", async () => {
    const database = await createDatabase();
    const tables = await database.read((db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hermes_%' ORDER BY name")
        .all<{ name: string }>().map(({ name }) => name),
    );
    expect(tables).toEqual([
      "hermes_conversation_selection",
      "hermes_conversations",
      "hermes_delegations",
      "hermes_events",
      "hermes_idempotency",
      "hermes_messages",
      "hermes_profiles",
      "hermes_uploads",
    ]);
    const columns = await database.read((db) => tables.flatMap((table) =>
      db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>().map(({ name }) => name),
    ));
    expect(columns.join(" ")).not.toMatch(/api[_-]?key|bot[_-]?token|peer[_-]?token|provider[_-]?url/iu);
  });

  it("enforces role, direct conversation, profile, and JSON constraints", async () => {
    const database = await createDatabase();
    await database.transaction((db) => db.prepare(
      "INSERT INTO hermes_profiles(id, display_name, enabled, updated_at) VALUES('profile-fictional', 'Fictional', 1, :now)",
    ).run({ now }));
    await expect(database.write((db) => db.prepare(
      "INSERT INTO hermes_conversations(id, actor_id, agent_id, kind, title, provision_state, upstream_session_id, created_at, updated_at) " +
      "VALUES('conversation-invalid', 'actor-1', 'profile-fictional', 'group', 'Fictional', 'pending', 'session-invalid', :now, :now)",
    ).run({ now }))).rejects.toThrow();
    await expect(database.write((db) => db.prepare(
      "INSERT INTO hermes_messages(id, conversation_id, role, parts_json, delivery_state, created_at, updated_at) " +
      "VALUES('message-invalid', 'missing-conversation', 'user', '{bad-json', 'sending', :now, :now)",
    ).run({ now }))).rejects.toThrow();
  });

  it("allows only one main conversation for an actor and profile under concurrent reservations", async () => {
    const database = await createDatabase();
    await database.transaction((db) => db.prepare(
      "INSERT INTO hermes_profiles(id, display_name, enabled, updated_at) VALUES('profile-fictional', 'Fictional', 1, :now)",
    ).run({ now }));

    const reserve = (id: string) => database.transaction((db) => db.prepare(
      "INSERT INTO hermes_conversations(id, actor_id, agent_id, kind, title, is_main, provision_state, upstream_session_id, created_at, updated_at) " +
      "VALUES(:id, 'actor-1', 'profile-fictional', 'direct', 'Fictional', 1, 'pending', :session, :now, :now)",
    ).run({ id, session: `session-${id}`, now }));
    const results = await Promise.allSettled([reserve("conversation-a"), reserve("conversation-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("scopes delegation idempotency to actor and source profile", async () => {
    const database = await createDatabase();
    await database.transaction((db) => {
      db.prepare("INSERT INTO hermes_profiles(id, display_name, enabled, updated_at) VALUES('profile-fictional', 'Fictional', 1, :now)").run({ now });
      db.prepare("INSERT INTO hermes_profiles(id, display_name, enabled, updated_at) VALUES('profile-other', 'Other fictional', 1, :now)").run({ now });
    });
    const insertSql =
      "INSERT INTO hermes_delegations(id, actor_id, source_agent_id, target_agent_id, upstream_session_id, idempotency_key, request_hash, state, created_at, updated_at) " +
      "VALUES(:id, :actorId, :profileId, :profileId, :session, 'same-key', 'same-hash', 'queued', :now, :now)";
    await database.transaction((db) => {
      const insert = db.prepare(insertSql);
      insert.run({ id: "delegation-a", actorId: "actor-a", profileId: "profile-fictional", session: "session-a", now });
      insert.run({ id: "delegation-b", actorId: "actor-b", profileId: "profile-fictional", session: "session-b", now });
      insert.run({ id: "delegation-a-other-profile", actorId: "actor-a", profileId: "profile-other", session: "session-a-other", now });
    });
    await expect(database.write((db) => db.prepare(insertSql).run({
      id: "delegation-a-replay", actorId: "actor-a", profileId: "profile-fictional", session: "session-a-2", now,
    }))).rejects.toThrow();
  });

  it("enforces foreign keys for conversation-owned rows", async () => {
    const database = await createDatabase();
    await expect(database.write((db) => db.prepare(
      "INSERT INTO hermes_messages(id, conversation_id, role, parts_json, delivery_state, created_at, updated_at) " +
      "VALUES('message-orphan', 'missing-conversation', 'user', '[]', 'sending', :now, :now)",
    ).run({ now }))).rejects.toThrow();
  });
});
