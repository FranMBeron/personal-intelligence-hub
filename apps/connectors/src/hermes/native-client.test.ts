import { describe, expect, it, vi } from "vitest";

import { loadHermesConfig } from "./config.js";
import { HermesProfileRegistry } from "./profile-registry.js";
import { HermesNativeClient } from "./native-client.js";

const orchestratorKey = "fictional-orchestrator-api-key";
const specialistKey = "fictional-specialist-api-key";
const environment = () => ({
  HERMES_API_ORIGIN: "http://127.0.0.1:8642",
  HERMES_DEFAULT_PROFILE_ID: "orchestrator",
  HERMES_PROFILES_JSON: JSON.stringify([
    {
      id: "orchestrator", displayName: "Orchestrator", keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY",
      enabled: true, capabilities: { directConversations: true, images: true, delegationTarget: false },
    },
    {
      id: "specialist", displayName: "Specialist", keyEnvironment: "HERMES_SPECIALIST_API_KEY",
      enabled: true, capabilities: { directConversations: true, images: true, delegationTarget: true },
    },
  ]),
  HERMES_ORCHESTRATOR_API_KEY: orchestratorKey,
  HERMES_SPECIALIST_API_KEY: specialistKey,
  HERMES_UPLOAD_DIRECTORY: "/var/lib/pih-connectors/hermes-uploads",
  HERMES_IMAGE_MAX_BYTES: "5242880",
  HERMES_UPLOAD_TTL_SECONDS: "600",
  HERMES_EVENT_RETENTION_HOURS: "168",
  HERMES_IDEMPOTENCY_RETENTION_HOURS: "168",
});
type CapturedRequest = Readonly<{ url: string; init: RequestInit }>;
const clientFor = (respond: (request: CapturedRequest) => Response | Promise<Response>, options: { timeoutMs?: number } = {}) => {
  const requests: CapturedRequest[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = { url: String(input), init: init ?? {} };
    requests.push(request);
    return respond(request);
  }) as unknown as typeof fetch;
  const client = new HermesNativeClient({
    profiles: new HermesProfileRegistry(loadHermesConfig(environment())),
    fetch: fetcher,
    ...options,
  });
  return { client, requests, fetcher };
};
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const sessionEnvelope = (extra: Record<string, unknown> = {}) => ({
  object: "hermes.session",
  session: { id: "pih_conversation-01", source: "pih", title: "Daily notes", archived: false, ...extra },
});
const transcript = (id: string) => ({
  id, run_id: "run_123", role: "assistant",
  content: [{ type: "text", text: "safe response" }], created_at: "2026-10-12T12:00:00.000Z",
});

describe("HermesNativeClient", () => {
  it("uses profile-scoped paths and only the selected profile credential", async () => {
    const { client, requests } = clientFor(() => jsonResponse(sessionEnvelope()));
    const session = await client.createSession("specialist", {
      id: "pih_conversation-01", title: "Daily notes", source: "pih",
    });
    expect(requests[0]?.url).toBe("http://127.0.0.1:8642/p/specialist/api/sessions");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer " + specialistKey);
    expect(session).toEqual({ id: "pih_conversation-01", source: "pih", title: "Daily notes", archived: false });
    expect(JSON.stringify(session)).not.toContain(specialistKey);
  });

  it("isolates credentials and capability paths between configured profiles", async () => {
    const capabilities = {
      text: true, streaming: true, voice: { enabled: false },
      attachments: { enabled: true, acceptedMimeTypes: ["image/png"], maxFiles: 1, maxBytes: 1024 },
      agentConversations: true,
    };
    const { client, requests } = clientFor(() => jsonResponse(capabilities));
    await client.capabilities("orchestrator");
    await client.capabilities("specialist");
    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8642/p/orchestrator/v1/capabilities",
      "http://127.0.0.1:8642/p/specialist/v1/capabilities",
    ]);
    expect(requests.map(({ init }) => new Headers(init.headers).get("authorization"))).toEqual([
      "Bearer " + orchestratorKey,
      "Bearer " + specialistKey,
    ]);
  });

  it("rejects unknown capability response fields", async () => {
    const capabilities = {
      text: true, streaming: true, voice: { enabled: false },
      attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 },
      agentConversations: true,
      diagnostic: "private provider data",
    };
    const { client } = clientFor(() => jsonResponse(capabilities));
    await expect(client.capabilities("specialist")).rejects.toThrow("hermes_response_invalid");
  });

  it("rejects unknown profiles before making a request", async () => {
    const { client, fetcher } = clientFor(() => jsonResponse(sessionEnvelope()));
    await expect(client.getSession("unknown", "session-01")).rejects.toThrow("hermes_profile_not_configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates session request bodies and path identifiers", async () => {
    const { client, fetcher } = clientFor(() => jsonResponse(sessionEnvelope()));
    await expect(client.createSession("specialist", {
      id: "../other-profile", title: "Daily notes", source: "pih",
    } as never)).rejects.toThrow("hermes_request_invalid");
    await expect(client.getSession("specialist", "../other-profile")).rejects.toThrow("hermes_request_invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes accepted runs and sends the idempotency key as a header", async () => {
    const accepted = { run_id: "run_123", status: "queued", replayed: false };
    const { client, requests } = clientFor(() => jsonResponse(accepted));
    const result = await client.createRun("specialist", {
      sessionId: "pih_conversation-01",
      idempotencyKey: "pih-5f352dc4cbb14251",
      input: [{ role: "user", content: [{ type: "text", text: "Record this" }] }],
    });
    expect(requests[0]?.url).toBe("http://127.0.0.1:8642/p/specialist/v1/runs");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer " + specialistKey);
    expect(new Headers(requests[0]?.init.headers).get("idempotency-key")).toBe("pih-5f352dc4cbb14251");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      session_id: "pih_conversation-01",
      input: [{ role: "user", content: [{ type: "text", text: "Record this" }] }],
    });
    expect(result).toEqual(accepted);
  });

  it("forwards bounded image data URLs and rejects any other image reference", async () => {
    const accepted = { run_id: "run_124", status: "queued", replayed: false };
    const { client, requests } = clientFor(() => jsonResponse(accepted));
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    await client.createRun("specialist", {
      sessionId: "pih_conversation-01",
      idempotencyKey: "pih-5f352dc4cbb14251",
      input: [{ role: "user", content: [
        { type: "text", text: "Look" },
        { type: "image_url", image_url: { url: dataUrl } },
      ] }],
    });
    expect(JSON.parse(String(requests[0]?.init.body)).input[0].content[1]).toEqual({
      type: "image_url", image_url: { url: dataUrl },
    });
    for (const url of [
      "http://127.0.0.1:9/a.png", "file:///etc/passwd", "data:image/svg+xml;base64,PHN2Zy8+",
      "data:text/html;base64,PGI+", "data:image/png;base64,not base64!",
    ]) {
      await expect(client.createRun("specialist", {
        sessionId: "pih_conversation-01",
        idempotencyKey: "pih-5f352dc4cbb14251",
        input: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
      })).rejects.toThrow("hermes_request_invalid");
    }
    expect(requests).toHaveLength(1);
  });

  it("rejects unknown fields in accepted-run responses", async () => {
    const { client } = clientFor(() => jsonResponse({
      run_id: "run_123", status: "queued", replayed: false, provider_debug: "secret",
    }));
    await expect(client.createRun("specialist", {
      sessionId: "pih_conversation-01",
      idempotencyKey: "pih-5f352dc4cbb14251",
      input: [{ role: "user", content: [{ type: "text", text: "Record this" }] }],
    })).rejects.toThrow("hermes_response_invalid");
  });

  it("builds a strict session patch request", async () => {
    const { client, requests } = clientFor(() => jsonResponse(sessionEnvelope({ title: "Updated" })));
    await client.patchSession("specialist", "pih_conversation-01", { title: "Updated" });
    expect(requests[0]?.url).toBe("http://127.0.0.1:8642/p/specialist/api/sessions/pih_conversation-01");
    expect(requests[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ title: "Updated" });
    await expect(client.patchSession("specialist", "pih_conversation-01", { diagnostic: "no" } as never))
      .rejects.toThrow("hermes_request_invalid");
  });

  it("gets a single session and projects away upstream-only fields", async () => {
    const { client, requests } = clientFor(() => jsonResponse(sessionEnvelope({
      internal_trace: "not for callers",
    })));
    await expect(client.getSession("specialist", "pih_conversation-01")).resolves.toEqual({
      id: "pih_conversation-01", source: "pih", title: "Daily notes", archived: false,
    });
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:8642/p/specialist/api/sessions/pih_conversation-01",
    );
  });

  it("normalizes run status and strips unknown diagnostic fields", async () => {
    const { client, requests } = clientFor(() => jsonResponse({
      run_id: "run_123", status: "completed", session_id: "pih_conversation-01",
      output: "safe transcript", provider_diagnostic: "private",
    }));
    await expect(client.runStatus("specialist", "run_123")).resolves.toEqual({
      run_id: "run_123", status: "completed", session_id: "pih_conversation-01", output: "safe transcript",
    });
    expect(requests[0]?.url).toBe("http://127.0.0.1:8642/p/specialist/v1/runs/run_123");
  });

  it("follows transcript cursors and returns only strict text transcript rows", async () => {
    const { client, requests } = clientFor((request) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get("cursor");
      return cursor === null
        ? jsonResponse({ messages: [transcript("msg_1")], next_cursor: "cursor-2" })
        : jsonResponse({ messages: [transcript("msg_2")], next_cursor: null });
    });
    const messages = await client.messages("specialist", "session-01", { limit: 25 });
    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8642/p/specialist/api/sessions/session-01/messages?limit=25",
      "http://127.0.0.1:8642/p/specialist/api/sessions/session-01/messages?limit=25&cursor=cursor-2",
    ]);
    expect(messages).toEqual([transcript("msg_1"), transcript("msg_2")]);
  });

  it("fails closed when a transcript page contains an unknown message row", async () => {
    const { client } = clientFor(() => jsonResponse({
      messages: [{ type: "tool", content: "private reasoning" }], next_cursor: null,
    }));
    await expect(client.messages("specialist", "session-01", {})).rejects.toThrow("hermes_response_invalid");
  });

  it("stops cursor loops and never fetches more than twenty pages", async () => {
    const { client, requests } = clientFor(() => jsonResponse({ messages: [], next_cursor: "same-cursor" }));
    await expect(client.messages("specialist", "session-01", {})).rejects.toThrow("hermes_cursor_invalid");
    expect(requests).toHaveLength(2);
  });

  it("enforces the twenty-page transcript ceiling", async () => {
    let page = 0;
    const { client, requests } = clientFor(() => {
      page += 1;
      return jsonResponse({ messages: [], next_cursor: "cursor-" + page });
    });
    await expect(client.messages("specialist", "session-01", {})).rejects.toThrow("hermes_page_limit_exceeded");
    expect(requests).toHaveLength(20);
  });

  it("sanitizes provider response bodies and rejects redirects", async () => {
    const { client } = clientFor(() => new Response("fictional-api-key diagnostic", { status: 500 }));
    await expect(client.capabilities("specialist")).rejects.toThrow("hermes_upstream_unavailable");
    const redirect = clientFor(() => new Response("http://attacker.test", {
      status: 302, headers: { location: "http://attacker.test/steal" },
    }));
    await expect(redirect.client.capabilities("specialist")).rejects.toThrow("hermes_redirect_rejected");
  });

  it("does not trust error messages thrown by the injected transport", async () => {
    const client = new HermesNativeClient({
      profiles: new HermesProfileRegistry(loadHermesConfig(environment())),
      fetch: (async () => { throw new Error("hermes_provider_diagnostic fictional-api-key"); }) as typeof fetch,
    });
    await expect(client.capabilities("specialist")).rejects.toThrow("hermes_upstream_unavailable");
  });

  it("times out stalled requests with a safe error", async () => {
    const fetcher = vi.fn((_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    ) as unknown as typeof fetch;
    const client = new HermesNativeClient({
      profiles: new HermesProfileRegistry(loadHermesConfig(environment())),
      fetch: fetcher,
      timeoutMs: 5,
    });
    await expect(client.capabilities("specialist")).rejects.toThrow("hermes_request_timeout");
  });

  it("keeps the request timeout active while reading a JSON response body", async () => {
    const client = new HermesNativeClient({
      profiles: new HermesProfileRegistry(loadHermesConfig(environment())),
      fetch: (async () => new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => controller.error(new Error("late body failure")), 20);
        },
      }), { headers: { "content-type": "application/json" } })) as typeof fetch,
      timeoutMs: 5,
    });
    await expect(client.capabilities("specialist")).rejects.toThrow("hermes_request_timeout");
  });

  it("keeps run events streaming and forwards caller cancellation", async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: event\n\n")); } });
    const captured = { signal: undefined as AbortSignal | null | undefined, url: "" };
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      captured.url = String(input);
      captured.signal = init?.signal;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new HermesNativeClient({
      profiles: new HermesProfileRegistry(loadHermesConfig(environment())), fetch: fetcher,
    });
    const controller = new AbortController();
    const response = await client.runEvents("specialist", "run_123", controller.signal);
    expect(captured.url).toBe("http://127.0.0.1:8642/p/specialist/v1/runs/run_123/events");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.body).not.toBeNull();
    controller.abort();
    expect(captured.signal?.aborted).toBe(true);
  });
});
