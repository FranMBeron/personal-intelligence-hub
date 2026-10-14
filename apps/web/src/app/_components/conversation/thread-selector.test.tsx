// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { ThreadSelector } from "./thread-selector";

afterEach(cleanup);

describe("ThreadSelector", () => {
  it("supports keyboard selection, creation, rename, archive and restore", async () => {
    const main = conversationFixture({ id: "main-thread", isMain: true, title: "Principal" });
    const thread = conversationFixture({ id: "thread-2", isMain: false, title: "Ideas" });
    const archived = conversationFixture({ id: "thread-3", isMain: false, archived: true, title: "Archivada" });
    const handlers = {
      onSelect: vi.fn(async () => undefined),
      onCreate: vi.fn(async () => undefined),
      onRename: vi.fn(async () => undefined),
      onArchive: vi.fn(async () => undefined),
      onRestore: vi.fn(async () => undefined),
    };
    render(<ThreadSelector items={[main, thread, archived]} selectedId="main-thread" loading={false} {...handlers} />);

    const threadButton = screen.getByRole("button", { name: "Seleccionar Ideas" });
    threadButton.focus();
    fireEvent.keyDown(threadButton, { key: "Enter" });
    fireEvent.click(threadButton);
    await waitFor(() => expect(handlers.onSelect).toHaveBeenCalledWith("thread-2"));

    fireEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
    await waitFor(() => expect(handlers.onCreate).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Renombrar Ideas" }));
    const titleInput = screen.getByRole("textbox", { name: "Nuevo título para Ideas" });
    fireEvent.change(titleInput, { target: { value: "Plan" } });
    fireEvent.submit(titleInput.closest("form")!);
    await waitFor(() => expect(handlers.onRename).toHaveBeenCalledWith("thread-2", "Plan"));

    const archiveButton = screen.getByRole("button", { name: "Archivar Ideas" });
    expect(archiveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(archiveButton);
    await waitFor(() => expect(handlers.onArchive).toHaveBeenCalledWith("thread-2"));
    fireEvent.click(screen.getByRole("button", { name: "Restaurar Archivada" }));
    await waitFor(() => expect(handlers.onRestore).toHaveBeenCalledWith("thread-3"));
    expect(screen.getByRole("button", { name: "Archivar Principal" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("surfaces async callback errors and disables archive for the main thread with an explanation", async () => {
    const main = conversationFixture({ id: "main-thread", isMain: true, title: "Principal" });
    const onArchive = vi.fn(async () => undefined);
    render(<ThreadSelector items={[main]} selectedId={null} loading={false}
      onSelect={async () => { throw new Error("conflict"); }} onCreate={async () => undefined}
      onRename={async () => undefined} onArchive={onArchive} onRestore={async () => undefined} />);

    const archive = screen.getByRole("button", { name: "Archivar Principal" });
    // Focusable (no native disabled) so keyboard and screen-reader users reach the explanation.
    expect(archive.hasAttribute("disabled")).toBe(false);
    expect(archive.getAttribute("aria-disabled")).toBe("true");
    archive.focus();
    expect(document.activeElement).toBe(archive);
    const help = document.getElementById(archive.getAttribute("aria-describedby") ?? "");
    expect(help?.textContent).toBe("La conversación principal no se puede archivar.");
    expect(help?.classList.contains("sr-only")).toBe(false);
    fireEvent.click(archive);
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar Principal" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("keeps keyboard focus in the conversation list after loading another page", async () => {
    const main = conversationFixture({ id: "main-thread", isMain: true, title: "Principal" });
    const onLoadMore = vi.fn(async () => undefined);
    render(<ThreadSelector items={[main]} selectedId="main-thread" loading={false} onSelect={async () => undefined}
      onCreate={async () => undefined} onRename={async () => undefined} onArchive={async () => undefined}
      onRestore={async () => undefined} onLoadMore={onLoadMore} hasMore />);
    fireEvent.click(screen.getByRole("button", { name: "Cargar más conversaciones" }));
    await waitFor(() => expect(onLoadMore).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Seleccionar Principal" })));
  });

  it("keeps the edited title visible when a versioned rename fails", async () => {
    const thread = conversationFixture({ id: "thread-2", isMain: false, title: "Ideas" });
    render(<ThreadSelector items={[thread]} selectedId={null} loading={false} onSelect={async () => undefined}
      onCreate={async () => undefined} onRename={async () => { throw new Error("conflict"); }}
      onArchive={async () => undefined} onRestore={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Renombrar Ideas" }));
    const input = screen.getByRole("textbox", { name: "Nuevo título para Ideas" });
    fireEvent.change(input, { target: { value: "Propuesta" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Nuevo título para Ideas" }) as HTMLInputElement).value).toBe("Propuesta");
  });

});
