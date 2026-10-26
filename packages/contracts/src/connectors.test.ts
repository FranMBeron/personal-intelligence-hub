import { describe, expect, it } from "vitest";

import {
  ConnectorScopeSchema,
  ConnectorServiceIdSchema,
  DelegatedAuthorizationClaimsSchema,
  DelegatedPrincipalSchema,
} from "./auth.js";
import { SourceStatusSchema, SystemStatusSchema } from "./connectors.js";
import { ApiProblemCodeSchema } from "./errors.js";

describe("private connector contracts", () => {
  it("accepts only frozen connector services and scopes", () => {
    expect(ConnectorServiceIdSchema.parse("hermes-central")).toBe("hermes-central");
    expect(ConnectorScopeSchema.parse("calendar:confirm")).toBe("calendar:confirm");
    expect(ConnectorScopeSchema.safeParse("calendar:admin").success).toBe(false);
  });

  it("keeps delegated identity and authorization claims strict", () => {
    const actorId = "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10";

    expect(DelegatedPrincipalSchema.parse({
      serviceId: "pih-web",
      subject: "fictional-user",
      actorId,
      actorType: "human",
      scopes: ["hermes:conversations:read"],
      requestId: "fictional-request",
    }).actorId).toBe(actorId);
    expect(DelegatedAuthorizationClaimsSchema.safeParse({
      actor_id: actorId,
      actor_type: "human",
      scope: ["hermes:conversations:read"],
      request_id: "fictional-request",
      service_id: "pih-web",
    }).success).toBe(false);
  });

  it("keeps reauthorization distinct from temporary degradation", () => {
    const status = SourceStatusSchema.parse({
      id: "calendar",
      state: "requires_reauthorization",
      checkedAt: "2026-10-12T12:00:00.000Z",
      lastSuccessAt: "2026-10-11T12:00:00.000Z",
      stale: false,
      capabilities: ["calendar:read"],
      safeReasonCode: "reauthorization_required",
    });
    expect(status.state).toBe("requires_reauthorization");
    expect(SystemStatusSchema.parse({ sources: [status] }).sources).toEqual([status]);
    expect(SourceStatusSchema.safeParse({
      id: "calendar",
      state: "available",
      checkedAt: "2026-10-12T12:00:00.000Z",
      stale: false,
      capabilities: [],
      host: "private-host",
    }).success).toBe(false);
  });

  it("exports the expired event cursor problem", () => {
    expect(ApiProblemCodeSchema.parse("event_cursor_expired")).toBe("event_cursor_expired");
  });

  it("exports the connector concurrency and rate-limit problems", () => {
    expect(ApiProblemCodeSchema.parse("version_conflict")).toBe("version_conflict");
    expect(ApiProblemCodeSchema.parse("rate_limit_exceeded")).toBe("rate_limit_exceeded");
  });
});
