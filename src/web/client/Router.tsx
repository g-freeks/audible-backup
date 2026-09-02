import * as React from "react";

interface RouterContextValue {
  path: string;
  navigate: (to: string) => void;
}

const RouterCtx = React.createContext<RouterContextValue | null>(null);

/**
 * Minimal client-side router — three routes (/, /login, /user/settings)
 * don't warrant a dependency. Tracks location.pathname, intercepts clicks on
 * same-origin <a> tags so normal <a href> markup works, and exposes
 * navigate() for programmatic redirects (e.g. after login).
 */
export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = React.useState(() => location.pathname);

  const navigate = React.useCallback((to: string) => {
    if (to !== location.pathname) history.pushState(null, "", to);
    setPath(to);
  }, []);

  React.useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
      // Non-app paths (downloads, /static/*) still need a real navigation.
      if (a.pathname.startsWith("/download/") || a.pathname.startsWith("/static/")) return;
      e.preventDefault();
      navigate(a.pathname + a.search);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);

  return <RouterCtx.Provider value={{ path, navigate }}>{children}</RouterCtx.Provider>;
}

export function useRouter(): RouterContextValue {
  const ctx = React.useContext(RouterCtx);
  if (!ctx) throw new Error("useRouter() must be used within RouterProvider");
  return ctx;
}
