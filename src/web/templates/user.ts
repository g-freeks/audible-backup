import { layout, type UserNav } from "./layout.ts";
import { escapeHtml } from "./html.ts";

export interface UserListEntry {
  name: string;
  hasPassword: boolean;
}

const formStyles = `
  <style>
    .auth-wrap { max-width: 420px; margin: 3rem auto; }
    .auth-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .auth-card h2 { margin-bottom: 1rem; }
    .auth-card form { display: flex; flex-direction: column; gap: 0.6rem; }
    .auth-card .user-row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
    .auth-card .user-row form { flex-direction: row; flex: 1; }
    .auth-card .user-row input[type=password] { flex: 1; }
    .auth-card input { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 0.5rem 0.75rem; font-size: 0.9rem; outline: none; }
    .auth-card input:focus { border-color: var(--accent); }
    .auth-card label { font-size: 0.8rem; color: var(--text-muted); }
    .auth-card .hint { font-size: 0.75rem; color: var(--text-muted); }
    .auth-error { color: var(--danger); margin-bottom: 1rem; font-size: 0.9rem; }
    .auth-card .checkbox-row { display: flex; align-items: center; gap: 0.5rem; }
    .auth-card .checkbox-row input { width: auto; }
    .auth-card .checkbox-row label { font-size: 0.85rem; color: var(--text); }
  </style>
`;

export function loginPage(users: UserListEntry[], error?: string, preselect?: string): string {
  const userRows = users
    .map((u) => {
      const name = escapeHtml(u.name);
      if (!u.hasPassword) {
        return `<div class="user-row">
          <form method="post" action="/user/switch">
            <input type="hidden" name="name" value="${name}">
            <button class="btn btn-primary" style="flex:1" type="submit">Continue as ${name}</button>
          </form>
        </div>`;
      }
      return `<div class="user-row">
        <form method="post" action="/user/switch">
          <input type="hidden" name="name" value="${name}">
          <input type="password" name="password" placeholder="Password for ${name}" ${preselect === u.name ? "autofocus" : ""} required>
          <button class="btn btn-primary" type="submit">Sign in</button>
        </form>
      </div>`;
    })
    .join("");

  const content = `
    ${formStyles}
    <div class="auth-wrap">
      <h1>Audible Backup</h1>
      ${error ? `<div class="auth-error">${escapeHtml(error)}</div>` : ""}
      ${users.length > 0 ? `
      <div class="auth-card">
        <h2>Choose user</h2>
        ${userRows}
      </div>` : ""}
      <div class="auth-card">
        <h2>${users.length > 0 ? "Add user" : "Create your first user"}</h2>
        <form method="post" action="/user/add">
          <label for="add-name">Username</label>
          <input id="add-name" name="name" pattern="[a-zA-Z0-9_\\-]{1,32}" placeholder="e.g. alice" required>
          <label for="add-password">Password <span class="hint">(optional)</span></label>
          <input id="add-password" name="password" type="password" autocomplete="new-password">
          <label for="add-bytes">Audible activation bytes <span class="hint">(optional, can be set later in Settings)</span></label>
          <input id="add-bytes" name="activation_bytes" placeholder="e.g. 1a2b3c4d">
          <button class="btn btn-primary" type="submit">Create user</button>
        </form>
      </div>
    </div>
  `;
  return layout("Sign in", content);
}

export function settingsPage(
  userName: string,
  activationBytes: string,
  hasPassword: boolean,
  message?: string,
  userNav?: UserNav,
): string {
  const content = `
    ${formStyles}
    <div class="auth-wrap">
      <h1>Settings — ${escapeHtml(userName)}</h1>
      ${message ? `<div class="auth-error" style="color:var(--success)">${escapeHtml(message)}</div>` : ""}
      <div class="auth-card">
        <form method="post" action="/user/settings">
          <label for="set-bytes">Audible activation bytes</label>
          <input id="set-bytes" name="activation_bytes" value="${escapeHtml(activationBytes)}" placeholder="e.g. 1a2b3c4d">
          <label for="set-password">New password <span class="hint">(leave blank to keep ${hasPassword ? "current password" : "no password"})</span></label>
          <input id="set-password" name="password" type="password" autocomplete="new-password">
          ${hasPassword ? `
          <div class="checkbox-row">
            <input id="set-remove-pw" name="remove_password" type="checkbox" value="true">
            <label for="set-remove-pw">Remove password</label>
          </div>` : ""}
          <button class="btn btn-primary" type="submit">Save</button>
        </form>
      </div>
      <a href="/" class="btn btn-ghost">&larr; Back to library</a>
    </div>
  `;
  return layout("Settings", content, userNav);
}
