import * as React from "react";
import { useRouter } from "../Router.tsx";
import { useSession } from "../SessionContext.tsx";
import { api, ApiRequestError } from "../api.ts";

function UserRow({ name, hasPassword, onLogin }: { name: string; hasPassword: boolean; onLogin: (name: string, password?: string) => void }) {
  const [password, setPassword] = React.useState("");

  if (!hasPassword) {
    return (
      <div className="user-row">
        <button className="btn btn-primary" style={{ flex: 1 }} type="button" onClick={() => onLogin(name)}>
          Continue as {name}
        </button>
      </div>
    );
  }

  return (
    <div className="user-row">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onLogin(name, password);
        }}
      >
        <input
          type="password"
          placeholder={`Password for ${name}`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="btn btn-primary" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}

export function LoginPage() {
  const { session, setSession, refresh } = useSession();
  const { navigate } = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [activationBytes, setActivationBytes] = React.useState("");

  // Already signed in (e.g. reached /login directly) — nothing to do here.
  React.useEffect(() => {
    if (session?.current) navigate("/");
  }, [session, navigate]);

  const doLogin = async (userName: string, userPassword?: string) => {
    setError(null);
    try {
      const s = await api.session.login(userName, userPassword);
      setSession(s);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not sign in");
    }
  };

  const doAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const s = await api.users.add(name.trim(), password || undefined, activationBytes || undefined);
      setSession(s);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not create user");
      refresh().catch(() => {});
    }
  };

  if (!session) return null;

  return (
    <main>
      <div className="auth-wrap">
        <h1>Audible Backup</h1>
        {error && <div className="auth-error">{error}</div>}

        {session.others.length > 0 && (
          <div className="auth-card">
            <h2>Choose user</h2>
            {session.others.map((u) => (
              <UserRow key={u.name} name={u.name} hasPassword={u.hasPassword} onLogin={doLogin} />
            ))}
          </div>
        )}

        <div className="auth-card">
          <h2>{session.others.length > 0 ? "Add user" : "Create your first user"}</h2>
          <form onSubmit={doAdd}>
            <label htmlFor="add-name">Username</label>
            <input
              id="add-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-zA-Z0-9_\-]{1,32}"
              placeholder="e.g. alice"
              required
            />
            <label htmlFor="add-password">
              Password <span className="hint">(optional)</span>
            </label>
            <input
              id="add-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <label htmlFor="add-bytes">
              Audible activation bytes <span className="hint">(optional, can be set later in Settings)</span>
            </label>
            <input
              id="add-bytes"
              value={activationBytes}
              onChange={(e) => setActivationBytes(e.target.value)}
              placeholder="e.g. 1a2b3c4d"
            />
            <button className="btn btn-primary" type="submit">
              Create user
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
