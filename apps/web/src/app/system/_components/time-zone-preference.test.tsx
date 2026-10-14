// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { preferencesFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { TimeZonePreference } from "./time-zone-preference";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Call = { path: string; method: string; body: unknown };
const record = (calls: Call[], respond: (call: Call) => Response | Promise<Response>) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const call = { path: String(input), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
  calls.push(call);
  return respond(call);
});

const fill = (value: string) => fireEvent.change(screen.getByLabelText("Zona horaria"), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Guardar zona horaria" }));

describe("TimeZonePreference", () => {
  it("shows the stored zone without writing on mount", () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", record(calls, () => { throw new Error("unexpected"); }));
    render(<TimeZonePreference initial={preferencesFixture({ timeZone: "Europe/Madrid", version: 4 })} />);
    expect((screen.getByLabelText("Zona horaria") as HTMLInputElement).value).toBe("Europe/Madrid");
    expect(calls).toEqual([]);
  });

  it("rejects a zone that is not a real IANA zone without a request", () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", record(calls, () => { throw new Error("unexpected"); }));
    render(<TimeZonePreference initial={preferencesFixture()} />);
    fill("Mars/Olympus_Mons");
    save();
    expect(screen.getByRole("alert").textContent).toMatch(/zona horaria IANA válida/);
    expect(screen.getByLabelText("Zona horaria").getAttribute("aria-invalid")).toBe("true");
    expect(calls).toEqual([]);
  });

  it("patches only the zone and expected version, then shows the stored value", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", record(calls, () => Response.json(preferencesFixture({ timeZone: "Asia/Tokyo", version: 2 }))));
    const onSaved = vi.fn();
    render(<TimeZonePreference initial={preferencesFixture({ timeZone: "Etc/UTC", version: 1 })} onSaved={onSaved} />);
    fill("Asia/Tokyo");
    save();
    expect((await screen.findByRole("status")).textContent).toMatch(/Zona horaria guardada: Asia\/Tokyo/);
    expect(calls).toEqual([{ path: "/api/ui/v1/preferences", method: "PATCH", body: { timeZone: "Asia/Tokyo", expectedVersion: 1 } }]);
    expect(onSaved).toHaveBeenCalledWith({ timeZone: "Asia/Tokyo", version: 2 });
  });

  it("reloads after a conflict instead of overwriting another device", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", record(calls, (call) => call.method === "PATCH"
      ? Response.json({ type: "about:blank", title: "Conflict", status: 409, code: "version_conflict" }, { status: 409 })
      : Response.json(preferencesFixture({ timeZone: "America/Mexico_City", version: 7 }))));
    render(<TimeZonePreference initial={preferencesFixture({ timeZone: "Etc/UTC", version: 1 })} />);
    fill("Asia/Tokyo");
    save();
    expect((await screen.findByRole("alert")).textContent).toMatch(/otro dispositivo/);
    await waitFor(() => expect((screen.getByLabelText("Zona horaria") as HTMLInputElement).value).toBe("America/Mexico_City"));
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "GET"]);

    vi.stubGlobal("fetch", record(calls, () => Response.json(preferencesFixture({ timeZone: "Asia/Tokyo", version: 8 }))));
    fill("Asia/Tokyo");
    save();
    await screen.findByText(/Zona horaria guardada: Asia\/Tokyo/);
    expect(calls.at(-1)?.body).toEqual({ timeZone: "Asia/Tokyo", expectedVersion: 7 });
  });

  it("disables saving while a request is pending", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    render(<TimeZonePreference initial={preferencesFixture({ version: 1 })} />);
    fill("Asia/Tokyo");
    const button = screen.getByRole("button", { name: "Guardar zona horaria" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(screen.getByRole("form", { name: "Preferencia de zona horaria" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Guardando…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release(Response.json(preferencesFixture({ timeZone: "Asia/Tokyo", version: 2 }))));
    await screen.findByText(/Zona horaria guardada/);
  });

  it("explains a failed save without changing the stored value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    render(<TimeZonePreference initial={preferencesFixture({ timeZone: "Etc/UTC", version: 1 })} />);
    fill("Asia/Tokyo");
    save();
    expect((await screen.findByRole("alert")).textContent).toMatch(/No se pudo guardar/);
    expect(screen.getByText(/Zona actual:/).textContent).toContain("Etc/UTC");
  });
});
