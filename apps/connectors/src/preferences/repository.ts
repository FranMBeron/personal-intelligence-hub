import type { UserPreferences } from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase, SqliteHandle } from "../foundation/database.js";

export class PreferencesVersionConflict extends Error {
  readonly code = "version_conflict";

  constructor() {
    super("Preference version conflict");
    this.name = "PreferencesVersionConflict";
  }
}

export interface PreferencesRepository {
  get(actorId: string, defaultTimeZone: string): Promise<UserPreferences>;
  update(input: {
    actorId: string;
    timeZone: string;
    expectedVersion: number;
  }): Promise<UserPreferences>;
}

type PreferenceRow = Readonly<{ time_zone: string; version: number }>;

const selectPreference = (db: SqliteHandle, actorId: string): PreferenceRow | undefined =>
  db.prepare("SELECT time_zone, version FROM user_preferences WHERE actor_id = :actorId")
    .get<PreferenceRow>({ actorId });

export const createPreferencesRepository = (
  database: ConnectorDatabase,
): PreferencesRepository => ({
  async get(actorId, defaultTimeZone) {
    return database.read((db) => {
      const row = selectPreference(db, actorId);
      return row === undefined
        ? { timeZone: defaultTimeZone, version: 1 }
        : { timeZone: row.time_zone, version: row.version };
    });
  },

  async update({ actorId, timeZone, expectedVersion }) {
    return database.transaction((db) => {
      const current = selectPreference(db, actorId);
      const now = new Date().toISOString();

      if (current === undefined) {
        if (expectedVersion !== 1) throw new PreferencesVersionConflict();
        const result = db.prepare(
          "INSERT INTO user_preferences(actor_id,time_zone,version,created_at,updated_at) " +
            "VALUES(:actorId,:timeZone,2,:now,:now) ON CONFLICT(actor_id) DO NOTHING",
        ).run({ actorId, timeZone, now });
        if (result.changes !== 1) throw new PreferencesVersionConflict();
        return { timeZone, version: 2 };
      }

      const result = db.prepare(
        "UPDATE user_preferences SET time_zone = :timeZone, version = version + 1, updated_at = :now " +
          "WHERE actor_id = :actorId AND version = :expectedVersion",
      ).run({ actorId, timeZone, now, expectedVersion });
      if (result.changes !== 1) throw new PreferencesVersionConflict();
      return { timeZone, version: expectedVersion + 1 };
    });
  },
});
