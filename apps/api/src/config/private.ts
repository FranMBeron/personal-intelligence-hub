import { z } from "zod";

const algorithmSchema = z.enum(["RS256", "ES256"]);
const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const csv = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

const urlSchema = z.string().url();

const privateConfigSchema = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]),
    databaseUrl: urlSchema.refine(
      (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
      "DATABASE_URL must use PostgreSQL.",
    ),
    oidcIssuer: urlSchema,
    oidcAudience: z.string().min(1),
    oidcJwksUri: urlSchema,
    oidcAlgorithms: z.array(algorithmSchema).min(1),
    cursorSigningKey: z.string().min(32),
    allowedOrigins: z.array(urlSchema).min(1),
    logLevel: logLevelSchema,
    idempotencyRetentionHours: z.number().int().min(24),
    outboxRetentionDays: z.number().int().min(7),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

export type PrivateConfig = Readonly<z.infer<typeof privateConfigSchema>>;

export const loadPrivateConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): PrivateConfig =>
  privateConfigSchema.parse({
    nodeEnv: environment.NODE_ENV ?? "development",
    databaseUrl: environment.DATABASE_URL,
    oidcIssuer: environment.OIDC_ISSUER,
    oidcAudience: environment.OIDC_AUDIENCE,
    oidcJwksUri: environment.OIDC_JWKS_URI,
    oidcAlgorithms: csv(environment.OIDC_ALLOWED_ALGORITHMS),
    cursorSigningKey: environment.CURSOR_SIGNING_KEY,
    allowedOrigins: csv(environment.ALLOWED_ORIGINS),
    logLevel: environment.LOG_LEVEL ?? "info",
    idempotencyRetentionHours: Number(
      environment.IDEMPOTENCY_RETENTION_HOURS ?? "24",
    ),
    outboxRetentionDays: Number(environment.OUTBOX_RETENTION_DAYS ?? "7"),
    host: environment.HOST ?? "127.0.0.1",
    port: Number(environment.PORT ?? "3001"),
  });
