// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { conversationFixture, selectionFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { ThreadWorkspace } from "./thread-workspace";

const capabilities: HermesCapabilities = {
  text: true, streaming: false, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: false,
};
const emptyList = { items: [], pageInfo: { nextCursor: null, hasNextPage: false } };
const history = { items: [], pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "0" };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ThreadWorkspace", () => {
  it("opens without writes; first explicit send resolves and persists the per-agent main thread", async () => {
    const main = conversationFixture({ id: "main-thread", agentId: "research", isMain: true, title: "Principal" });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/conversation-selection")) {
        return Response.json(init?.method === "PUT"
          ? selectionFixture({ agentId: "research", conversationId: "main-thread", version: 1 })
          : selectionFixture({ agentId: "research", conversationId: null, version: 0 }));
      }
      if (path.endsWith("/conversations?agentId=research&archived=false&limit=50")) return Response.json(emptyList);
      if (path.endsWith("/conversations?agentId=research&archived=true&limit=50")) return Response.json(emptyList);
      if (path.endsWith("/agents/research/main-conversation")) return Response.json(main);
      if (path.endsWith("/conversations/main-thread/messages?limit=50")) return Response.json(history);
      if (path.endsWith("/conversations/main-thread/messages") && init?.method === "POST") return Response.json({
        id: "message-1", conversationId: "main-thread", role: "user", parts: [{ kind: "text", text: "Hola" }],
        deliveryState: "accepted", createdAt: "2026-10-12T12:00:00.000Z",
      });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Nueva conversación" });
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes("main-conversation") || init?.method === "POST")).toBe(false);

    fireEvent.change(screen.getByLabelText("Mensaje para Research"), { target: { value: "Hola" } });
    fireEvent.submit(screen.getByRole("form", { name: "Conversación con Research" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST")).toBe(true));
    const mainCall = fetcher.mock.calls.find(([input]) => String(input).includes("main-conversation"));
    expect(mainCall?.[1]?.method).toBe("PUT");
    const selectionWrites = fetcher.mock.calls.filter(([input, init]) => String(input).endsWith("conversation-selection") && init?.method === "PUT");
    expect(selectionWrites).toHaveLength(1);
    expect(fetcher.mock.calls.findIndex(([input]) => String(input).includes("main-conversation"))).toBeLessThan(
      fetcher.mock.calls.findIndex(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST"),
    );
  });

  it("binds an uploaded image to the newly resolved main thread before sending", async () => {
    const main = conversationFixture({ id: "main-with-image", agentId: "research", isMain: true });
    const imageCapabilities: HermesCapabilities = {
      ...capabilities,
      attachments: { enabled: true, acceptedMimeTypes: ["image/png"], maxFiles: 2, maxBytes: 1024 },
    };
    const calls: Array<{ path: string; method: string; body?: BodyInit | null | undefined }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      if (path.endsWith("/conversation-selection")) return Response.json(init?.method === "PUT"
        ? selectionFixture({ agentId: "research", conversationId: main.id, version: 1 })
        : selectionFixture({ agentId: "research", conversationId: null, version: 0 }));
      if (path.includes("/conversations?agentId=research")) return Response.json(emptyList);
      if (path.endsWith("/agents/research/main-conversation")) return Response.json(main);
      if (path.endsWith("/uploads")) return Response.json({
        reference: "image-ref", kind: "attachment", name: "chart.png", mimeType: "image/png", size: 5,
        expiresAt: "2026-10-12T12:00:00.000Z",
      });
      if (path.endsWith("/messages?limit=50")) return Response.json(history);
      if (path.endsWith("/messages") && init?.method === "POST") return Response.json({
        id: "message-image", conversationId: main.id, role: "user",
        parts: [{ kind: "attachment", reference: "image-ref", name: "chart.png", mimeType: "image/png", size: 5 }],
        deliveryState: "accepted", createdAt: "2026-10-12T12:00:00.000Z",
      });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={imageCapabilities} />);
    await screen.findByRole("button", { name: "Nueva conversación" });
    const file = new File(["image"], "chart.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.submit(screen.getByRole("form", { name: "Conversación con Research" }));
    await screen.findByText("chart.png");

    const uploadCall = calls.find((call) => call.path.endsWith("/uploads"));
    expect(uploadCall?.body).toBeInstanceOf(FormData);
    expect((uploadCall?.body as FormData).get("conversationId")).toBe(main.id);
    const mainIndex = calls.findIndex((call) => call.path.endsWith("/main-conversation"));
    const uploadIndex = calls.findIndex((call) => call.path.endsWith("/uploads"));
    const sendIndex = calls.findIndex((call) => call.path.endsWith("/messages") && call.method === "POST");
    expect(mainIndex).toBeLessThan(uploadIndex);
    expect(uploadIndex).toBeLessThan(sendIndex);
  });

  it("reloads persisted selection after a 409 without replaying the failed write", async () => {
    const first = conversationFixture({ id: "thread-1", agentId: "research", isMain: false, title: "Uno" });
    const second = conversationFixture({ id: "thread-2", agentId: "research", isMain: false, title: "Dos" });
    let selectionReads = 0;
    let selectionWrites = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/conversation-selection")) {
        if (init?.method === "PUT") { selectionWrites += 1; return Response.json({ detail: "conflict" }, { status: 409 }); }
        selectionReads += 1;
        return Response.json(selectionFixture({ agentId: "research", conversationId: selectionReads === 1 ? "thread-1" : "thread-2", version: selectionReads - 1 }));
      }
      if (path.includes("/conversations?agentId=research")) return Response.json({ items: [first, second], pageInfo: emptyList.pageInfo });
      if (path.includes("/messages?limit=")) return Response.json(history);
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Seleccionar Dos" });
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar Uno" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toMatch(/se actualizó en otro lugar/i);
    expect(selectionWrites).toBe(1);
    expect(selectionReads).toBe(2);
    expect(screen.getByRole("button", { name: "Seleccionar Dos" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("creates additional threads only after an explicit create action", async () => {
    const created = conversationFixture({ id: "thread-new", agentId: "research", isMain: false, title: "Nueva conversación" });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/conversation-selection") && init?.method === "PUT") return Response.json(selectionFixture({ agentId: "research", conversationId: created.id, version: 1 }));
      if (path.endsWith("/conversation-selection")) return Response.json(selectionFixture({ agentId: "research", conversationId: null, version: 0 }));
      if (path.includes("/conversations?agentId=research")) return Response.json(emptyList);
      if (path === "/api/ui/v1/conversations") return Response.json(created, { status: 201 });
      if (path.includes("/messages?limit=")) return Response.json(history);
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    fireEvent.click(await screen.findByRole("button", { name: "Nueva conversación" }));
    await screen.findByRole("log");
    expect(fetcher.mock.calls.some(([input, init]) => String(input) === "/api/ui/v1/conversations" && init?.method === "POST")).toBe(true);
    expect(fetcher.mock.calls.filter(([input, init]) => String(input).endsWith("conversation-selection") && init?.method === "PUT")).toHaveLength(1);
  });

  it("uses returned versions for rename, archive and restore mutations", async () => {
    const main = conversationFixture({ id: "main-thread", agentId: "research", isMain: true, title: "Principal" });
    const extra = conversationFixture({ id: "extra-thread", agentId: "research", isMain: false, title: "Ideas", version: 6 });
    const patchVersions: number[] = [];
    let updatedExtra = extra;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/conversation-selection")) return Response.json(selectionFixture({ agentId: "research", conversationId: main.id, version: 1 }));
      if (path.includes("/conversations?agentId=research")) return Response.json({ items: path.includes("archived=true") ? [] : [main, extra], pageInfo: emptyList.pageInfo });
      if (path.includes("/messages?limit=50")) return Response.json(history);
      if (path.endsWith("/extra-thread") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { expectedVersion: number; title?: string; archived?: boolean };
        patchVersions.push(body.expectedVersion);
        updatedExtra = conversationFixture({
          ...updatedExtra, title: body.title ?? updatedExtra.title, archived: body.archived ?? false, version: body.expectedVersion + 1,
        });
        return Response.json(updatedExtra);
      }
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    fireEvent.click(await screen.findByRole("button", { name: "Renombrar Ideas" }));
    const title = await screen.findByRole("textbox", { name: "Nuevo título para Ideas" });
    fireEvent.change(title, { target: { value: "Plan actualizado" } });
    fireEvent.submit(title.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Archivar Plan actualizado" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar Plan actualizado" }));
    await waitFor(() => expect(patchVersions).toEqual([6, 7, 8]));
  });

  it("restores the persisted selection and server history after remount without writes", async () => {
    const selected = conversationFixture({ id: "thread-kept", agentId: "research", isMain: false, title: "Guardada" });
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/conversation-selection")) return Response.json(selectionFixture({ agentId: "research", conversationId: "thread-kept", version: 4 }));
      if (path.includes("/conversations?agentId=research")) return Response.json({ items: [selected], pageInfo: emptyList.pageInfo });
      if (path.endsWith("/messages?limit=50")) return Response.json({
        ...history, items: [{ id: "persisted-message", conversationId: "thread-kept", role: "assistant", parts: [{ kind: "text", text: "Historial recuperado" }], deliveryState: "completed", createdAt: "2026-10-12T12:00:00.000Z" }],
      });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    expect(await screen.findByText("Historial recuperado")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar selector" }));
    expect(document.activeElement?.textContent).toContain("Abrir selector de conversaciones");
    view.unmount();
    render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    expect(await screen.findByText("Historial recuperado")).toBeTruthy();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT" || init?.method === "POST")).toBe(false);
  });

  const crossAgentFetcher = (deferredPut: { release?: (response: Response) => void }, extra?: (path: string, init?: RequestInit) => Promise<Response> | undefined) => {
    const research = conversationFixture({ id: "research-main", agentId: "research", isMain: true, title: "Research main" });
    const researchOther = conversationFixture({ id: "research-other", agentId: "research", isMain: false, title: "Research other" });
    const planning = conversationFixture({ id: "planning-main", agentId: "planning", isMain: true, title: "Planning main" });
    return vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      const agentId = path.includes("/agents/planning/") || path.includes("agentId=planning") ? "planning" : "research";
      const custom = extra?.(path, init);
      if (custom !== undefined) return custom;
      if (path.endsWith("/conversation-selection") && init?.method === "PUT" && agentId === "research") {
        return new Promise((resolve) => { deferredPut.release = resolve; });
      }
      if (path.endsWith("/conversation-selection")) return Promise.resolve(Response.json(selectionFixture({
        agentId, conversationId: agentId === "research" ? research.id : planning.id, version: 1,
      })));
      if (path.includes("/conversations?agentId=")) return Promise.resolve(Response.json({
        items: path.includes("archived=true") ? [] : agentId === "research" ? [research, researchOther] : [planning], pageInfo: emptyList.pageInfo,
      }));
      if (path.includes("/messages?limit=50")) return Promise.resolve(Response.json(history));
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
  };

  it("drops a late selection response from the previous agent instead of binding it to the new workspace", async () => {
    const deferred: { release?: (response: Response) => void } = {};
    const fetcher = crossAgentFetcher(deferred);
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    fireEvent.click(await screen.findByRole("button", { name: "Seleccionar Research other" }));
    await waitFor(() => expect(deferred.release).toBeDefined());
    view.rerender(<ThreadWorkspace agentId="planning" agentName="Planning" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Seleccionar Planning main" });
    deferred.release?.(Response.json(selectionFixture({ agentId: "research", conversationId: "research-other", version: 2 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/research-other/messages"))).toBe(false);
    expect(screen.getByRole("button", { name: "Seleccionar Planning main" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("drops a late create response from the previous agent", async () => {
    const deferred: { release?: (response: Response) => void } = {};
    let releaseCreate: ((response: Response) => void) | undefined;
    const fetcher = crossAgentFetcher(deferred, (path, init) => path === "/api/ui/v1/conversations" && init?.method === "POST"
      ? new Promise((resolve) => { releaseCreate = resolve; })
      : undefined);
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Seleccionar Research other" });
    fireEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
    await waitFor(() => expect(releaseCreate).toBeDefined());
    view.rerender(<ThreadWorkspace agentId="planning" agentName="Planning" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Seleccionar Planning main" });
    releaseCreate?.(Response.json(conversationFixture({ id: "research-late", agentId: "research", isMain: false, title: "Research tardía" }), { status: 201 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Seleccionar Research tardía" })).toBeNull();
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes("/agents/research/conversation-selection") && init?.method === "PUT")).toBe(false);
    expect(screen.getByRole("button", { name: "Seleccionar Planning main" }).getAttribute("aria-pressed")).toBe("true");
  });

  const selectedOtherFetcher = (extra: (path: string, init?: RequestInit) => Promise<Response> | undefined) => {
    const research = conversationFixture({ id: "research-main", agentId: "research", isMain: true, title: "Research main" });
    const researchOther = conversationFixture({ id: "research-other", agentId: "research", isMain: false, title: "Research other" });
    const planning = conversationFixture({ id: "planning-main", agentId: "planning", isMain: true, title: "Planning main" });
    return vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      const agentId = path.includes("/agents/planning/") || path.includes("agentId=planning") ? "planning" : "research";
      const custom = extra(path, init);
      if (custom !== undefined) return custom;
      if (path.endsWith("/conversation-selection")) return Promise.resolve(Response.json(selectionFixture({
        agentId, conversationId: agentId === "research" ? researchOther.id : planning.id, version: 1,
      })));
      if (path.includes("/conversations?agentId=")) return Promise.resolve(Response.json({
        items: path.includes("archived=true") ? [] : agentId === "research" ? [research, researchOther] : [planning], pageInfo: emptyList.pageInfo,
      }));
      if (path.includes("/messages?limit=50")) return Promise.resolve(Response.json(history));
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
  };

  it("does not send the archive request when the agent changes while switching away from the archived thread", async () => {
    let releasePut: ((response: Response) => void) | undefined;
    const fetcher = selectedOtherFetcher((path, init) => path.includes("/agents/research/conversation-selection") && init?.method === "PUT"
      ? new Promise((resolve) => { releasePut = resolve; })
      : undefined);
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archivar Research other" }));
    await waitFor(() => expect(releasePut).toBeDefined());
    view.rerender(<ThreadWorkspace agentId="planning" agentName="Planning" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Seleccionar Planning main" });
    releasePut?.(Response.json(selectionFixture({ agentId: "research", conversationId: "research-main", version: 2 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(screen.queryByRole("button", { name: "Restaurar Research other" })).toBeNull();
  });

  it("does not show a previous agent's late rename failure in the new agent's selector", async () => {
    let rejectRename: ((response: Response) => void) | undefined;
    const fetcher = selectedOtherFetcher((path, init) => path.endsWith("/research-other") && init?.method === "PATCH"
      ? new Promise((resolve) => { rejectRename = resolve; })
      : undefined);
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    fireEvent.click(await screen.findByRole("button", { name: "Renombrar Research other" }));
    const title = await screen.findByRole("textbox", { name: "Nuevo título para Research other" });
    fireEvent.change(title, { target: { value: "Otro nombre" } });
    fireEvent.submit(title.closest("form")!);
    await waitFor(() => expect(rejectRename).toBeDefined());
    view.rerender(<ThreadWorkspace agentId="planning" agentName="Planning" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Seleccionar Planning main" });
    rejectRename?.(Response.json({ detail: "conflict" }, { status: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves the specific archive guidance when the active thread cannot fall back to main", async () => {
    const extra = conversationFixture({ id: "extra-thread", agentId: "research", isMain: false, title: "Ideas" });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/conversation-selection")) return Response.json(selectionFixture({ agentId: "research", conversationId: extra.id, version: 1 }));
      if (path.includes("/conversations?agentId=research")) return Response.json({ items: path.includes("archived=true") ? [] : [extra], pageInfo: emptyList.pageInfo });
      if (path.includes("/messages?limit=50")) return Response.json(history);
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archivar Ideas" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Cambia la conversación activa antes de archivarla.");
  });

  it("disables thread creation with a visible explanation when the list failed to load", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/conversation-selection")) return Response.json(selectionFixture({ agentId: "research", conversationId: null, version: 0 }));
      if (path.includes("/conversations?agentId=research")) return Response.json({ detail: "unavailable" }, { status: 503 });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    await screen.findByText("No se pudieron cargar las conversaciones guardadas.");
    const create = screen.getByRole("button", { name: "Nueva conversación" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    const help = document.getElementById(create.getAttribute("aria-describedby") ?? "");
    expect(help?.textContent).toMatch(/no se pueden crear conversaciones/iu);
    fireEvent.click(create);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("isolates and aborts conversation state when switching agents", async () => {
    const research = conversationFixture({ id: "research-main", agentId: "research", isMain: true, title: "Research main" });
    const planning = conversationFixture({ id: "planning-main", agentId: "planning", isMain: true, title: "Planning main" });
    let releaseOld: ((response: Response) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      const agentId = path.includes("/agents/planning/") || path.includes("agentId=planning") ? "planning" : "research";
      if (path.endsWith("/conversation-selection")) return Promise.resolve(Response.json(selectionFixture({
        agentId, conversationId: agentId === "research" ? research.id : planning.id, version: 1,
      })));
      if (path.includes("/conversations?agentId=")) return Promise.resolve(Response.json({
        items: [agentId === "research" ? research : planning], pageInfo: emptyList.pageInfo,
      }));
      if (path.includes("/research-main/messages?limit=50")) {
        oldSignal = init?.signal ?? undefined;
        return new Promise((resolve) => { releaseOld = resolve; });
      }
      if (path.includes("/planning-main/messages?limit=50")) return Promise.resolve(Response.json({
        ...history, items: [{ id: "planning-message", conversationId: planning.id, role: "assistant", parts: [{ kind: "text", text: "Historial de Planning" }], deliveryState: "completed", createdAt: "2026-10-12T12:00:00.000Z" }],
      }));
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={capabilities} />);
    await screen.findByRole("button", { name: "Seleccionar Research main" });
    view.rerender(<ThreadWorkspace agentId="planning" agentName="Planning" capabilities={capabilities} />);
    expect(await screen.findByText("Historial de Planning")).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);
    releaseOld?.(Response.json({
      ...history, items: [{ id: "research-message", conversationId: research.id, role: "assistant", parts: [{ kind: "text", text: "Historial privado de Research" }], deliveryState: "completed", createdAt: "2026-10-12T12:00:00.000Z" }],
    }));
    await waitFor(() => expect(screen.queryByText("Historial privado de Research")).toBeNull());
    expect(screen.getByRole("button", { name: "Seleccionar Planning main" }).getAttribute("aria-pressed")).toBe("true");
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/agents/planning/conversation-selection"))).toBe(true);
  });
  it("shows a linked thread without changing the persisted selection until the user makes it active", async () => {
    const active = conversationFixture({ id: "active-thread", agentId: "central", isMain: true, title: "Principal" });
    const linked = conversationFixture({ id: "linked-thread", agentId: "central", title: "Origen de delegación" });
    const calls: Array<{ path: string; method: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (path.endsWith("/agents/central/conversation-selection")) return Response.json(method === "PUT"
        ? selectionFixture({ agentId: "central", conversationId: linked.id, version: 5 })
        : selectionFixture({ agentId: "central", conversationId: active.id, version: 4 }));
      if (path.endsWith("/conversations?agentId=central&archived=false&limit=50")) return Response.json({ items: [active], pageInfo: emptyList.pageInfo });
      if (path.endsWith("/conversations?agentId=central&archived=true&limit=50")) return Response.json(emptyList);
      if (path.endsWith("/conversations/linked-thread")) return Response.json(linked);
      if (path.includes("/messages?limit=50")) return Response.json(history);
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="central" agentName="Central" capabilities={capabilities} requestedConversationId="linked-thread" />);
    const linkedButton = await screen.findByRole("button", { name: "Seleccionar Origen de delegación" });
    await waitFor(() => expect(linkedButton.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText(/Tu conversación activa no cambió/u)).toBeTruthy();
    expect(screen.queryByText("Hilo activo")).toBeNull();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Usar como conversación activa" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1));
    const write = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ conversationId: "linked-thread", expectedVersion: 4 });
    await waitFor(() => expect(screen.queryByText(/Tu conversación activa no cambió/u)).toBeNull());
  });

  it("never shows a linked thread that belongs to another agent", async () => {
    const active = conversationFixture({ id: "active-thread", agentId: "central", isMain: true, title: "Principal" });
    const foreign = conversationFixture({ id: "foreign-thread", agentId: "finance", title: "Hilo ajeno" });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method !== undefined && init.method !== "GET") throw new Error("Unexpected mutation");
      if (path.endsWith("/conversation-selection")) return Response.json(selectionFixture({ agentId: "central", conversationId: active.id, version: 1 }));
      if (path.includes("/conversations?agentId=central&archived=false")) return Response.json({ items: [active], pageInfo: emptyList.pageInfo });
      if (path.includes("/conversations?agentId=central&archived=true")) return Response.json(emptyList);
      if (path.endsWith("/conversations/foreign-thread")) return Response.json(foreign);
      if (path.includes("/messages?limit=50")) return Response.json(history);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ThreadWorkspace agentId="central" agentName="Central" capabilities={capabilities} requestedConversationId="foreign-thread" />);
    expect(await screen.findByText("La conversación solicitada no está disponible. Se muestra tu conversación activa.")).toBeTruthy();
    expect(screen.queryByText("Hilo ajeno")).toBeNull();
    expect(screen.getByRole("button", { name: "Seleccionar Principal" }).getAttribute("aria-pressed")).toBe("true");
  });
});
