import { dialog, shell } from "electron";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

export interface ExternalLinkDependencies {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  openExternal(url: string): Promise<void>;
}

export async function confirmExternalLink(
  target: string,
  dependencies: ExternalLinkDependencies = {
    showMessageBox: (options) => dialog.showMessageBox(options),
    openExternal: (url) => shell.openExternal(url),
  },
): Promise<boolean> {
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const result = await dependencies.showMessageBox({
      type: "question",
      buttons: ["Cancel", "Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `Open ${url.hostname} in your browser?`,
      detail: url.href,
    });
    if (result.response !== 1) return false;
    await dependencies.openExternal(url.href);
    return true;
  } catch {
    return false;
  }
}
