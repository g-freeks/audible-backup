import * as React from "react";
import { useOperation } from "./useOperation.ts";

type OperationContextValue = ReturnType<typeof useOperation>;

const OperationCtx = React.createContext<OperationContextValue | null>(null);

/** One useOperation() instance shared by the whole app (there is only ever
 * one global operation on the server — see operations.ts) — the topbar's
 * log indicator, the floating log panel, and every row's status cell all
 * read from this one SSE connection instead of opening their own. */
export function OperationProvider({ children }: { children: React.ReactNode }) {
  const operation = useOperation();
  return <OperationCtx.Provider value={operation}>{children}</OperationCtx.Provider>;
}

export function useOperationContext(): OperationContextValue {
  const ctx = React.useContext(OperationCtx);
  if (!ctx) throw new Error("useOperationContext() must be used within OperationProvider");
  return ctx;
}
