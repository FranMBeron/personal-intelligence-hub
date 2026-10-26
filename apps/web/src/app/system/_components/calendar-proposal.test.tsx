// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarChangeProposal, CalendarEventDetail } from "@personal-intelligence-hub/contracts";
import { proposalFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { BffRequestError } from "../../_lib/bff-request";
import { CalendarClient } from "./calendar-client";
import { CalendarEventActions, CalendarProposal } from "./calendar-proposal";
import { fakeCalendarClient } from "./calendar-test-client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const now = "2026-10-12T12:00:00.000Z";
const before = { title: "Revisión semanal", time: { kind: "timed", start: "2026-10-13T14:00:00.000Z", end: "2026-10-13T15:00:00.000Z", timeZone: "Europe/Madrid" }, attendeeCount: 3 } as const;
const after = { ...before, time: { ...before.time, start: "2026-10-13T16:00:00.000Z", end: "2026-10-13T17:00:00.000Z" } } as const;
const updateProposal = proposalFixture({
  summary: { operation: "update", calendarDisplayName: "Trabajo", timeZone: "Europe/Madrid", recurrenceScope: "series", organizerRelationship: "self", guestNotification: "all", before, after },
});

describe("CalendarProposal", () => {
  it("keeps its live regions mounted and empty until there is something to announce", async () => {
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => proposalFixture()), confirm: vi.fn(async () => { throw new BffRequestError(403, null); }) })} now={now} />);
    await screen.findByRole("button", { name: "Confirmar cambio" });
    const alert = screen.getByRole("alert");
    const status = screen.getByRole("status");
    expect(alert.textContent).toBe("");
    expect(status.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cambio" }));
    await waitFor(() => expect(alert.textContent).toMatch(/no tiene permiso/));
    expect(screen.getByRole("alert")).toBe(alert);
  });

  it("opening a proposal never executes it", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected ${init?.method} ${String(input)}`);
      return Response.json(proposalFixture({ status: "pending" }));
    });
    const client = new CalendarClient(fetcher);
    const confirmRequestSpy = vi.spyOn(client, "confirm");
    render(<CalendarProposal proposalId="proposal-fictional" client={client} now={now} />);
    await screen.findByRole("button", { name: "Confirmar cambio" });
    expect(confirmRequestSpy).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("shows before/after, destination, zone, scope, organizer, notifications and expiry", async () => {
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => updateProposal) })} now={now} />);
    const review = await screen.findByRole("region", { name: "Revisar propuesta: Modificar evento" });
    expect(review.textContent).toContain("Antes");
    expect(review.textContent).toContain("Después");
    expect(review.textContent).toContain("16:00");
    expect(review.textContent).toContain("18:00");
    expect(review.textContent).toContain("Trabajo");
    expect(review.textContent).toContain("Europe/Madrid");
    expect(review.textContent).toContain("Toda la serie");
    expect(review.textContent).toContain("Lo organizas tú");
    expect(review.textContent).toContain("Se notificará a todos los invitados");
    const expiry = screen.getByText(/Vence/);
    expect(expiry.querySelector("time")?.getAttribute("dateTime")).toBe(updateProposal.expiresAt);
  });

  it("renders an untrusted title as inert text", async () => {
    const hostile = proposalFixture({ summary: { ...updateProposal.summary, after: { ...after, title: "<img src=x onerror=alert(1)>**negrita**" } } });
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => hostile) })} now={now} />);
    await screen.findByText("<img src=x onerror=alert(1)>**negrita**");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("strong em, em")).toBeNull();
  });

  it("sends a single confirmation even when clicked twice while pending", async () => {
    let release: (value: CalendarChangeProposal) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<CalendarChangeProposal>((resolve) => { release = resolve; }));
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => proposalFixture({ version: 5 })), confirm })} now={now} />);
    const button = await screen.findByRole("button", { name: "Confirmar cambio" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("fictional-proposal", 5);
    expect((screen.getByRole("button", { name: "Descartar propuesta" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release(proposalFixture({ version: 6, status: "completed", completedAt: now })));
    const result = await screen.findByRole("heading", { name: "Cambio aplicado" });
    await waitFor(() => expect(document.activeElement).toBe(result));
    expect(screen.queryByRole("button", { name: "Confirmar cambio" })).toBeNull();
  });

  it("discards a proposal with its own action and version", async () => {
    const reject = vi.fn(async () => proposalFixture({ version: 3, status: "rejected" }));
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => proposalFixture({ version: 2 })), reject })} now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Descartar propuesta" }));
    await screen.findByRole("heading", { name: "Propuesta rechazada" });
    expect(reject).toHaveBeenCalledWith("fictional-proposal", 2);
  });

  it("polls an executing result until it is terminal", async () => {
    vi.useFakeTimers();
    const proposal = vi.fn()
      .mockResolvedValueOnce(proposalFixture({ version: 1 }))
      .mockResolvedValueOnce(proposalFixture({ version: 2, status: "executing" }))
      .mockResolvedValueOnce(proposalFixture({ version: 3, status: "completed", completedAt: now }));
    const confirm = vi.fn(async () => proposalFixture({ version: 2, status: "executing" }));
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal, confirm })} now={now} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cambio" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Aplicando el cambio/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("heading", { name: "Cambio aplicado" })).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["expired", "La propuesta venció"],
    ["conflict", "El evento cambió después de la propuesta"],
    ["rejected", "Propuesta rechazada"],
    ["failed", "No se pudo aplicar el cambio"],
  ] as const)("shows a %s proposal without a confirm action", async (status, heading) => {
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => proposalFixture({ status })) })} now={now} />);
    await screen.findByRole("heading", { name: heading });
    expect(screen.queryByRole("button", { name: /Confirmar/ })).toBeNull();
  });

  it("treats a pending proposal past its expiry as expired locally", async () => {
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => proposalFixture({ expiresAt: "2026-10-12T11:59:00.000Z" })) })} now={now} />);
    await screen.findByRole("heading", { name: "La propuesta venció" });
    expect(screen.queryByRole("button", { name: /Confirmar/ })).toBeNull();
  });

  it("requires a new proposal after a 409 and never resubmits", async () => {
    const confirm = vi.fn(async () => { throw new BffRequestError(409, null); });
    const proposal = vi.fn()
      .mockResolvedValueOnce(proposalFixture({ version: 1 }))
      .mockResolvedValueOnce(proposalFixture({ version: 2, status: "conflict", safeReasonCode: "provider_state_changed" }));
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal, confirm })} now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar cambio" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/nueva propuesta/));
    await screen.findByRole("heading", { name: "El evento cambió después de la propuesta" });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("explains when the session lacks permission to confirm", async () => {
    const confirm = vi.fn(async () => { throw new BffRequestError(403, null); });
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal: vi.fn(async () => proposalFixture()), confirm })} now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar cambio" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no tiene permiso para confirmar/));
    expect((screen.getByRole("button", { name: "Confirmar cambio" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses distinct copy for cancelling an own event and for answering an invitation", async () => {
    const cancel = proposalFixture({ summary: { ...updateProposal.summary, operation: "cancel", after: undefined } });
    const { unmount } = render(<CalendarProposal proposalId="c" client={fakeCalendarClient({ proposal: vi.fn(async () => cancel) })} now={now} />);
    await screen.findByRole("region", { name: "Revisar propuesta: Cancelar un evento que organizas" });
    expect(screen.getByRole("button", { name: "Confirmar cancelación del evento" })).toBeTruthy();
    expect(screen.queryByText(/invitación/i)).toBeNull();
    unmount();

    const respond = proposalFixture({ summary: { ...updateProposal.summary, operation: "respond_invitation", organizerRelationship: "other", invitationResponse: "tentative", after: undefined } });
    render(<CalendarProposal proposalId="r" client={fakeCalendarClient({ proposal: vi.fn(async () => respond) })} now={now} />);
    await screen.findByRole("region", { name: "Revisar propuesta: Responder una invitación" });
    expect(screen.getByText("Respuesta: Quizás")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar respuesta a la invitación" })).toBeTruthy();
    expect(screen.queryByText(/Cancelar un evento/)).toBeNull();
  });

  it("polls a proposal that is already executing when it is opened", async () => {
    vi.useFakeTimers();
    const proposal = vi.fn()
      .mockResolvedValueOnce(proposalFixture({ version: 2, status: "executing" }))
      .mockResolvedValueOnce(proposalFixture({ version: 3, status: "completed", completedAt: now }));
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal })} now={now} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Aplicando el cambio/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("heading", { name: "Cambio aplicado" })).toBeTruthy();
    expect(proposal).toHaveBeenCalledTimes(2);
  });

  it("polls when a failed action reloads the proposal as executing", async () => {
    vi.useFakeTimers();
    const confirm = vi.fn(async () => { throw new BffRequestError(503, null); });
    const proposal = vi.fn()
      .mockResolvedValueOnce(proposalFixture({ version: 1 }))
      .mockResolvedValueOnce(proposalFixture({ version: 2, status: "executing" }))
      .mockResolvedValueOnce(proposalFixture({ version: 3, status: "completed", completedAt: now }));
    render(<CalendarProposal proposalId="p" client={fakeCalendarClient({ proposal, confirm })} now={now} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cambio" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Aplicando el cambio/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("heading", { name: "Cambio aplicado" })).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("refuses to offer confirmation for answering an invitation you organize", async () => {
    const invalid = proposalFixture({ summary: { ...updateProposal.summary, operation: "respond_invitation", organizerRelationship: "self", invitationResponse: "declined", after: undefined } });
    render(<CalendarProposal proposalId="x" client={fakeCalendarClient({ proposal: vi.fn(async () => invalid) })} now={now} />);
    await screen.findByText(/responder a una invitación de un evento que organizas/);
    expect(screen.queryByRole("button", { name: /Confirmar/ })).toBeNull();
  });

  it("refuses to offer confirmation for cancelling an event organized by someone else", async () => {
    const invalid = proposalFixture({ summary: { ...updateProposal.summary, operation: "cancel", organizerRelationship: "other", after: undefined } });
    render(<CalendarProposal proposalId="x" client={fakeCalendarClient({ proposal: vi.fn(async () => invalid) })} now={now} />);
    await screen.findByText(/intenta cancelar un evento que organiza otra persona/);
    expect(screen.queryByRole("button", { name: /Confirmar/ })).toBeNull();
  });
});

const eventDetail = (overrides: Partial<CalendarEventDetail>): CalendarEventDetail => ({
  eventRef: "event-a", calendarRef: "cal-a", calendarDisplayName: "Trabajo", title: "Reunión de equipo",
  time: { kind: "timed", start: "2026-10-13T14:00:00.000Z", end: "2026-10-13T15:00:00.000Z", timeZone: "Etc/UTC" },
  status: "confirmed", organizerRelationship: "self", attendees: [], recurrence: { recurring: false, instance: false },
  updatedAt: now, ...overrides,
});

describe("CalendarEventActions", () => {
  it("offers invitation responses but never cancel for an event organized by someone else", () => {
    render(<CalendarEventActions event={eventDetail({ organizerRelationship: "other" })} client={fakeCalendarClient()} onProposed={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Cancelar/ })).toBeNull();
    expect(screen.queryByText(/Cancelar evento/)).toBeNull();
    for (const label of ["Aceptar", "Rechazar", "Quizás", "Quitar de mi calendario"]) {
      expect(screen.getByRole("radio", { name: label })).toBeTruthy();
    }
  });

  it("prepares an invitation response proposal with explicit choices and no execution", async () => {
    const propose = vi.fn(async () => proposalFixture({ id: "proposal-respond" }));
    const onProposed = vi.fn();
    render(<CalendarEventActions event={eventDetail({ organizerRelationship: "other" })} client={fakeCalendarClient({ propose })} onProposed={onProposed} />);
    const submit = screen.getByRole("button", { name: "Preparar respuesta" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Rechazar" }));
    fireEvent.click(screen.getByRole("radio", { name: "No notificar a los invitados" }));
    fireEvent.click(submit);
    await waitFor(() => expect(onProposed).toHaveBeenCalledWith("proposal-respond"));
    expect(propose).toHaveBeenCalledWith(
      { operation: "respond_invitation", eventRef: "event-a", recurrenceScope: "single", response: "declined", guestNotification: "none" },
      expect.stringMatching(/^[\x21-\x7e]{8,255}$/u),
    );
  });

  it("reuses the idempotency key when retrying the same intent and renews it for a different choice", async () => {
    const propose = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(proposalFixture({ id: "proposal-respond" }));
    render(<CalendarEventActions event={eventDetail({ organizerRelationship: "other" })} client={fakeCalendarClient({ propose })} onProposed={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Aceptar" }));
    fireEvent.click(screen.getByRole("radio", { name: "No notificar a los invitados" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar respuesta" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no se creará una propuesta duplicada/));
    fireEvent.click(screen.getByRole("button", { name: "Preparar respuesta" }));
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("radio", { name: "Quizás" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar respuesta" }));
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(3));
    const keys = propose.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("keeps the failure region mounted so a failed preparation is announced", async () => {
    render(<CalendarEventActions event={eventDetail({ organizerRelationship: "other" })} client={fakeCalendarClient({ propose: vi.fn(async () => { throw new Error("network"); }) })} onProposed={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("");
    fireEvent.click(screen.getByRole("radio", { name: "Aceptar" }));
    fireEvent.click(screen.getByRole("radio", { name: "No notificar a los invitados" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar respuesta" }));
    await waitFor(() => expect(alert.textContent).toMatch(/No se pudo preparar/));
  });

  it("uses a fresh idempotency key for a new intent after a successful proposal", async () => {
    const propose = vi.fn(async () => proposalFixture({ id: "proposal-respond" }));
    const onProposed = vi.fn();
    render(<CalendarEventActions event={eventDetail({ organizerRelationship: "other" })} client={fakeCalendarClient({ propose })} onProposed={onProposed} />);
    fireEvent.click(screen.getByRole("radio", { name: "Aceptar" }));
    fireEvent.click(screen.getByRole("radio", { name: "No notificar a los invitados" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar respuesta" }));
    await waitFor(() => expect(onProposed).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Preparar respuesta" }));
    await waitFor(() => expect(onProposed).toHaveBeenCalledTimes(2));
    const keys = propose.mock.calls.map((call) => (call as unknown[])[1]);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("asks for a fresh scope and choices when the event changes to a recurring one", async () => {
    const propose = vi.fn(async (_body: unknown, _key: string) => proposalFixture({ id: "proposal-cancel" }));
    const { rerender } = render(<CalendarEventActions event={eventDetail({})} client={fakeCalendarClient({ propose })} onProposed={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Notificar a todos los invitados" }));
    expect((screen.getByRole("button", { name: "Preparar cancelación" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<CalendarEventActions event={eventDetail({ eventRef: "event-b", recurrence: { recurring: true, instance: true } })} client={fakeCalendarClient({ propose })} onProposed={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "Preparar cancelación" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Notificar a todos los invitados" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Notificar a todos los invitados" }));
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Toda la serie" }));
    fireEvent.click(submit);
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
    expect(propose.mock.calls[0]![0]).toEqual({ operation: "cancel", eventRef: "event-b", recurrenceScope: "series", guestNotification: "all" });
  });

  it("offers cancellation only for an own event, with its own copy and explicit scope", async () => {
    const propose = vi.fn(async (_body: unknown, _key: string) => proposalFixture({ id: "proposal-cancel" }));
    render(<CalendarEventActions event={eventDetail({ recurrence: { recurring: true, instance: true } })} client={fakeCalendarClient({ propose })} onProposed={vi.fn()} />);
    expect(screen.queryByRole("radio", { name: "Aceptar" })).toBeNull();
    expect(screen.getByText(/Cancelar un evento que organizas/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Preparar cancelación" }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("radio", { name: "Notificar a todos los invitados" }));
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Solo este evento" }));
    fireEvent.click(submit);
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
    expect(propose.mock.calls[0]![0]).toEqual({ operation: "cancel", eventRef: "event-a", recurrenceScope: "single", guestNotification: "all" });
  });
});
