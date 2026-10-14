import { z } from "zod";

export const HermesSessionEnvelopeSchema = z.object({
  object: z.literal("hermes.session"),
  session: z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    title: z.string().nullable().optional(),
    archived: z.boolean().optional(),
  }).passthrough(),
}).strict();

export const HermesRunAcceptedSchema = z.object({
  run_id: z.string().startsWith("run_"),
  status: z.string().min(1),
  replayed: z.boolean(),
}).strict();

export const HermesRunStatusSchema = z.object({
  run_id: z.string().startsWith("run_").optional(),
  status: z.enum([
    "queued", "running", "waiting_for_approval", "completed", "failed", "cancelled", "interrupted", "stopping",
  ]),
  session_id: z.string().min(1),
  output: z.string().optional(),
  error: z.string().optional(),
  last_event: z.string().optional(),
}).passthrough();

export const HermesTranscriptMessageSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().startsWith("run_"),
  role: z.enum(["user", "assistant"]),
  content: z.array(
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
  ).min(1),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export const HermesTranscriptPageSchema = z.object({
  messages: z.array(HermesTranscriptMessageSchema),
  next_cursor: z.string().nullable(),
}).strict();

export type HermesSession = Readonly<{
  id: string;
  source: string;
  title?: string | null;
  archived?: boolean;
}>;
export type HermesRunAccepted = Readonly<{
  run_id: string;
  status: string;
  replayed: boolean;
}>;
export type HermesRunStatus = Readonly<{
  run_id?: string;
  status: "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled" | "interrupted" | "stopping";
  session_id: string;
  output?: string;
  error?: string;
  last_event?: string;
}>;
export type HermesTranscriptMessage = Readonly<{
  id: string;
  run_id: string;
  role: "user" | "assistant";
  content: readonly Readonly<{ type: "text"; text: string }>[];
  created_at: string;
}>;

/** Minimal envelope of one upstream run SSE payload; only `event` and `delta` are ever read. */
export const UpstreamRunEventSchema = z.object({
  event: z.string().min(1).max(120),
  delta: z.unknown().optional(),
}).passthrough();
