import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { z } from "zod";

const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const ProfileKeyEnvironmentSchema = z.string().regex(/^HERMES_[A-Z0-9_]+_API_KEY$/);
const CapabilitiesSchema = z.object({
  directConversations: z.boolean(),
  images: z.boolean(),
  delegationTarget: z.boolean(),
}).strict();
const ProfileInputSchema = z.object({
  id: ProfileIdSchema,
  displayName: z.string().trim().min(1).max(120),
  keyEnvironment: ProfileKeyEnvironmentSchema,
  enabled: z.boolean(),
  capabilities: CapabilitiesSchema,
}).strict();
const ProfileListSchema = z.array(ProfileInputSchema).min(1).max(64);
const IntegerEnvironmentSchema = z.string().regex(/^(?:0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().safe());

export type HermesProfile = Readonly<{
  id: string;
  displayName: string;
  enabled: true;
  capabilities: Readonly<{
    directConversations: boolean;
    images: boolean;
    delegationTarget: boolean;
  }>;
}>;

export type HermesConfigDiagnostic = Readonly<{
  redacted: true;
  profileCount: number;
  defaultProfileConfigured: boolean;
  capabilities: Readonly<{
    directConversations: boolean;
    images: boolean;
    delegationTarget: boolean;
  }>;
}>;

export class HermesProfileCredential {
  readonly #apiKey: string;

  constructor(apiKey: string) {
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new Error("Hermes profile credential is unavailable");
    }
    this.#apiKey = apiKey;
    Object.freeze(this);
  }

  authorizationValue(): string {
    return `Bearer ${this.#apiKey}`;
  }

  toJSON(): "[REDACTED]" {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "[REDACTED]";
  }
}

export type HermesConfig = Readonly<{
  apiOrigin: URL;
  defaultProfileId: string;
  profiles: readonly Readonly<{
    profile: HermesProfile;
    credential: HermesProfileCredential;
  }>[];
  uploadDirectory: string;
  imageMaxBytes: number;
  uploadTtlSeconds: number;
  eventRetentionHours: number;
  idempotencyRetentionHours: number;
  toJSON(): HermesConfigDiagnostic;
  [inspect.custom](): string;
}>;

type ProfileInput = z.infer<typeof ProfileInputSchema>;

const environmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string => {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new Error("Hermes configuration is incomplete");
  }
  return value;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Hermes profile configuration is invalid");
  }
};

const parseLoopbackOrigin = (value: string): URL => {
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(value);
  if (match === null) {
    throw new Error("Hermes API origin must be a literal loopback HTTP origin with a port and no path");
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Hermes API origin must be a literal loopback HTTP origin with a valid port");
  }
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(origin.hostname) ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      throw new Error("invalid origin");
    }
    return origin;
  } catch {
    throw new Error("Hermes API origin must be a literal loopback HTTP origin with a valid port");
  }
};

export const findHermesRepositoryRoot = (
  startDirectory = dirname(fileURLToPath(import.meta.url)),
): string | undefined => {
  let current = resolve(startDirectory);
  while (current !== dirname(current)) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return realpathSync(current);
    }
    current = dirname(current);
  }
  return undefined;
};

const resolvedExistingPath = (path: string): string => {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    existing = parent;
  }
  const canonical = realpathSync(existing);
  return resolve(canonical, ...missing);
};

const isWithin = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const validateUploadDirectory = (value: string): string => {
  if (!isAbsolute(value)) {
    throw new Error("Hermes upload directory must be absolute and outside the repository");
  }
  const root = findHermesRepositoryRoot();
  const lexicalPath = resolve(value);
  if (root !== undefined && isWithin(root, lexicalPath)) {
    throw new Error("Hermes upload directory must be absolute and outside the repository");
  }
  let canonicalPath: string;
  try {
    canonicalPath = resolvedExistingPath(lexicalPath);
  } catch {
    throw new Error("Hermes upload directory is not accessible");
  }
  if (root !== undefined && isWithin(root, canonicalPath)) {
    throw new Error("Hermes upload directory must be outside the repository");
  }
  return lexicalPath;
};

const parseBoundedInteger = (
  value: string,
  minimum: number,
  maximum: number,
): number => {
  const parsed = IntegerEnvironmentSchema.safeParse(value);
  if (!parsed.success || parsed.data < minimum || parsed.data > maximum) {
    throw new Error("Hermes configuration values are out of range");
  }
  return parsed.data;
};

const diagnosticFor = (
  profiles: readonly Readonly<{ profile: HermesProfile; credential: HermesProfileCredential }>[],
  defaultProfileId: string,
): HermesConfigDiagnostic => Object.freeze({
  redacted: true,
  profileCount: profiles.length,
  defaultProfileConfigured: profiles.some(({ profile }) => profile.id === defaultProfileId),
  capabilities: Object.freeze({
    directConversations: profiles.some(({ profile }) => profile.capabilities.directConversations),
    images: profiles.some(({ profile }) => profile.capabilities.images),
    delegationTarget: profiles.some(({ profile }) => profile.capabilities.delegationTarget),
  }),
});

export function loadHermesConfig(
  environment: Readonly<Record<string, string | undefined>>,
): HermesConfig {
  const apiOrigin = parseLoopbackOrigin(environmentValue(environment, "HERMES_API_ORIGIN"));
  const defaultProfileId = environmentValue(environment, "HERMES_DEFAULT_PROFILE_ID");
  let profileInputs: ProfileInput[];
  try {
    profileInputs = ProfileListSchema.parse(parseJson(environmentValue(environment, "HERMES_PROFILES_JSON")));
  } catch {
    throw new Error("Hermes profile configuration is invalid");
  }

  const ids = profileInputs.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Hermes profile identifiers must be unique");
  }
  const defaultInput = profileInputs.find(({ id }) => id === defaultProfileId);
  if (defaultInput === undefined || !defaultInput.enabled) {
    throw new Error("Hermes default profile must exist and be enabled for gateway use");
  }
  if (!defaultInput.capabilities.directConversations || defaultInput.capabilities.delegationTarget) {
    throw new Error("Hermes default profile must be a direct conversation gateway and cannot be a delegation target");
  }

  const credentialEnvironmentNames = profileInputs.map(({ keyEnvironment }) => keyEnvironment);
  if (new Set(credentialEnvironmentNames).size !== credentialEnvironmentNames.length) {
    throw new Error("Hermes profile credential references must be unique");
  }

  const enabledInputs = profileInputs.filter(({ enabled }) => enabled);
  const apiKeys = new Set<string>();
  const resolvedProfiles = enabledInputs.map((input) => {
    const apiKey = environment[input.keyEnvironment];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error("Hermes profile credential is unavailable");
    }
    if (apiKeys.has(apiKey)) {
      throw new Error("Hermes profile credentials must be unique");
    }
    apiKeys.add(apiKey);
    return Object.freeze({
      profile: Object.freeze({
        id: input.id,
        displayName: input.displayName,
        enabled: true as const,
        capabilities: Object.freeze({ ...input.capabilities }),
      }),
      credential: new HermesProfileCredential(apiKey),
    });
  });

  const uploadDirectory = validateUploadDirectory(environmentValue(environment, "HERMES_UPLOAD_DIRECTORY"));
  const imageMaxBytes = parseBoundedInteger(environmentValue(environment, "HERMES_IMAGE_MAX_BYTES"), 1, 10 * 1024 * 1024);
  const uploadTtlSeconds = parseBoundedInteger(environmentValue(environment, "HERMES_UPLOAD_TTL_SECONDS"), 60, 3_600);
  const eventRetentionHours = parseBoundedInteger(environmentValue(environment, "HERMES_EVENT_RETENTION_HOURS"), 24, 720);
  const idempotencyRetentionHours = parseBoundedInteger(environmentValue(environment, "HERMES_IDEMPOTENCY_RETENTION_HOURS"), eventRetentionHours, 720);
  const profiles = Object.freeze(resolvedProfiles);
  const defaultDiagnostic = () => diagnosticFor(profiles, defaultProfileId);
  const config = {
    get apiOrigin() {
      return new URL(apiOrigin.href);
    },
    defaultProfileId,
    profiles,
    uploadDirectory,
    imageMaxBytes,
    uploadTtlSeconds,
    eventRetentionHours,
    idempotencyRetentionHours,
    toJSON: defaultDiagnostic,
    [inspect.custom]() {
      return `HermesConfig ${JSON.stringify(defaultDiagnostic())}`;
    },
  } satisfies HermesConfig;
  return Object.freeze(config);
}
