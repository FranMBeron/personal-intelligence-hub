import { isAbsolute, resolve } from "node:path";

import { ConnectorBackupError } from "../foundation/backup.js";

export type CommandOutput = Readonly<{ write(value: string): unknown }>;

export type OperatorCommandIo = Readonly<{
  stdout: CommandOutput;
  stderr: CommandOutput;
}>;

export type OperatorFailureCode =
  | "arguments_invalid"
  | "configuration_invalid"
  | "backup_database_missing"
  | "backup_database_mismatch";

/** Safe operator failure: the message is never printed, only the code. */
export class OperatorCommandError extends Error {
  readonly code: OperatorFailureCode | ConnectorBackupError["code"];

  constructor(code: OperatorCommandError["code"], message: string) {
    super(message);
    this.name = "OperatorCommandError";
    this.code = code;
  }
}

/**
 * Parse `--name value` pairs. Every option may appear at most once, values may
 * not look like options, and unknown options are rejected.
 */
export const parseOptions = <Name extends string>(
  argv: readonly string[],
  required: readonly Name[],
  optional: readonly Name[] = [],
): ReadonlyMap<Name, string> => {
  const allowed = new Set<string>([...required, ...optional]);
  const values = new Map<Name, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new OperatorCommandError("arguments_invalid", "Unexpected positional argument");
    }
    const name = flag.slice(2) as Name;
    if (!allowed.has(name) || values.has(name) || value === undefined || value.startsWith("--") || value.length === 0) {
      throw new OperatorCommandError("arguments_invalid", "Invalid or repeated option");
    }
    values.set(name, value);
  }
  for (const name of required) {
    if (!values.has(name)) throw new OperatorCommandError("arguments_invalid", "Missing required option");
  }
  return values;
};

export const requireAbsolutePath = (path: string): string => {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new ConnectorBackupError("backup_path_invalid", "Operator paths must be absolute normalized paths");
  }
  return path;
};

export const failureCode = (error: unknown, fallback: string): string => {
  if (error instanceof OperatorCommandError || error instanceof ConnectorBackupError) return error.code;
  return fallback;
};

export const writeJsonLine = (output: CommandOutput, value: Readonly<Record<string, unknown>>): void => {
  output.write(JSON.stringify(value) + "\n");
};

/** True when the module is the process entry point (mirrors `main.ts`). */
export const isEntryPoint = (moduleUrl: string): boolean =>
  process.argv[1] !== undefined && moduleUrl === new URL(process.argv[1], "file:").href;
