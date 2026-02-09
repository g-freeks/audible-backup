export function layout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Audible Backup</title>
  <script src="/static/htmx.min.js"></script>
  <script src="/static/sse.js"></script>
  <style>
    :root {
      --bg: #0f1117;
      --surface: #1a1d28;
      --surface2: #242836;
      --border: #2e3345;
      --text: #e1e4ed;
      --text-muted: #8b90a0;
      --accent: #6c8cff;
      --accent-hover: #8ba4ff;
      --success: #4ade80;
      --warn: #fbbf24;
      --danger: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    nav {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 1.5rem;
      display: flex;
      align-items: center;
      gap: 0;
      height: 3.5rem;
    }
    nav .brand {
      font-weight: 600;
      font-size: 1.1rem;
      margin-right: 2rem;
      color: var(--text);
      text-decoration: none;
    }
    nav a {
      color: var(--text-muted);
      text-decoration: none;
      padding: 1rem 1rem;
      font-size: 0.9rem;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    nav a:hover, nav a.active {
      color: var(--text);
      border-bottom-color: var(--accent);
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
    .badge-success { background: rgba(74, 222, 128, 0.15); color: var(--success); }
    .badge-warn { background: rgba(251, 191, 36, 0.15); color: var(--warn); }
    .badge-muted { background: rgba(139, 144, 160, 0.15); color: var(--text-muted); }
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
    .log-panel {
      background: #0a0c10;
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
    #log-float {
      position: fixed;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      width: min(800px, calc(100% - 2rem));
      z-index: 100;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 -4px 24px rgba(0,0,0,0.4);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #log-float.visible { display: flex; }
    #log-float.minimized { width: auto; min-width: 260px; }
    #log-float.minimized .log-panel,
    #log-float.minimized #op-progress { display: none; }
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
    #log-float.minimized #log-float-header { border-bottom: none; }
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
    .empty { text-align: center; padding: 3rem; color: var(--text-muted); }
    .actions { margin-bottom: 1.5rem; display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
    .htmx-indicator { display: none; }
    .htmx-request .htmx-indicator { display: inline-block; }
    .spinner { width: 1em; height: 1em; border: 2px solid var(--text-muted); border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .library-layout {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 3.5rem - 4rem);
    }
    .library-layout h1 { flex-shrink: 0; }
    .library-layout .actions { flex-shrink: 0; }
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
    .badge-danger { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
    .progress-bar-lg { height: 6px; margin-top: 0; }
    .progress-label { color: var(--text-muted); font-size: 0.75rem; margin-top: 2px; display: block; }
    #op-progress { margin-bottom: 0.5rem; }
    #op-progress:empty { margin-bottom: 0; }
    [id^="status-"] .progress-bar { height: 6px; min-width: 80px; }
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    .filter-bar input {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      padding: 0.45rem 0.75rem;
      font-size: 0.85rem;
      outline: none;
      min-width: 200px;
    }
    .filter-bar input:focus { border-color: var(--accent); }
    .filter-pills { display: flex; gap: 0.35rem; flex-wrap: wrap; }
    .filter-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--text-muted);
      padding: 0.25rem 0.7rem;
      font-size: 0.8rem;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .filter-btn:hover { color: var(--text); border-color: var(--text-muted); }
    .filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable:hover { color: var(--text); }
    th.sortable::after { content: ''; display: inline-block; width: 0; margin-left: 0.4rem; }
    th.sortable.asc::after { content: '▲'; font-size: 0.6rem; vertical-align: middle; }
    th.sortable.desc::after { content: '▼'; font-size: 0.6rem; vertical-align: middle; }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:hover { background: #ef4444; }
    .btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .btn-ghost:hover { color: var(--text); border-color: var(--text-muted); }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="brand">Audible Backup</a>
    <a href="/" class="active">Books</a>
  </nav>
  <main>${content}</main>
  <div id="log-float">
    <div id="log-float-header">
      <span id="log-float-title">Operation Log</span>
      <button id="log-float-minimize" title="Minimize">&#x2015;</button>
    </div>
    <div id="progress-panel"></div>
  </div>
  <script>
    const logFloat = document.getElementById('log-float');
    const progressPanel = document.getElementById('progress-panel');
    const minimizeBtn = document.getElementById('log-float-minimize');
    // Show the floating panel when content first arrives
    const observer = new MutationObserver(() => {
      if (progressPanel.children.length > 0 && !logFloat.classList.contains('visible')) {
        logFloat.classList.add('visible');
      }
    });
    observer.observe(progressPanel, { childList: true });

    minimizeBtn.addEventListener('click', () => {
      logFloat.classList.toggle('minimized');
    });

    // Auto-scroll log panels
    document.addEventListener('htmx:sseMessage', function(e) {
      const panel = e.target.closest('.log-panel');
      if (panel) {
        requestAnimationFrame(() => {
          panel.scrollTop = panel.scrollHeight;
        });
      }
    });
    // Reload page after operation completes to refresh data
    document.body.addEventListener('htmx:sseClose', function() {
      setTimeout(() => location.reload(), 1500);
    });
  </script>
</body>
</html>`;
}
