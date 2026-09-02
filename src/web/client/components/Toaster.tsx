import * as React from "react";
import { Toast } from "@base-ui/react/toast";

/** App-wide toast provider + the region that renders them, styled with the
 * existing .toast/#toast-region classes from theme.css rather than Base
 * UI's own (Tailwind-based) example styling. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport id="toast-region">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root key={t.id} toast={t} className={`toast${t.type === "error" ? " error" : ""}`}>
      <Toast.Description />
    </Toast.Root>
  ));
}

/** Fire-and-forget toast, matching the old app.js toast(message, isError)
 * helper — call from anywhere via the useToast() hook below. */
export function useToast() {
  const manager = Toast.useToastManager();
  return React.useCallback(
    (message: string, isError = false) => {
      manager.add({ description: message, type: isError ? "error" : undefined, timeout: 5000 });
    },
    [manager],
  );
}
