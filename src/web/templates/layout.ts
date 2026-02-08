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
      max-width: 1100px;
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
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-top: 1rem;
      max-height: 400px;
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
    .empty { text-align: center; padding: 3rem; color: var(--text-muted); }
    .actions { margin-bottom: 1.5rem; display: flex; gap: 0.75rem; align-items: center; }
    .htmx-indicator { display: none; }
    .htmx-request .htmx-indicator { display: inline-block; }
    .spinner { width: 1em; height: 1em; border: 2px solid var(--text-muted); border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="brand">Audible Backup</a>
    <a href="/"${title === "Dashboard" ? ' class="active"' : ""}>Dashboard</a>
    <a href="/library"${title === "Library" ? ' class="active"' : ""}>Library</a>
    <a href="/convert"${title === "Convert" ? ' class="active"' : ""}>Convert</a>
  </nav>
  <main>${content}</main>
  <script>
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
