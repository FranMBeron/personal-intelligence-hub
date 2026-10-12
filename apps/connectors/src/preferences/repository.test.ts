import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openConnectorDatabase, type ConnectorDatabase } from "../foundation/database.js";
import { createPreferencesRepository } from "./repository.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
const actorId = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";
const defaultTimeZone = "America/Argentina/Buenos_Aires";

const createRepository = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-preferences-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  return { database, repository: createPreferencesRepository(database) };
};

describe("preferences repository", () => {
  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("returns the installation default without inserting a preference row", async () => {
    const { database, repository } = await createRepository();

    await expect(repository.get(actorId, defaultTimeZone)).resolves.toEqual({
      timeZone: defaultTimeZone,
      version: 1,
    });
    await expect(database.read((db) => db.prepare("SELECT count(*) AS count FROM user_preferences").get<{ count: number }>()?.count)).resolves.toBe(0);
  });

  it("creates the first override at version two", async () => {
    const { repository } = await createRepository();

    await expect(repository.update({ actorId, timeZone: "America/New_York", expectedVersion: 1 })).resolves.toEqual({
      timeZone: "America/New_York",
      version: 2,
    });
  });

  it("rejects a stale update without changing the current override", async () => {
    const { repository } = await createRepository();
    await repository.update({ actorId, timeZone: "America/New_York", expectedVersion: 1 });

    await expect(repository.update({ actorId, timeZone: "UTC", expectedVersion: 1 })).rejects.toMatchObject({ code: "version_conflict" });
    await expect(repository.get(actorId, defaultTimeZone)).resolves.toEqual({
      timeZone: "America/New_York",
      version: 2,
    });
  });

  it("increments the version for a matching existing override", async () => {
    const { repository } = await createRepository();
    await repository.update({ actorId, timeZone: "America/New_York", expectedVersion: 1 });

    await expect(repository.update({ actorId, timeZone: "Etc/UTC", expectedVersion: 2 })).resolves.toEqual({
      timeZone: "Etc/UTC",
      version: 3,
    });
  });

  it("allows exactly one concurrent first override", async () => {
    const { repository } = await createRepository();

    const results = await Promise.allSettled([
      repository.update({ actorId, timeZone: "America/New_York", expectedVersion: 1 }),
      repository.update({ actorId, timeZone: "Etc/UTC", expectedVersion: 1 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(repository.get(actorId, defaultTimeZone)).resolves.toMatchObject({ version: 2 });
  });
  it("rejects a first override with a version other than one", async () => {
    const { repository } = await createRepository();

    await expect(repository.update({ actorId, timeZone: "UTC", expectedVersion: 2 })).rejects.toMatchObject({ code: "version_conflict" });
    await expect(repository.get(actorId, defaultTimeZone)).resolves.toEqual({ timeZone: defaultTimeZone, version: 1 });
  });

  it("keeps created_at stable and advances updated_at on override changes", async () => {
    const { database, repository } = await createRepository();
    await repository.update({ actorId, timeZone: "America/New_York", expectedVersion: 1 });
    const created = await database.read((db) => db.prepare("SELECT created_at, updated_at FROM user_preferences WHERE actor_id = :actorId").get<{ created_at: string; updated_at: string }>({ actorId }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    await repository.update({ actorId, timeZone: "Etc/UTC", expectedVersion: 2 });
    const updated = await database.read((db) => db.prepare("SELECT created_at, updated_at FROM user_preferences WHERE actor_id = :actorId").get<{ created_at: string; updated_at: string }>({ actorId }));

    expect(updated?.created_at).toBe(created?.created_at);
    expect(Date.parse(updated!.updated_at)).toBeGreaterThan(Date.parse(created!.updated_at));
  });

  it("propagates a closed database error from reads", async () => {
    const { database, repository } = await createRepository();
    await database.close();

    await expect(repository.get(actorId, defaultTimeZone)).rejects.toThrow("Connector database is closed");
  });

});
