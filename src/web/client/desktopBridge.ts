/**
 * Bridge to the desktop shell's native folder picker (desktop/audible-backup).
 *
 * The shell registers a WebKit script message handler named "chooseFolder"
 * on its WebView before loading the page. Posting a message to it opens a
 * GTK4 file dialog (portal-backed under Flatpak, so it can grant access to
 * whatever folder is chosen without the sandbox needing broader filesystem
 * permissions); the shell replies by calling `window.__chooseFolderResult`
 * with the chosen absolute path, or `null` if the dialog was cancelled.
 *
 * Outside that WebView (a regular browser, or the desktop server opened in
 * one during development) `window.webkit` doesn't exist, so callers should
 * check `hasNativeFolderPicker()` before offering a "Browse" button at all.
 */

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        chooseFolder?: { postMessage: (initialPath: string) => void };
      };
    };
    __chooseFolderResult?: (path: string | null) => void;
  }
}

export function hasNativeFolderPicker(): boolean {
  return typeof window !== "undefined" && !!window.webkit?.messageHandlers?.chooseFolder;
}

/** Resolves with the chosen absolute path, or null if cancelled/unavailable. */
export function chooseFolderNative(initialPath: string): Promise<string | null> {
  const handler = window.webkit?.messageHandlers?.chooseFolder;
  if (!handler) return Promise.resolve(null);

  return new Promise((resolve) => {
    window.__chooseFolderResult = (path) => {
      delete window.__chooseFolderResult;
      resolve(path);
    };
    handler.postMessage(initialPath);
  });
}
