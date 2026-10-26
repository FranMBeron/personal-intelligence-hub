import { request } from "node:http";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DelegationListSchema, SourceStatusSchema, type ConnectorScope } from "@personal-intelligence-hub/contracts";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHermesHarness,
  delegationEnvironment,
  disposeHermesHarnesses,
  ownerActorId,
  peerTokenA,
  principalFor,
  profileEnvironment,
  specialistAId,
} from "../../test/hermes/harness.js";
import { createConnectorsApp } from "../app.js";
import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "../config/private.js";
import type { ConnectorModuleDependencies } from "../foundation/module.js";
import { loadDelegationPeerConfig } from "./delegation-auth.js";
import {
  createHermesModule,
  hermesConfigNamespace,
  hermesProviderModule,
  probeHermesStatus,
  type HermesModuleOptions,
} from "./module.js";
import { createHermesRuntime, type HermesRuntime } from "./runtime.js";

const web: ServiceCredentialPolicy = {
  serviceId: "pih-web", serviceToken: "test-only-pih-web-credential-".padEnd(40, "0"),
  delegatedIssuer: "https://pih-web.test.invalid", delegatedKey: new Uint8Array(32).fill(51),
  actorTypes: ["human"], maxScopes: ["hermes:agents:read", "hermes:conversations:read", "hermes:conversations:write", "hermes:delegations:read"],
};
const connectorsConfig: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/hermes-module-test.sqlite", serviceCredentials: [web], audience: CONNECTORS_AUDIENCE,
  defaultTimeZone: "Etc/UTC", logLevel: "error",
};
const webHeaders = async (actor: string, scopes: readonly ConnectorScope[]) => ({
  "x-pih-service-token": web.serviceToken,
  authorization: "Bearer " + await new SignJWT({ actor_id: actor, actor_type: "human", scope: [...scopes], request_id: "request-fictional" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(web.delegatedIssuer).setAudience(CONNECTORS_AUDIENCE)
    .setSubject("fictional-subject").setIssuedAt().setExpirationTime("30s").sign(web.delegatedKey),
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const capabilities = {
  text: true, streaming: true, voice: { enabled: false },
  attachments: { enabled: true, acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"], maxFiles: 3, maxBytes: 1024 },
  agentConversations: true,
};
const upstream = (failing: ReadonlySet<string> = new Set()) => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const [, profile = "", path = ""] = /^\/p\/([^/]+)\/(.*)$/u.exec(url.pathname) ?? [];
  if (failing.has(profile)) throw new TypeError("connect ECONNREFUSED 127.0.0.1:8642 fictional-specialist-a-key");
  const method = init?.method ?? "GET";
  if (path === "v1/capabilities") return json(capabilities);
  if (method === "POST" && path === "api/sessions") {
    const body = JSON.parse(String(init?.body)) as { session_id: string; title: string; source: string };
    return json({ object: "hermes.session", session: { id: body.session_id, title: body.title, source: body.source } });
  }
  if (method === "POST" && path === "v1/runs") return json({ run_id: "run_fictional_01", status: "queued", replayed: false });
  if (method === "GET" && path.startsWith("v1/runs/")) return json({ status: "running", session_id: "pih_fictional" });
  return json({}, 500);
});

const directories: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await disposeHermesHarnesses();
});

const dependenciesFor = (harness: Awaited<ReturnType<typeof createHermesHarness>>): ConnectorModuleDependencies => ({
  config: connectorsConfig, database: harness.database, clock: harness.clock, idGenerator: harness.ids,
});

describe("createHermesModule", () => {
  it("is a standalone module named hermes with status and no migrations property", async () => {
    const harness = await createHermesHarness();
    const module = createHermesModule({ config: harness.config });
    expect(module.name).toBe("hermes");
    expect("migrations" in module).toBe(false);
    expect(typeof module.status).toBe("function");
  });

  it("starts each worker exactly once on ready and drains them in reverse order on close", async () => {
    const harness = await createHermesHarness();
    const order: string[] = [];
    let signal: AbortSignal | undefined;
    const worker = (name: string) => ({
      start: vi.fn(async (received: AbortSignal) => { order.push(`start:${name}`); signal = received; }),
      stop: vi.fn(async () => { order.push(`stop:${name}`); }),
    });
    const server = { start: vi.fn(async () => { order.push("start:server"); }), stop: vi.fn(async () => { order.push("stop:server"); }) };
    const workers = { reconciler: worker("reconciler"), delegationReconciler: worker("delegations"), maintenance: worker("maintenance") };
    let runtime: HermesRuntime | undefined;
    const options: HermesModuleOptions = { config: harness.config, fetch: upstream() as unknown as typeof fetch };
    const module = createHermesModule(options, (dependencies) => {
      runtime = createHermesRuntime(options, dependencies, { delegationServer: server, ...workers });
      return runtime;
    });
    const app = await createConnectorsApp({ ...dependenciesFor(harness), modules: [module] });
    await app.ready();
    expect(order).toEqual(["start:server", "start:reconciler", "start:delegations", "start:maintenance"]);
    for (const started of [server.start, workers.reconciler.start, workers.delegationReconciler.start, workers.maintenance.start]) {
      expect(started).toHaveBeenCalledTimes(1);
    }
    expect(signal?.aborted).toBe(false);
    await app.close();
    expect(order.slice(4)).toEqual(["stop:maintenance", "stop:delegations", "stop:reconciler", "stop:server"]);
    expect(signal?.aborted).toBe(true);
    expect(runtime).toBeDefined();
  });

  it("cancels a worker's in-flight upstream call on close instead of waiting for the client timeout", async () => {
    const harness = await createHermesHarness();
    // Upstream accepts the request and never answers; only the caller's abort signal ends it.
    const stalled = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    let runtime: HermesRuntime | undefined;
    let inFlight: Promise<unknown> | undefined;
    const idle = { start: async () => undefined, stop: async () => undefined };
    // A draining worker awaits its in-flight upstream batch, as resume and reconcile passes do.
    const draining = {
      start: async () => { inFlight = runtime!.routes.conversations.create(principalFor(), { agentId: specialistAId }); },
      stop: async () => { await inFlight?.catch(() => undefined); },
    };
    const options: HermesModuleOptions = { config: harness.config, fetch: stalled as unknown as typeof fetch };
    const module = createHermesModule(options, (dependencies) => {
      runtime = createHermesRuntime(options, dependencies, {
        delegationServer: undefined, reconciler: idle, delegationReconciler: idle, maintenance: draining,
      });
      return runtime;
    });
    const app = await createConnectorsApp({ ...dependenciesFor(harness), modules: [module] });
    await app.ready();
    await vi.waitFor(() => expect(stalled).toHaveBeenCalled());
    const started = performance.now();
    await app.close();
    expect(performance.now() - started).toBeLessThan(1_000);
    await expect(inFlight).rejects.toBeDefined();
  });

  it("projects the configured profiles before routes accept traffic", async () => {
    const harness = await createHermesHarness();
    await harness.database.transaction((db) => db.prepare(
      "INSERT INTO hermes_profiles(id, display_name, enabled, updated_at) VALUES('retired', 'Retired', 1, '2026-01-01T00:00:00.000Z')",
    ).run());
    const options: HermesModuleOptions = { config: harness.config, fetch: upstream() as unknown as typeof fetch };
    const idle = { start: async () => undefined, stop: async () => undefined };
    const module = createHermesModule(options, (dependencies) => createHermesRuntime(options, dependencies, {
      delegationServer: undefined, reconciler: idle, delegationReconciler: idle, maintenance: idle,
    }));
    const app = await createConnectorsApp({ ...dependenciesFor(harness), modules: [module] });
    closers.push(() => app.close());
    const profiles = await harness.database.read((db) => db.prepare("SELECT id, enabled FROM hermes_profiles ORDER BY id").all<{ id: string; enabled: number }>());
    expect(profiles.map(({ id, enabled }) => [id, Number(enabled)])).toEqual([
      ["orchestrator", 1], ["retired", 0], ["specialist-a", 1], ["specialist-b", 1],
    ]);
  });

  it("serves agent delegations only on the separate socket and keeps the two credentials apart", async () => {
    const harness = await createHermesHarness();
    const directory = await mkdtemp(join(tmpdir(), "pih-hermes-module-"));
    directories.push(directory);
    const socketPath = join(directory, "hermes-delegation.sock");
    const delegation = loadDelegationPeerConfig(delegationEnvironment({
      HERMES_DELEGATION_SOCKET_PATH: socketPath, HERMES_DELEGATION_SOCKET_GROUP_ID: String(process.getgid?.() ?? 1),
    }), harness.profiles);
    const options: HermesModuleOptions = { config: harness.config, delegation, fetch: upstream() as unknown as typeof fetch };
    const idle = { start: async () => undefined, stop: async () => undefined };
    const module = createHermesModule(options, (dependencies) => createHermesRuntime(options, dependencies, {
      reconciler: idle, delegationReconciler: idle, maintenance: idle,
    }));
    const app = await createConnectorsApp({ ...dependenciesFor(harness), modules: [module] });
    closers.push(() => app.close());
    await app.ready();
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    const send = (headers: Record<string, string>, path = "/internal/v1/hermes/delegations") => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request({ socketPath, method: "POST", path, headers: { "content-type": "application/json", ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify({ targetAgentId: specialistAId, message: "Revisá la tendencia semanal." }));
    });

    const bff = await webHeaders(ownerActorId, ["hermes:conversations:write"]);
    expect((await send({ ...bff, "idempotency-key": "delegation-key-0001" })).status).toBe(401);
    expect((await send({ authorization: `Bearer ${peerTokenA}`, "idempotency-key": "delegation-key-0001" }, "/v1/conversations")).status).toBe(404);

    const accepted = await send({ authorization: `Bearer ${peerTokenA}`, "idempotency-key": "delegation-key-0001" });
    expect(accepted.status, accepted.body).toBe(201);
    expect(accepted.body).not.toMatch(/run_fictional|pih_bot|127\.0\.0\.1/u);

    const peerOnBff = await app.inject({
      method: "GET", url: "/v1/delegations", headers: { authorization: `Bearer ${peerTokenA}` },
    });
    expect(peerOnBff.statusCode).toBe(401);
    const ledger = await app.inject({ method: "GET", url: "/v1/delegations", headers: await webHeaders(ownerActorId, ["hermes:delegations:read"]) });
    expect(DelegationListSchema.parse(ledger.json()).items).toHaveLength(1);
    const stranger = await app.inject({ method: "GET", url: "/v1/delegations", headers: await webHeaders("22222222-2222-4222-8222-222222222222", ["hermes:delegations:read"]) });
    expect(DelegationListSchema.parse(stranger.json()).items).toEqual([]);

    await app.close();
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("probeHermesStatus", () => {
  it("reports available only when every enabled profile proves authenticated capabilities", async () => {
    const harness = await createHermesHarness();
    const status = SourceStatusSchema.parse(await probeHermesStatus(harness.config, harness.clock, upstream() as unknown as typeof fetch));
    expect(status).toMatchObject({ id: "hermes", state: "available", stale: false });
    expect(status.safeReasonCode).toBeUndefined();
  });

  it("probes profiles independently and reports partial failure as degraded without diagnostics", async () => {
    const harness = await createHermesHarness();
    const fetchMock = upstream(new Set([specialistAId]));
    const status = SourceStatusSchema.parse(await probeHermesStatus(harness.config, harness.clock, fetchMock as unknown as typeof fetch));
    expect(status.state).toBe("degraded");
    expect(status.safeReasonCode).toBe("hermes_profiles_partially_unavailable");
    expect(JSON.stringify(status)).not.toMatch(/127\.0\.0\.1|:8642|fictional|ECONNREFUSED/u);
    const probed = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname).sort();
    expect(probed).toEqual(["/p/orchestrator/v1/capabilities", "/p/specialist-a/v1/capabilities", "/p/specialist-b/v1/capabilities"]);
  });

  it("reports unavailable when no profile answers", async () => {
    const harness = await createHermesHarness();
    const status = await probeHermesStatus(harness.config, harness.clock,
      upstream(new Set(["orchestrator", specialistAId, "specialist-b"])) as unknown as typeof fetch);
    expect(status).toMatchObject({ state: "unavailable", safeReasonCode: "hermes_profiles_unavailable" });
  });
});

describe("Hermes provider registration", () => {
  it("stays unconfigured without Hermes variables", () => {
    expect(hermesConfigNamespace.name).toBe("hermes");
    expect(hermesConfigNamespace.parse({ CONNECTORS_DATABASE_PATH: "/tmp/x.sqlite" })).toBeUndefined();
  });

  it("loads Hermes and optional delegation configuration, failing closed on partial delegation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-hermes-namespace-"));
    directories.push(directory);
    const base = profileEnvironment(join(directory, "uploads"));
    const withoutDelegation = hermesConfigNamespace.parse(base);
    expect(withoutDelegation?.delegation).toBeUndefined();
    const full = hermesConfigNamespace.parse({ ...base, ...delegationEnvironment() });
    expect(full?.delegation?.orchestratorAgentId).toBe("orchestrator");
    expect(JSON.stringify(full)).not.toMatch(/fictional-[a-z-]*-(key|token)/u);
    expect(() => hermesConfigNamespace.parse({ ...base, HERMES_DELEGATION_SOCKET_PATH: "/run/pih-connectors/hermes-delegation.sock" })).toThrow();
    expect(() => hermesConfigNamespace.parse({ ...base, ...delegationEnvironment({ HERMES_DELEGATION_ORCHESTRATOR_ID: undefined }) })).toThrow();
    expect(() => hermesConfigNamespace.parse({ HERMES_API_ORIGIN: "http://127.0.0.1:8642" })).toThrow();
  });

  it("registers an unconfigured module that reports not_configured and serves no Hermes route", async () => {
    const harness = await createHermesHarness();
    expect(hermesProviderModule.name).toBe("hermes");
    const module = hermesProviderModule.create(dependenciesFor(harness));
    const app = await createConnectorsApp({ ...dependenciesFor(harness), modules: [module] });
    closers.push(() => app.close());
    const status = await module.status(dependenciesFor(harness));
    expect(status).toMatchObject({ id: "hermes", state: "not_configured" });
    const response = await app.inject({ method: "GET", url: "/v1/agents", headers: await webHeaders(ownerActorId, ["hermes:agents:read"]) });
    expect(response.statusCode).toBe(404);
  });
});
