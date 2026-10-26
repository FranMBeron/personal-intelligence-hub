// @vitest-environment jsdom

import type { DeviceConnectionStatus as Status } from "@personal-intelligence-hub/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeviceConnectionStatus } from "./device-connection-status";

afterEach(cleanup);

const status = (overrides: Partial<Status> = {}): Status => ({
  connectionId: "example-band", label: "Example band", state: "unavailable", reasonCode: null,
  checkedAt: "2026-10-26T12:00:00.000Z", ...overrides,
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const deferred = () => {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};

const renderWith = (fetcher: typeof fetch, initialStatus: Status | null = status()) =>
  render(<DeviceConnectionStatus connectionId="example-band" initialStatus={initialStatus} fetcher={fetcher} />);

const reconnectWith = async (response: Response | Promise<Response>) => {
  const fetcher = vi.fn(async () => response) as unknown as typeof fetch;
  renderWith(fetcher);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reconectar" })); });
  return fetcher;
};

describe("DeviceConnectionStatus", () => {
  it("shows the initial status honestly", () => {
    renderWith(vi.fn() as unknown as typeof fetch, status({ state: "unavailable" }));
    expect(screen.getByText("Example band")).toBeTruthy();
    expect(screen.getByText("No disponible")).toBeTruthy();
    expect(screen.queryByText("Conectada")).toBeNull();
  });

  it("loads the status when none is provided", async () => {
    const fetcher = vi.fn(async () => json(status({ state: "connected" }))) as unknown as typeof fetch;
    renderWith(fetcher, null);

    expect(await screen.findByText("Conectada")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith("/api/ui/v1/device-connections/example-band", expect.objectContaining({ cache: "no-store" }));
  });

  it("disables the button while reconnecting and never shows success optimistically", async () => {
    const pending = deferred();
    const fetcher = vi.fn(() => pending.promise) as unknown as typeof fetch;
    renderWith(fetcher);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reconectar" })); });

    const button = screen.getByRole("button", { name: "Reconectando…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByText("Conectada")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/ui/v1/device-connections/example-band/reconnect", expect.objectContaining({ method: "POST" }));
    const [, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();

    await act(async () => { pending.resolve(json(status({ state: "connected" }))); });
    expect(await screen.findByText("Conectada")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reconectar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks to wake the device when the bridge reports it unavailable", async () => {
    await reconnectWith(json(status({ state: "unavailable", reasonCode: "device_unreachable", action: "wake_device" })));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Despierta el dispositivo.*vuelve a intentarlo/u);
    expect(screen.queryByText("Conectada")).toBeNull();
  });

  it("tells the person how long to wait during a cooldown", async () => {
    await reconnectWith(json(status({ state: "failed", reasonCode: "cooldown", retryAfterSeconds: 42 })));
    expect((await screen.findByRole("alert")).textContent).toContain("42 s");
  });

  it("reports a reconnect that is still running without claiming success", async () => {
    await reconnectWith(json(status({ state: "connecting", reasonCode: "in_progress" })));
    expect((await screen.findByRole("alert")).textContent).toContain("sigue en curso");
    expect(screen.queryByText("Conectada")).toBeNull();
  });

  it.each([
    [json({ code: "forbidden" }, { status: 403 }), "No tienes permiso"],
    [json(status({ state: "failed", reasonCode: "actor_not_allowed" })), "No tienes permiso"],
    [json(status({ state: "failed", reasonCode: "unspecified" })), "No se pudo reconectar"],
    [json({ code: "dependency_unavailable" }, { status: 503 }), "No se pudo contactar"],
    [json({ code: "too_many_requests" }, { status: 429 }), "Demasiados intentos"],
    [json({ ...status(), state: "connected", extra: "x" }), "No se pudo contactar"],
  ] as const)("shows an actionable message for failure %#", async (response, text) => {
    await reconnectWith(response);
    expect((await screen.findByRole("alert")).textContent).toContain(text);
    expect(screen.queryByText("Conectada")).toBeNull();
  });

  it("shows a network failure as an error, not success", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    renderWith(fetcher);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reconectar" })); });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No se pudo contactar"));
    expect(screen.queryByText("Conectada")).toBeNull();
  });
});
