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
    .auth-card select { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 0.5rem 0.75rem; font-size: 0.9rem; }
    .auth-card .steps { margin: 0 0 0.75rem 1.1rem; display: flex; flex-direction: column; gap: 0.3rem; }
    .auth-card .steps li { list-style: decimal; }
    .auth-card a { color: var(--accent); }
    .auth-card code { background: var(--bg); padding: 0.1rem 0.3rem; border-radius: 4px; }
    .auth-card p { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem; }
    .danger-zone { border-color: rgba(248, 113, 113, 0.4); }
    .danger-zone h2 { color: var(--danger); }
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

export interface AudibleStatus {
  /** Whether the Python helper can run at all (sign-in needs it). */
  available: boolean;
  linked: boolean;
  marketplace?: string;
  /** Set while a sign-in is in progress and awaiting the pasted URL. */
  pending?: { url: string; marketplace: string };
}

export interface SettingsView {
  userName: string;
  activationBytes: string;
  hasPassword: boolean;
  audible: AudibleStatus;
  message?: string;
  error?: string;
  userNav?: UserNav;
}

const MARKETPLACES: [string, string][] = [
  ["de", "Germany (audible.de)"],
  ["us", "United States (audible.com)"],
  ["uk", "United Kingdom (audible.co.uk)"],
  ["fr", "France (audible.fr)"],
  ["ca", "Canada (audible.ca)"],
  ["it", "Italy (audible.it)"],
  ["au", "Australia (audible.com.au)"],
  ["in", "India (audible.in)"],
  ["jp", "Japan (audible.co.jp)"],
  ["es", "Spain (audible.es)"],
  ["br", "Brazil (audible.com.br)"],
];

function audibleCard(audible: AudibleStatus): string {
  if (!audible.available) {
    return `<div class="auth-card">
      <h2>Audible account</h2>
      <p class="hint">Sign-in from the browser needs the Python <code>audible</code>
      package, which is not available here. Use the command line instead:
      <code>audible quickstart</code>.</p>
    </div>`;
  }

  if (audible.pending) {
    return `<div class="auth-card">
      <h2>Connect Audible — step 2 of 2</h2>
      <ol class="hint steps">
        <li><a href="${escapeHtml(audible.pending.url)}" target="_blank" rel="noopener noreferrer">Open the Audible sign-in page</a> and log in there.</li>
        <li>After signing in your browser lands on a page that fails to load. That is expected.</li>
        <li>Copy that page's full address and paste it below.</li>
      </ol>
      <form method="post" action="/user/audible/complete">
        <label for="redirect-url">Address of the page you landed on</label>
        <input id="redirect-url" name="redirect_url" placeholder="https://www.audible.de/?openid.oa2.authorization_code=..." required autocomplete="off">
        <button class="btn btn-primary" type="submit">Finish sign-in</button>
      </form>
      <form method="post" action="/user/audible/cancel">
        <button class="btn btn-ghost" type="submit">Cancel</button>
      </form>
    </div>`;
  }

  if (audible.linked) {
    return `<div class="auth-card">
      <h2>Audible account</h2>
      <p><span class="badge badge-success">Connected</span>
        ${audible.marketplace ? `<span class="hint"> marketplace: ${escapeHtml(audible.marketplace)}</span>` : ""}
      </p>
      <form method="post" action="/user/audible/start">
        <input type="hidden" name="marketplace" value="${escapeHtml(audible.marketplace || "de")}">
        <button class="btn btn-ghost" type="submit">Reconnect</button>
      </form>
    </div>`;
  }

  return `<div class="auth-card">
    <h2>Connect Audible</h2>
    <p class="hint">You sign in on Audible's own page — this app never sees your password.</p>
    <form method="post" action="/user/audible/start">
      <label for="marketplace">Marketplace</label>
      <select id="marketplace" name="marketplace">
        ${MARKETPLACES.map(([code, label]) =>
          `<option value="${code}"${code === "de" ? " selected" : ""}>${escapeHtml(label)}</option>`,
        ).join("")}
      </select>
      <button class="btn btn-primary" type="submit">Start sign-in</button>
    </form>
  </div>`;
}

export function settingsPage(view: SettingsView): string {
  const { userName, activationBytes, hasPassword, message, error, userNav } = view;
  const content = `
    ${formStyles}
    <div class="auth-wrap">
      <h1>Settings — ${escapeHtml(userName)}</h1>
      ${message ? `<div class="auth-error" style="color:var(--success)">${escapeHtml(message)}</div>` : ""}
      ${error ? `<div class="auth-error">${escapeHtml(error)}</div>` : ""}
      ${audibleCard(view.audible)}
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
      <div class="auth-card danger-zone">
        <h2>Reset library database</h2>
        <p class="hint">Clears this user's library list — every book, its
        download and conversion state. <strong>Files on disk are kept</strong>;
        a later sync re-imports whatever is still there.</p>
        <form method="post" action="/user/reset-db"
              data-confirm="Reset the library database for this user? Downloaded files are kept, but the library list is cleared.">
          <button class="btn btn-danger" type="submit">Reset database</button>
        </form>
      </div>

      <a href="/" class="btn btn-ghost">&larr; Back to library</a>
    </div>
  `;
  return layout("Settings", content, userNav);
}
