import * as React from "react";
import { RouterProvider, useRouter } from "./Router.tsx";
import { SessionProvider, useSession } from "./SessionContext.tsx";
import { OperationProvider } from "./OperationContext.tsx";
import { ToastProvider } from "./components/Toaster.tsx";
import { ConfirmProvider } from "./components/ConfirmDialog.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { LibraryPage } from "./pages/Library.tsx";

function Routes() {
  const { path, navigate } = useRouter();
  const { session, loading } = useSession();

  const authorized = !!session && (session.desktop || !!session.legacy || !!session.current);

  React.useEffect(() => {
    if (loading || !session) return;
    if (path !== "/login" && !authorized) navigate("/login");
  }, [loading, session, authorized, path, navigate]);

  if (loading || !session) return null;
  if (path === "/login") return <LoginPage />;
  if (!authorized) return null; // navigating to /login this tick
  if (path === "/user/settings") return <SettingsPage />;
  return <LibraryPage />;
}

export function App() {
  return (
    <RouterProvider>
      <SessionProvider>
        <ToastProvider>
          <ConfirmProvider>
            <OperationProvider>
              <Routes />
            </OperationProvider>
          </ConfirmProvider>
        </ToastProvider>
      </SessionProvider>
    </RouterProvider>
  );
}
