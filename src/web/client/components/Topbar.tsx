import * as React from "react";
import { Menu } from "@base-ui/react/menu";
import { useRouter } from "../Router.tsx";
import { useSession } from "../SessionContext.tsx";
import { useToast } from "./Toaster.tsx";
import { api, ApiRequestError } from "../api.ts";
import { LogPanel, LogToggle } from "./LogPanel.tsx";

export function Topbar({ center }: { center?: React.ReactNode }) {
  const { session, setSession } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const [logOpen, setLogOpen] = React.useState(false);

  if (!session) return null;

  const switchTo = async (name: string) => {
    try {
      const s = await api.session.login(name);
      setSession(s);
      navigate("/");
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : "Could not switch user", true);
    }
  };

  const signOut = async () => {
    await api.session.logout();
    navigate("/login");
    setSession({ desktop: false, current: null, others: [] });
  };

  return (
    <>
      <header className="topbar">
        <span className="topbar-title">Audible Backup</span>
        {center && <div className="topbar-center">{center}</div>}
        <div className="topbar-actions">
          <LogToggle open={logOpen} onToggle={() => setLogOpen((v) => !v)} />

          {session.desktop ? (
            <>
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                title="Show the finished audiobooks in your file manager"
                onClick={() => api.openOutput().catch((err) => toast(String(err.message || err), true))}
              >
                Open folder
              </button>
              <a className="btn btn-sm btn-ghost" href="/user/settings">
                Settings
              </a>
            </>
          ) : !session.current ? (
            <a className="btn btn-sm btn-ghost" href="/login">
              Sign in / Add user
            </a>
          ) : (
            <Menu.Root>
              <Menu.Trigger className="btn btn-sm btn-ghost">{session.current} &#9662;</Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="end" sideOffset={2}>
                  <Menu.Popup className="dropdown-menu">
                    {session.others.map((u) => (
                      <Menu.Item key={u.name} className="dropdown-item" onClick={() => switchTo(u.name)}>
                        Switch to {u.name}
                      </Menu.Item>
                    ))}
                    <Menu.Item className="dropdown-item" onClick={() => navigate("/user/settings")}>
                      Settings
                    </Menu.Item>
                    <Menu.Item className="dropdown-item" onClick={() => navigate("/login")}>
                      Add user&hellip;
                    </Menu.Item>
                    <Menu.Item className="dropdown-item" onClick={signOut}>
                      Sign out
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          )}
        </div>
      </header>
      <LogPanel open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}
