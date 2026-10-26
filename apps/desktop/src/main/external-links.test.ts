import type { MessageBoxOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() }, shell: { openExternal: vi.fn() } }));
import { confirmExternalLink } from "./external-links.js";

function dependencies(response = 0) {
  return {
    showMessageBox: vi.fn(async (_options: MessageBoxOptions) => ({ response, checkboxChecked: false })),
    openExternal: vi.fn(async (_url: string) => undefined),
  };
}
describe("confirmExternalLink", () => {
  it.each(["http://external.example.test/", "javascript:alert(1)", "file:///tmp/fixture", "mailto:user@example.test", "https://user:fixture@external.example.test/", "not a URL"])("rejects %s before showing any dialog", async (url) => {
    const deps = dependencies(1);
    expect(await confirmExternalLink(url, deps)).toBe(false);
    expect(deps.showMessageBox).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
  it("names the parsed destination host with Cancel as the default", async () => {
    const deps = dependencies();
    expect(await confirmExternalLink("https://external.example.test/docs", deps)).toBe(false);
    expect(deps.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "question", buttons: ["Cancel", "Open"], defaultId: 0, cancelId: 0,
      message: expect.stringContaining("external.example.test"),
    }));
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
  it("opens only the validated URL after explicit Open", async () => {
    const deps = dependencies(1);
    expect(await confirmExternalLink("https://EXTERNAL.example.test:443/docs", deps)).toBe(true);
    expect(deps.openExternal).toHaveBeenCalledExactlyOnceWith("https://external.example.test/docs");
    expect(deps.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(deps.openExternal.mock.invocationCallOrder[0]!);
  });
  it("does not open while confirmation is pending", async () => {
    let respond: ((result: { response: number; checkboxChecked: boolean }) => void) | undefined;
    const deps = dependencies();
    deps.showMessageBox.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const pending = confirmExternalLink("https://external.example.test/docs", deps);
    expect(deps.openExternal).not.toHaveBeenCalled();
    respond?.({ response: 1, checkboxChecked: false });
    expect(await pending).toBe(true);
  });
  it.each([0, -1, 2])("does not open for response %s", async (response) => {
    const deps = dependencies(response);
    expect(await confirmExternalLink("https://external.example.test/", deps)).toBe(false);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
  it("contains dialog failure without opening", async () => {
    const deps = dependencies(1);
    deps.showMessageBox.mockRejectedValue(new Error("fixture"));
    expect(await confirmExternalLink("https://external.example.test/", deps)).toBe(false);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
  it("contains system browser failure", async () => {
    const deps = dependencies(1);
    deps.openExternal.mockRejectedValue(new Error("fixture"));
    expect(await confirmExternalLink("https://external.example.test/", deps)).toBe(false);
  });
  it("hands an OAuth authorization URL to the system browser unchanged only after Open", async () => {
    const oauth = "https://accounts.example.test/o/oauth2/auth?client_id=fixture&state=opaque&redirect_uri=https%3A%2F%2Fhub.example.test%2Fcallback";
    const denied = dependencies(0);
    expect(await confirmExternalLink(oauth, denied)).toBe(false);
    expect(denied.openExternal).not.toHaveBeenCalled();
    const approved = dependencies(1);
    expect(await confirmExternalLink(oauth, approved)).toBe(true);
    expect(approved.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: oauth }));
    expect(approved.openExternal).toHaveBeenCalledExactlyOnceWith(oauth);
  });
  it("rejects a non-HTTPS OAuth authorization URL before any dialog", async () => {
    const deps = dependencies(1);
    expect(await confirmExternalLink("http://accounts.example.test/o/oauth2/auth?state=opaque", deps)).toBe(false);
    expect(deps.showMessageBox).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});
