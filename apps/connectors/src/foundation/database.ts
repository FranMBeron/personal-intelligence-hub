import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import {
  backup,
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import {
  applyMigrationToHandle,
  loadMigrations,
  pendingMigrations,
} from "./migrations.js";

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  run(parameters?: Readonly<Record<string, SqlValue>>): Readonly<{
    changes: number;
    lastInsertRowid: number | bigint;
  }>;
  get<T>(parameters?: Readonly<Record<string, SqlValue>>): T | undefined;
  all<T>(parameters?: Readonly<Record<string, SqlValue>>): readonly T[];
}

export interface SqliteHandle {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
}

export interface ConnectorDatabase {
  read<T>(fn: (db: SqliteHandle) => T): Promise<T>;
  write<T>(fn: (db: SqliteHandle) => T): Promise<T>;
  transaction<T>(fn: (db: SqliteHandle) => T): Promise<T>;
  backupTo(destinationPath: string): Promise<void>;
  close(): Promise<void>;
}

const closedError = (): Error => new Error("Connector database is closed");
const nestedError = (): Error =>
  new Error("nested database write or transaction is not allowed");
const expiredError = (): Error => new Error("database callback handle has expired");
const readOnlyError = (): Error =>
  new Error("read callbacks allow read-only SQL statements");

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" && value !== null) ||
  typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;

const immutableRow = <T>(row: Record<string, unknown> | undefined): T | undefined => {
  if (row === undefined) return undefined;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    copy[key] = value instanceof Uint8Array ? Uint8Array.from(value) : value;
  }
  return Object.freeze(copy) as T;
};

const bindParameters = (
  parameters: Readonly<Record<string, SqlValue>> | undefined,
): Record<string, SQLInputValue> | undefined => {
  if (parameters === undefined) return undefined;
  if (
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    throw new TypeError("SQL parameters must be a named parameter object");
  }

  const bound: Record<string, SQLInputValue> = Object.create(null) as Record<
    string,
    SQLInputValue
  >;
  for (const [key, value] of Object.entries(parameters)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "bigint" &&
      !(value instanceof Uint8Array)
    ) {
      throw new TypeError("Invalid SQL value for parameter " + key);
    }
    bound[key] = value instanceof Uint8Array ? Uint8Array.from(value) : value;
  }
  return bound;
};

const callStatement = <T>(
  parameters: Readonly<Record<string, SqlValue>> | undefined,
  withoutParameters: () => T,
  withParameters: (bound: Record<string, SQLInputValue>) => T,
): T => {
  const bound = bindParameters(parameters);
  return bound === undefined ? withoutParameters() : withParameters(bound);
};

const assertReadStatement = (sql: string): void => {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\r\n]*/gu, " ")
    .trim();
  const firstToken = /^([A-Za-z]+)/u.exec(withoutComments)?.[1]?.toUpperCase();
  if (firstToken === "SELECT" || firstToken === "WITH") return;
  if (
    firstToken === "PRAGMA" &&
    /^PRAGMA\s+[A-Za-z_][A-Za-z_0-9]*(?:\s*\([^;]*\))?\s*;?$/iu.test(
      withoutComments,
    )
  ) {
    return;
  }
  throw readOnlyError();
};

type CallbackScope = { active: boolean; readOnly: boolean };

const assertScope = (scope: CallbackScope): void => {
  if (!scope.active) throw expiredError();
};

const wrapStatement = (
  statement: StatementSync,
  sql: string,
  scope: CallbackScope,
): SqlStatement =>
  Object.freeze({
    run(parameters?: Readonly<Record<string, SqlValue>>) {
      assertScope(scope);
      if (scope.readOnly) assertReadStatement(sql);
      const result = callStatement(
        parameters,
        () => statement.run(),
        (bound) => statement.run(bound),
      );
      return Object.freeze({
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      });
    },
    get<T>(parameters?: Readonly<Record<string, SqlValue>>): T | undefined {
      assertScope(scope);
      if (scope.readOnly) assertReadStatement(sql);
      const row = callStatement(
        parameters,
        () => statement.get(),
        (bound) => statement.get(bound),
      );
      return immutableRow<T>(row);
    },
    all<T>(parameters?: Readonly<Record<string, SqlValue>>): readonly T[] {
      assertScope(scope);
      if (scope.readOnly) assertReadStatement(sql);
      const rows = callStatement(
        parameters,
        () => statement.all(),
        (bound) => statement.all(bound),
      );
      return Object.freeze(rows.map((row) => immutableRow<T>(row) as T));
    },
  });

const wrapHandle = (database: DatabaseSync, scope: CallbackScope): SqliteHandle =>
  Object.freeze({
    prepare(sql: string): SqlStatement {
      assertScope(scope);
      if (scope.readOnly) assertReadStatement(sql);
      return wrapStatement(database.prepare(sql), sql, scope);
    },
    exec(sql: string): void {
      assertScope(scope);
      if (scope.readOnly) throw readOnlyError();
      database.exec(sql);
    },
  });

const safeDatabaseDescriptor = (databasePath: string): number => {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let pathBeforeOpen: ReturnType<typeof lstatSync> | undefined;
  try {
    pathBeforeOpen = lstatSync(databasePath);
    if (pathBeforeOpen.isSymbolicLink() || !pathBeforeOpen.isFile()) {
      throw new Error("Database path must name a regular file");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("regular file")) {
      throw error;
    }
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw new Error("Database path must name a regular file", { cause: error });
    }
  }
  try {
    return openSync(
      databasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      0o600,
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw new Error("Database path must name a regular file", { cause: error });
    }
  }

  try {
    const descriptor = openSync(
      databasePath,
      constants.O_RDWR | constants.O_NONBLOCK | noFollow,
    );
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        (pathBeforeOpen !== undefined &&
          (opened.dev !== pathBeforeOpen.dev || opened.ino !== pathBeforeOpen.ino))
      ) {
        throw new Error("Database path must name a regular file");
      }
      fchmodSync(descriptor, 0o600);
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("regular file")) {
      throw error;
    }
    throw new Error("Database path must name a regular file", { cause: error });
  }
};

const secureSidecars = (databasePath: string): void => {
  for (const suffix of ["-wal", "-shm"]) {
    const path = databasePath + suffix;
    if (!existsSync(path)) continue;
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("SQLite sidecar path must name a regular file");
      }
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  }
};

class NodeConnectorDatabase implements ConnectorDatabase {
  readonly #native: DatabaseSync;
  readonly #databasePath: string;
  readonly #ready: Promise<void>;
  #readNative: DatabaseSync | undefined;
  #queue: Promise<void>;
  #startupFailure: unknown;
  #startupFailed = false;
  #mutationActive = false;
  #closeRequested = false;
  #closePromise: Promise<void> | undefined;
  #nativeClosed = false;
  readonly #activeReads = new Set<Promise<unknown>>();

  constructor(native: DatabaseSync, databasePath: string) {
    this.#native = native;
    this.#databasePath = databasePath;
    this.#ready = Promise.resolve()
      .then(() => {
        const available = loadMigrations();
        const pending = this.#startupTransaction(() =>
          pendingMigrations(wrapHandle(this.#native, { active: true, readOnly: false }), available),
        );
        for (const migration of pending) {
          this.#startupTransaction(() => {
            applyMigrationToHandle(
              wrapHandle(this.#native, { active: true, readOnly: false }),
              migration,
            );
          });
        }
        secureSidecars(this.#databasePath);
        this.#readNative = new DatabaseSync(this.#databasePath, {
          readOnly: true,
          allowExtension: false,
        });
        this.#readNative.exec("PRAGMA foreign_keys=ON");
        this.#readNative.exec("PRAGMA busy_timeout=5000");
        this.#readNative.exec("PRAGMA query_only=ON");
        this.#readNative.exec("PRAGMA synchronous=NORMAL");
      })
      .catch((error: unknown) => {
        this.#closeHandles();
        throw error;
      });
    void this.#ready.catch(() => undefined);
    this.#queue = this.#ready.then(
      () => undefined,
      (error: unknown) => {
        this.#startupFailure = error;
        this.#startupFailed = true;
      },
    );
  }

  read<T>(fn: (db: SqliteHandle) => T): Promise<T> {
    if (this.#closeRequested) return Promise.reject(closedError());
    const result = this.#ready.then(() => {
      const database = this.#readNative;
      if (database === undefined) throw closedError();
      return this.#runCallback(fn, database, true);
    });
    this.#activeReads.add(result);
    void result.then(
      () => this.#activeReads.delete(result),
      () => this.#activeReads.delete(result),
    );
    return result;
  }

  write<T>(fn: (db: SqliteHandle) => T): Promise<T> {
    if (this.#closeRequested) return Promise.reject(closedError());
    if (this.#mutationActive) return Promise.reject(nestedError());
    return this.#enqueue(() => this.#runMutation(fn, false));
  }

  transaction<T>(fn: (db: SqliteHandle) => T): Promise<T> {
    if (this.#closeRequested) return Promise.reject(closedError());
    if (this.#mutationActive) return Promise.reject(nestedError());
    return this.#enqueue(() => this.#runMutation(fn, true));
  }

  backupTo(destinationPath: string): Promise<void> {
    if (this.#closeRequested) return Promise.reject(closedError());
    if (!isAbsolute(destinationPath)) {
      return Promise.reject(new Error("Backup destination must be an absolute path"));
    }
    return this.#enqueue(async () => {
      let reserved = false;
      try {
        const descriptor = openSync(
          destinationPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        closeSync(descriptor);
        reserved = true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error("Backup destination already exists");
        }
        throw error;
      }

      try {
        await backup(this.#native, destinationPath);
        secureSidecars(destinationPath);
      } catch (error) {
        if (reserved) {
          try {
            unlinkSync(destinationPath);
          } catch {
            // Preserve the original backup failure.
          }
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closeRequested = true;
    this.#closePromise = this.#queue
      .then(() => this.#ready.catch(() => undefined))
      .then(async () => {
        await Promise.allSettled([...this.#activeReads]);
        this.#closeHandles();
      });
    return this.#closePromise;
  }

  #closeHandles(): void {
    if (this.#readNative !== undefined) {
      this.#readNative.close();
      this.#readNative = undefined;
    }
    if (!this.#nativeClosed) {
      this.#native.close();
      this.#nativeClosed = true;
    }
  }

  #startupTransaction<T>(operation: () => T): T {
    this.#native.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#native.exec("COMMIT");
      return result;
    } catch (error) {
      this.#native.exec("ROLLBACK");
      throw error;
    }
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(() => {
      if (this.#startupFailed) throw this.#startupFailure;
      return operation();
    });
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #runCallback<T>(
    fn: (db: SqliteHandle) => T,
    native: DatabaseSync,
    readOnly: boolean,
  ): T {
    const scope: CallbackScope = { active: true, readOnly };
    try {
      const result = fn(wrapHandle(native, scope));
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("Database callbacks must be synchronous");
      }
      return result;
    } finally {
      scope.active = false;
    }
  }

  #runMutation<T>(fn: (db: SqliteHandle) => T, transactional: boolean): T {
    this.#mutationActive = true;
    let began = false;
    let result: T;
    try {
      if (transactional) {
        this.#native.exec("BEGIN IMMEDIATE");
        began = true;
      }
      result = this.#runCallback(fn, this.#native, false);
      if (began) {
        this.#native.exec("COMMIT");
        began = false;
      }
    } catch (error) {
      if (began) this.#native.exec("ROLLBACK");
      throw error;
    } finally {
      this.#mutationActive = false;
    }
    secureSidecars(this.#databasePath);
    return result;
  }
}

export const openConnectorDatabase = (
  databasePath: string,
): ConnectorDatabase => {
  if (!isAbsolute(databasePath)) {
    throw new Error("Connector database path must be absolute");
  }
  const descriptor = safeDatabaseDescriptor(databasePath);
  try {
    const native = new DatabaseSync(databasePath, {
      allowExtension: false,
    });
    try {
      native.exec("PRAGMA journal_mode=WAL");
      native.exec("PRAGMA foreign_keys=ON");
      native.exec("PRAGMA busy_timeout=5000");
      native.exec("PRAGMA synchronous=NORMAL");
      secureSidecars(databasePath);
      return new NodeConnectorDatabase(native, databasePath);
    } catch (error) {
      native.close();
      throw error;
    }
  } finally {
    closeSync(descriptor);
  }
};
