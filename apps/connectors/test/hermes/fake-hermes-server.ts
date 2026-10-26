import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Strict fake of the Hermes Agent API server (sessions + durable runs), served
 * over real loopback HTTP so the connectors native client is exercised on the
 * wire. Only the routes listed in `ROUTES` exist; anything else is answered 404
 * and recorded as unexpected. Every profile, key, session, run, and text here is
 * fictional.
 */

export type FakeCapabilities = Readonly<{
  text: true;
  streaming: boolean;
  voice: Readonly<{ enabled: false }>;
  attachments: Readonly<{ enabled: boolean; acceptedMimeTypes: readonly string[]; maxFiles: number; maxBytes: number }>;
  agentConversations: boolean;
}>;

export type FakeProfile = Readonly<{
  id: string;
  apiKey: string;
  capabilities?: FakeCapabilities;
}>;

/** A request as observed by the fake. Credentials are never recorded, only whether they matched. */
export type RecordedRequest = Readonly<{
  profile: string;
  method: string;
  route: string;
  path: string;
  credential: "valid" | "wrong" | "missing";
  idempotencyKey?: string;
}>;

export type FakeSession = {
  readonly id: string;
  title: string | null;
  readonly source: string;
  archived: boolean;
  readonly createdAt: string;
};

export type FakeRunState = "queued" | "running" | "completed" | "failed";

export type FakeRun = {
  readonly id: string;
  readonly profile: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly bodyHash: string;
  readonly input: unknown;
  state: FakeRunState;
  readonly createdAt: string;
  statusPolls: number;
  eventStreams: number;
};

/** Upstream SSE frames for one run: provider internals first, then the visible reply. */
export const TOOL_MARKER = "FICTIONAL-TOOL-INTERNAL-MARKER";
export const REASONING_MARKER = "FICTIONAL-REASONING-INTERNAL-MARKER";
export const REPLY_DELTAS = ["Fictional ", "reply."] as const;
export const REPLY_TEXT = REPLY_DELTAS.join("");

const fullCapabilities: FakeCapabilities = {
  text: true, streaming: true, voice: { enabled: false },
  attachments: { enabled: true, acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"], maxFiles: 3, maxBytes: 1024 * 1024 },
  agentConversations: true,
};

const ROUTES: readonly Readonly<{ method: string; pattern: RegExp; route: string }>[] = [
  { method: "GET", pattern: /^v1\/capabilities$/u, route: "GET /v1/capabilities" },
  { method: "GET", pattern: /^api\/sessions$/u, route: "GET /api/sessions" },
  { method: "POST", pattern: /^api\/sessions$/u, route: "POST /api/sessions" },
  { method: "GET", pattern: /^api\/sessions\/([^/]+)$/u, route: "GET /api/sessions/:id" },
  { method: "PATCH", pattern: /^api\/sessions\/([^/]+)$/u, route: "PATCH /api/sessions/:id" },
  { method: "GET", pattern: /^api\/sessions\/([^/]+)\/messages$/u, route: "GET /api/sessions/:id/messages" },
  { method: "POST", pattern: /^v1\/runs$/u, route: "POST /v1/runs" },
  { method: "GET", pattern: /^v1\/runs\/([^/]+)$/u, route: "GET /v1/runs/:id" },
  { method: "GET", pattern: /^v1\/runs\/([^/]+)\/events$/u, route: "GET /v1/runs/:id/events" },
];

const MAX_BODY_BYTES = 20 * 1024 * 1024;

const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let length = 0;
  request.on("data", (chunk: Buffer) => {
    length += chunk.byteLength;
    if (length > MAX_BODY_BYTES) { reject(new Error("too large")); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
});

const send = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
};

const sessionEnvelope = (session: FakeSession) => ({
  object: "hermes.session",
  session: { id: session.id, source: session.source, title: session.title, archived: session.archived },
});

export class FakeHermesServer {
  readonly requests: RecordedRequest[] = [];
  readonly unexpected: string[] = [];
  /** When true, status polls report the current state without advancing it. */
  holdRuns = false;
  readonly #profiles: ReadonlyMap<string, FakeProfile>;
  readonly #sessions = new Map<string, Map<string, FakeSession>>();
  readonly #runs = new Map<string, FakeRun>();
  readonly #offline = new Set<string>();
  readonly #server: Server;
  #dropNextRunResponse = false;
  #runCounter = 0;
  #origin: string | undefined;

  private constructor(profiles: readonly FakeProfile[]) {
    this.#profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    for (const profile of profiles) this.#sessions.set(profile.id, new Map());
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) send(response, 500, { error: "fake_failure" });
        else response.destroy();
      });
    });
  }

  static async start(profiles: readonly FakeProfile[]): Promise<FakeHermesServer> {
    const fake = new FakeHermesServer(profiles);
    await new Promise<void>((resolve, reject) => {
      fake.#server.once("error", reject);
      fake.#server.listen(0, "127.0.0.1", () => { fake.#server.off("error", reject); resolve(); });
    });
    fake.#origin = `http://127.0.0.1:${(fake.#server.address() as AddressInfo).port}`;
    return fake;
  }

  /** Literal loopback origin, e.g. for `HERMES_API_ORIGIN`. */
  get origin(): string {
    if (this.#origin === undefined) throw new Error("fake Hermes is not listening");
    return this.#origin;
  }

  get port(): string {
    return new URL(this.origin).port;
  }

  sessions(profile: string): readonly FakeSession[] {
    return [...(this.#sessions.get(profile)?.values() ?? [])];
  }

  runs(profile?: string): readonly FakeRun[] {
    return [...this.#runs.values()].filter((run) => profile === undefined || run.profile === profile);
  }

  /** Accept the next run, then destroy the connection before answering (a lost HTTP response). */
  dropNextRunResponse(): void {
    this.#dropNextRunResponse = true;
  }

  /** Make one profile answer every request with 503 (unreachable evidence). */
  setOffline(profile: string, offline: boolean): void {
    if (offline) this.#offline.add(profile); else this.#offline.delete(profile);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const match = /^\/p\/([^/]+)\/(.*)$/u.exec(url.pathname);
    const method = request.method ?? "GET";
    const route = match === null ? undefined : ROUTES.find((candidate) => candidate.method === method && candidate.pattern.test(match[2]!));
    if (match === null || route === undefined) {
      this.unexpected.push(`${method} ${url.pathname}`);
      request.resume();
      return send(response, 404, { error: "not_found" });
    }
    const profileId = decodeURIComponent(match[1]!);
    const path = match[2]!;
    const profile = this.#profiles.get(profileId);
    const authorization = request.headers.authorization;
    const credential = authorization === undefined ? "missing"
      : profile !== undefined && authorization === `Bearer ${profile.apiKey}` ? "valid" : "wrong";
    const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    this.requests.push({
      profile: profileId, method, route: route.route, path: url.pathname, credential,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    if (profile === undefined) { request.resume(); return send(response, 404, { error: "profile_not_found" }); }
    if (credential !== "valid") { request.resume(); return send(response, 401, { error: "unauthorized" }); }
    if (this.#offline.has(profileId)) { request.resume(); return send(response, 503, { error: "unavailable" }); }
    const raw = await readBody(request);
    const body = raw.length === 0 ? undefined : JSON.parse(raw) as unknown;
    const reference = route.pattern.exec(path)?.[1];
    const id = reference === undefined ? undefined : decodeURIComponent(reference);
    const sessions = this.#sessions.get(profileId)!;

    switch (route.route) {
      case "GET /v1/capabilities":
        return send(response, 200, profile.capabilities ?? fullCapabilities);
      case "GET /api/sessions":
        return send(response, 200, { object: "list", data: [...sessions.values()].map((session) => sessionEnvelope(session).session) });
      case "POST /api/sessions": {
        const input = body as { session_id?: unknown; title?: unknown; source?: unknown };
        if (typeof input?.session_id !== "string" || typeof input.source !== "string") return send(response, 400, { error: "invalid" });
        if (sessions.has(input.session_id)) return send(response, 409, { error: "exists" });
        const session: FakeSession = {
          id: input.session_id, title: typeof input.title === "string" ? input.title : null, source: input.source,
          archived: false, createdAt: new Date().toISOString(),
        };
        sessions.set(session.id, session);
        return send(response, 201, sessionEnvelope(session));
      }
      case "GET /api/sessions/:id": {
        const session = sessions.get(id!);
        return session === undefined ? send(response, 404, { error: "not_found" }) : send(response, 200, sessionEnvelope(session));
      }
      case "PATCH /api/sessions/:id": {
        const session = sessions.get(id!);
        if (session === undefined) return send(response, 404, { error: "not_found" });
        const patch = body as { title?: unknown; archived?: unknown };
        if (typeof patch?.title === "string") session.title = patch.title;
        if (typeof patch?.archived === "boolean") session.archived = patch.archived;
        return send(response, 200, sessionEnvelope(session));
      }
      case "GET /api/sessions/:id/messages": {
        if (!sessions.has(id!)) return send(response, 404, { error: "not_found" });
        return send(response, 200, { messages: this.#transcript(profileId, id!), next_cursor: null });
      }
      case "POST /v1/runs":
        return this.#createRun(response, profileId, sessions, idempotencyKey, raw, body);
      case "GET /v1/runs/:id": {
        const run = this.#runs.get(id!);
        if (run === undefined || run.profile !== profileId) return send(response, 404, { error: "not_found" });
        run.statusPolls += 1;
        if (!this.holdRuns) {
          if (run.state === "queued") run.state = "running";
          else if (run.state === "running") run.state = "completed";
        }
        return send(response, 200, {
          run_id: run.id, status: run.state, session_id: run.sessionId,
          ...(run.state === "completed" ? { output: REPLY_TEXT } : {}),
        });
      }
      case "GET /v1/runs/:id/events": {
        const run = this.#runs.get(id!);
        if (run === undefined || run.profile !== profileId) return send(response, 404, { error: "not_found" });
        run.eventStreams += 1;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const frames: unknown[] = [
          { event: "tool.started", tool: "fictional_tool", input: TOOL_MARKER },
          { event: "reasoning.delta", delta: REASONING_MARKER },
          { event: "tool.completed", output: TOOL_MARKER },
          ...REPLY_DELTAS.map((delta) => ({ event: "message.delta", delta })),
          { event: "approval.requested", detail: TOOL_MARKER },
        ];
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        response.end();
        return;
      }
      default:
        return send(response, 404, { error: "not_found" });
    }
  }

  #createRun(
    response: ServerResponse,
    profileId: string,
    sessions: ReadonlyMap<string, FakeSession>,
    idempotencyKey: string | undefined,
    raw: string,
    body: unknown,
  ): void {
    const input = body as { session_id?: unknown; input?: unknown };
    if (idempotencyKey === undefined || typeof input?.session_id !== "string") return send(response, 400, { error: "invalid" });
    if (!sessions.has(input.session_id)) return send(response, 404, { error: "session_not_found" });
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const prior = [...this.#runs.values()].find((run) => run.profile === profileId && run.idempotencyKey === idempotencyKey);
    let run: FakeRun;
    let replayed = false;
    if (prior !== undefined) {
      if (prior.bodyHash !== bodyHash) return send(response, 409, { error: "idempotency_conflict" });
      run = prior;
      replayed = true;
    } else {
      this.#runCounter += 1;
      run = {
        id: `run_fake${String(this.#runCounter).padStart(4, "0")}`, profile: profileId, sessionId: input.session_id,
        idempotencyKey, bodyHash, input: input.input, state: "queued", createdAt: new Date().toISOString(), statusPolls: 0, eventStreams: 0,
      };
      this.#runs.set(run.id, run);
    }
    if (this.#dropNextRunResponse) {
      this.#dropNextRunResponse = false;
      response.socket?.destroy();
      return;
    }
    send(response, 202, { run_id: run.id, status: run.state, replayed });
  }

  #transcript(profileId: string, sessionId: string) {
    return this.runs(profileId).filter((run) => run.sessionId === sessionId).flatMap((run) => {
      const text = JSON.stringify(run.input).slice(0, 200);
      const user = { id: `${run.id}-user`, run_id: run.id, role: "user", content: [{ type: "text", text }], created_at: run.createdAt };
      return run.state === "completed"
        ? [user, { id: `${run.id}-assistant`, run_id: run.id, role: "assistant", content: [{ type: "text", text: REPLY_TEXT }], created_at: run.createdAt }]
        : [user];
    });
  }
}
