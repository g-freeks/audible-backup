import { escapeHtml } from "./html.ts";

export interface UserNav {
  /** Signed-in user; absent in legacy single-user mode (no users registered). */
  current?: string;
  others: { name: string; hasPassword: boolean }[];
  /** Desktop install: one implicit user, so no account controls at all. */
  desktop?: boolean;
}

/** Opens the operation log, which stays closed until asked for. Rendered as
 * already running when the server knows an operation is in flight for this
 * user — otherwise the indicator would stay dark for an operation that was
 * triggered without a click on this page (e.g. an auto-sync after connecting
 * an Audible account), since nothing on the client would ever have mutated
 * `#progress-panel` to notice it. */
function logToggle(running: boolean): string {
  return `<button id="log-toggle" class="btn btn-sm btn-ghost" type="button"
      aria-expanded="false" aria-controls="log-float" title="Show the operation log">
      Log <span id="log-indicator" class="log-dot${running ? " running" : ""}"${running ? "" : " hidden"}></span>
    </button>`;
}

function topbar(userNav: UserNav, extra: string, running: boolean): string {
  const center = extra ? `<div class="topbar-center">${extra}</div>` : "";

  // Desktop install: no accounts to switch between, but Settings still holds
  // the Audible connection and activation bytes.
  if (userNav.desktop) {
    return `<header class="topbar">
    <span class="topbar-title">Audible Backup</span>
    ${center}
    <div class="topbar-actions">
      ${logToggle(running)}
      <button class="btn btn-sm btn-ghost" type="button"
        hx-post="/open-output" hx-swap="none"
        title="Show the finished audiobooks in your file manager">Open folder</button>
      <a class="btn btn-sm btn-ghost" href="/user/settings">Settings</a>
    </div>
  </header>`;
  }

  // Legacy single-user mode: no session to show, but users must still be able
  // to find the sign-in / add-user flow.
  if (!userNav.current) {
    return `<header class="topbar">
    <span class="topbar-title">Audible Backup</span>
    ${center}
    <div class="topbar-actions">
      ${logToggle(running)}
      <a class="btn btn-sm btn-ghost" href="/login">Sign in / Add user</a>
    </div>
  </header>`;
  }

  const items = [
    ...userNav.others.map((u) => {
      const name = escapeHtml(u.name);
      if (u.hasPassword) {
        return `<a class="dropdown-item" href="/login?user=${encodeURIComponent(u.name)}">Switch to ${name}</a>`;
      }
      return `<form method="post" action="/user/switch"><input type="hidden" name="name" value="${name}"><button class="dropdown-item" type="submit">Switch to ${name}</button></form>`;
    }),
    `<a class="dropdown-item" href="/user/settings">Settings</a>`,
    `<a class="dropdown-item" href="/login">Add user&hellip;</a>`,
    `<form method="post" action="/user/logout"><button class="dropdown-item" type="submit">Sign out</button></form>`,
  ].join("");

  return `<header class="topbar">
    <span class="topbar-title">Audible Backup</span>
    ${center}
    <div class="topbar-actions">
      ${logToggle(running)}
      <div class="action-dropdown">
        <button class="btn btn-sm btn-ghost" type="button" data-dropdown-toggle aria-haspopup="true" aria-expanded="false">${escapeHtml(userNav.current)} &#9662;</button>
        <div class="dropdown-menu">${items}</div>
      </div>
    </div>
  </header>`;
}

export function layout(
  title: string,
  content: string,
  userNav?: UserNav,
  topbarExtra?: string,
  operationRunning: boolean = false,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Audible Backup</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M3 5c0 0 4-2 13 2v22c-9-4-13-2-13-2V5z' fill='%236c8cff'/><path d='M29 5c0 0-4-2-13 2v22c9-4 13-2 13-2V5z' fill='%238ba4ff'/></svg>">
  <script src="/static/htmx.min.js"></script>
  <script src="/static/sse.js"></script>
  <script src="/static/app.js" defer></script>
  <style>
    /* Adwaita named colors (see libadwaita's colors.md): light by default,
       overridden under prefers-color-scheme so the page follows the system
       the same way a native GNOME app would. */
    :root {
      --bg: #fafafb;
      --surface: #ffffff;
      --surface2: #f3f3f4;
      --view-bg: #ffffff;
      --border: rgba(0, 0, 0, 0.09);
      --text: rgba(0, 0, 0, 0.8);
      --text-muted: rgba(0, 0, 0, 0.55);
      --accent: #3584e4;
      --accent-hover: #1c71d8;
      --success: #2ec27e;
      --warn: #e5a50a;
      --danger: #e01b24;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #222226;
        --surface: #303030;
        --surface2: #383838;
        --view-bg: #1e1e1e;
        --border: rgba(255, 255, 255, 0.09);
        --text: #ffffff;
        --text-muted: rgba(255, 255, 255, 0.6);
        --accent: #78aeed;
        --accent-hover: #3584e4;
        --success: #8ff0a4;
        --warn: #f8e45c;
        --danger: #ff7b63;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    main {
      max-width: 100%;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1.5rem; }
    h2 { font-size: 1.15rem; font-weight: 600; margin-bottom: 1rem; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
    }
    .card .label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .card .value { font-size: 1.8rem; font-weight: 700; margin-top: 0.25rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td { padding: 0.75rem 1rem; text-align: left; }
    th {
      background: var(--surface2);
      font-size: 0.8rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }
    td { border-top: 1px solid var(--border); font-size: 0.9rem; }
    tr:hover td { background: var(--surface2); }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-success { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .badge-warn { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
    .badge-muted { background: color-mix(in srgb, var(--text-muted) 15%, transparent); color: var(--text-muted); }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-sm { padding: 0.3rem 0.7rem; font-size: 0.8rem; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    a.btn, a.dropdown-item { text-decoration: none; box-sizing: border-box; }
    .log-panel {
      background: var(--view-bg);
      padding: 1rem;
      max-height: 300px;
      overflow-y: auto;
      font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.8rem;
      line-height: 1.7;
    }
    .log-line { white-space: pre-wrap; word-break: break-all; }
    .log-line.error { color: var(--danger); }
    .log-line.warn { color: var(--warn); }
    .log-done { padding-top: 0.5rem; border-top: 1px solid var(--border); margin-top: 0.5rem; font-weight: 600; }
    .log-done.success { color: var(--success); }
    .log-done.error { color: var(--danger); }
    /* Anchored under the topbar button that opens it. Closed until asked for:
       operations only light up the indicator on that button. */
    #log-float {
      position: fixed;
      top: 3.1rem;
      right: 1rem;
      width: min(700px, calc(100% - 2rem));
      max-height: min(60vh, 520px);
      z-index: 150;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #log-float.visible { display: flex; }
    #log-float-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      cursor: default;
      user-select: none;
    }
    #log-float-header button {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 1rem;
      line-height: 1;
      padding: 0 0.25rem;
      transition: color 0.15s;
    }
    #log-float-header button:hover { color: var(--text); }
    #log-float .log-panel { flex: 1; }
    .log-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--text-muted);
      margin-left: 0.15rem;
      vertical-align: middle;
    }
    .log-dot[hidden] { display: none; }
    .log-dot.running { background: var(--accent); animation: log-pulse 1.2s ease-in-out infinite; }
    .log-dot.done { background: var(--success); }
    .log-dot.failed { background: var(--danger); }
    @keyframes log-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    .empty { text-align: center; padding: 3rem; color: var(--text-muted); }
    .htmx-indicator { display: none; }
    .htmx-request .htmx-indicator { display: inline-block; }
    .spinner { width: 1em; height: 1em; border: 2px solid var(--text-muted); border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .library-layout {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 4rem);
    }
    /* A long value must not stretch its column and squeeze everything else
       (more of a risk now that the table has many metadata columns); the
       full value stays available through the cell's title attribute. */
    .col-author { max-width: 16rem; }
    .col-title { max-width: 20rem; }
    td.col-author, td.col-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .table-scroll {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .table-scroll table { border: none; border-radius: 0; }
    .table-scroll thead th { position: sticky; top: 0; z-index: 1; background: var(--surface2); }
    .progress-bar {
      height: 3px;
      background: var(--surface2);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 4px;
    }
    .progress-bar-fill {
      height: 100%;
      width: 40%;
      background: var(--accent);
      border-radius: 2px;
      animation: progress-indeterminate 1.5s ease-in-out infinite;
      transition: width 0.3s ease;
    }
    @keyframes progress-indeterminate {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(350%); }
    }
    .badge-danger { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--danger); }
    .progress-bar-lg { height: 6px; margin-top: 0; }
    .progress-label { color: var(--text-muted); font-size: 0.75rem; margin-top: 2px; display: block; }
    #op-progress { margin-bottom: 0.5rem; }
    #op-progress:empty { margin-bottom: 0; }
    [id^="status-"] .progress-bar { height: 6px; min-width: 80px; }
    /* Lives in the topbar now, sharing a row with the title and the log/user
       controls, so it is sized to match those btn-sm-scale controls rather
       than the roomier full-width bar it used to have to itself. */
    .search-wrap { position: relative; display: flex; flex: 1 1 14rem; min-width: 9rem; max-width: 22rem; }
    .search-wrap input {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      padding: 0.3rem 1.8rem 0.3rem 0.6rem;
      font-size: 0.8rem;
      outline: none;
      width: 100%;
    }
    .search-clear {
      position: absolute;
      right: 0.4rem;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 1.1rem;
      line-height: 1;
      padding: 0 0.3rem;
      cursor: pointer;
      border-radius: 4px;
    }
    .search-clear:hover { color: var(--text); background: var(--surface2); }
    .search-clear[hidden] { display: none; }
    .search-wrap input:focus { border-color: var(--accent); }
    th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
    th.sortable:hover { color: var(--text); }
    th.sortable::after { content: '⇅'; display: inline-block; margin-left: 0.3rem; font-size: 0.6rem; vertical-align: middle; opacity: 0.3; }
    th.sortable:hover::after { opacity: 0.6; }
    th.sortable.asc::after { content: '▲'; opacity: 1; }
    th.sortable.desc::after { content: '▼'; opacity: 1; }
    /* Drag-to-reorder: grabbable header, dimmed while it's the one being
       dragged, and an accent edge on whichever header it's currently over. */
    th[data-col] { cursor: grab; }
    th[data-col]:active { cursor: grabbing; }
    th[data-col].dragging { opacity: 0.4; }
    th[data-col].drag-over { box-shadow: inset 2px 0 0 var(--accent), inset -2px 0 0 var(--accent); }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:hover { background: #ef4444; }
    .btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .btn-ghost:hover { color: var(--text); border-color: var(--text-muted); }
    .action-dropdown { position: relative; display: inline-flex; }
    .split-btn { display: inline-flex; }
    .split-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .split-caret {
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      border-left: 1px solid rgba(255,255,255,0.2);
      padding: 0.3rem 0.35rem;
      font-size: 0.65rem;
    }
    /* Fixed, not absolute: the table lives in an overflow:auto scroller, which
       would clip a menu opened on one of the last rows. Coordinates are set by
       app.js when the menu opens. */
    .dropdown-menu {
      display: none;
      position: fixed;
      z-index: 200;
      min-width: 140px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.25rem 0;
      margin-top: 2px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .action-dropdown.open .dropdown-menu { display: block; }
    .dropdown-item {
      display: block;
      width: 100%;
      padding: 0.4rem 0.75rem;
      border: none;
      background: none;
      color: var(--text);
      font-size: 0.8rem;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    .dropdown-item:hover { background: var(--surface2); }
    .dropdown-item.danger { color: var(--danger); }
    .dropdown-item.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 1.5rem;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .topbar-title { font-weight: 600; font-size: 0.95rem; flex-shrink: 0; }
    .topbar-center { display: flex; align-items: center; gap: 0.5rem; flex: 1; margin: 0 1rem; min-width: 0; flex-wrap: wrap; }
    .topbar-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
    .topbar .dropdown-menu form { display: block; }
    .btn-icon { padding: 0.4rem; line-height: 0; position: relative; }
    .btn-icon svg { width: 1em; height: 1em; display: block; }
    /* While running (data-cancel is set): the icon spins in place, and
       hovering swaps it for a red "cancel" X instead of losing the icon to
       the word "Cancel" the way a text button does. */
    .btn-icon .icon-cancel { display: none; }
    .btn-icon[data-cancel] .icon-refresh { animation: spin 1s linear infinite; }
    .btn-icon[data-cancel]:hover .icon-refresh { display: none; }
    .btn-icon[data-cancel]:hover .icon-cancel { display: block; color: var(--danger); }
    .dropdown-item.checkbox-item { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
    .dropdown-item.checkbox-item input { margin: 0; }
    .settings-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
    .settings-header h1 { margin-bottom: 0; }
    body.has-topbar .library-layout { height: calc(100vh - 7.5rem); }
    #toast-region {
      position: fixed;
      top: 1rem;
      right: 1rem;
      z-index: 200;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .toast {
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 6px;
      padding: 0.6rem 0.9rem;
      font-size: 0.85rem;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .toast.error { border-left-color: var(--danger); }
  </style>
</head>
<body${userNav ? ' class="has-topbar"' : ""}>
  ${userNav ? topbar(userNav, topbarExtra || "", operationRunning) : ""}
  <main>${content}</main>
  <div id="toast-region" role="status" aria-live="polite"></div>
  <div id="log-float" role="region" aria-label="Operation log">
    <div id="log-float-header">
      <span id="log-float-title">Operation Log</span>
      <div>
        <button id="log-float-close" title="Close" aria-label="Close operation log">&times;</button>
      </div>
    </div>
    <div id="progress-panel"></div>
  </div>
</body>
</html>`;
}
