import * as React from "react";
import { api } from "./api.ts";
import type { SessionState } from "./types.ts";

interface SessionContextValue {
  session: SessionState | null;
  loading: boolean;
  refresh: () => Promise<SessionState>;
  setSession: (s: SessionState) => void;
}

const SessionCtx = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<SessionState | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    const s = await api.session.get();
    setSession(s);
    return s;
  }, []);

  React.useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  return (
    <SessionCtx.Provider value={{ session, loading, refresh, setSession }}>{children}</SessionCtx.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionCtx);
  if (!ctx) throw new Error("useSession() must be used within SessionProvider");
  return ctx;
}
