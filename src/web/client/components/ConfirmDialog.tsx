import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";

interface PendingConfirm {
  message: string;
  resolve: (ok: boolean) => void;
}

const ConfirmContext = React.createContext<((message: string) => Promise<boolean>) | null>(null);

/** Promise-based replacement for window.confirm(), backed by a single
 * shared AlertDialog instance — matches the old UI's data-confirm attribute
 * behavior (app.js:748-751) without a native browser dialog. */
export function useConfirm(): (message: string) => Promise<boolean> {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm() must be used within ConfirmProvider");
  return confirm;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);

  const confirm = React.useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      setPending({ message, resolve });
    });
  }, []);

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="confirm-backdrop" />
          <AlertDialog.Popup className="confirm-popup">
            <AlertDialog.Description>{pending?.message}</AlertDialog.Description>
            <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
              <button type="button" className="btn btn-ghost" onClick={() => settle(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => settle(true)}>
                OK
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}
