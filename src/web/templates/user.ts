import { layout, type UserNav } from "./layout.ts";
import { versionLine } from "../../version.ts";
import { escapeHtml } from "./html.ts";
import {
  AUDIO_FORMATS,
  AUDIO_QUALITIES,
  AUDIO_PRESETS,
  audioArgsString,
  BOOK_TAGS,
  CHAPTER_TAGS,
  type AudioSettings,
  type AudioFormat,
  type AudioQuality,
  type OutputFormat,
  type FormatRow,
} from "../../converter.ts";

export interface UserListEntry {
  name: string;
  hasPassword: boolean;
}

/** Shown as a tooltip wherever the activation bytes field appears — the term
 * means nothing on its own, and AAXC users (the default via Connect Audible)
 * never need to fill it in at all. */
const ACTIVATION_BYTES_HINT =
  "A decryption key tied to your Audible account/device. Only needed for " +
  "legacy .aax downloads — AAXC downloads (via Connect Audible) use a " +
  "per-file key instead and don't need this.";

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
    .auth-card input:disabled { opacity: 0.5; cursor: not-allowed; background: var(--surface2); }
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
    .build-line { margin-top: 1.5rem; font-size: 0.75rem; color: var(--text-muted); text-align: center; }
    .btn-row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .quality-section label:not(:first-child) { margin-top: 0.4rem; }
    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 0.4rem; }
    .setting-row label { margin: 0; }
    /* Sliding toggle: a real checkbox, visually hidden, driving a track+thumb
       sibling via :checked — stays a native, keyboard- and screen-reader-
       accessible control, just repainted. */
    .switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; flex-shrink: 0; }
    .switch input {
      position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; padding: 0;
    }
    .switch-track {
      width: 2.25rem; height: 1.25rem; background: var(--border); border-radius: 999px;
      position: relative; transition: background 0.15s;
    }
    .switch-thumb {
      position: absolute; top: 2px; left: 2px; width: 1.05rem; height: 1.05rem;
      background: #fff; border-radius: 50%; transition: transform 0.15s;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
    }
    .switch input:checked + .switch-track { background: var(--accent); }
    .switch input:checked + .switch-track .switch-thumb { transform: translateX(1rem); }
    .switch input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
    .format-section { margin-top: 0.6rem; }
    .format-section label { display: block; margin-bottom: 0.3rem; }
    #directory-rows, #filename-row { display: flex; flex-direction: column; gap: 0.4rem; }
    .format-row {
      display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 0.4rem 0.5rem;
    }
    .format-row-grip { cursor: grab; color: var(--text-muted); font-size: 0.9rem; user-select: none; line-height: 1; }
    .format-row-grip:active { cursor: grabbing; }
    .format-blocks { display: flex; flex-wrap: wrap; gap: 0.3rem; flex: 1; min-height: 1.6rem; align-items: center; }
    .format-chip {
      display: inline-flex; align-items: center; gap: 0.25rem;
      background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
      padding: 0.15rem 0.4rem; font-size: 0.8rem; cursor: grab;
    }
    .format-chip:active { cursor: grabbing; }
    .format-chip.drag-over { box-shadow: inset 2px 0 0 var(--accent); }
    .format-chip-label { white-space: nowrap; }
    .format-chip-text .chip-text-input {
      background: transparent; border: none; padding: 0; font-size: 0.8rem;
      color: var(--text); outline: none; width: auto;
    }
    .chip-remove {
      background: none; border: none; color: var(--text-muted); cursor: pointer;
      font-size: 0.85rem; line-height: 1; padding: 0;
    }
    .chip-remove:hover { color: var(--danger); }
    .format-row-controls { display: flex; align-items: center; gap: 0.3rem; }
    .format-add-tag { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.8rem; padding: 0.25rem 0.4rem; }
    .format-preview {
      font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.85rem; background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 0.6rem 0.75rem; word-break: break-word;
    }
    .danger-zone { border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
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
          <label for="add-bytes" title="${escapeHtml(ACTIVATION_BYTES_HINT)}">Audible activation bytes <span class="hint">(optional, can be set later in Settings)</span></label>
          <input id="add-bytes" name="activation_bytes" placeholder="e.g. 1a2b3c4d" title="${escapeHtml(ACTIVATION_BYTES_HINT)}">
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
  /** Desktop install: no account, so no password or user identity shown. */
  desktop?: boolean;
  /** Lights up the topbar's log indicator when an operation (e.g. an
   * auto-triggered sync) is already running for this user. */
  operationRunning?: boolean;
  audioSettings: AudioSettings;
  outputFormat: OutputFormat;
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
      <p class="hint">The Audible client could not start. This only happens when
      <code>AUDIBLE_HELPER</code> points at an external helper that fails to
      run — unset it to use the built-in client.</p>
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

const FORMAT_LABELS: Record<AudioFormat, string> = { mp3: "MP3", flac: "FLAC", aac: "AAC" };
const QUALITY_LABELS: Record<AudioQuality, string> = { low: "Low", medium: "Medium", high: "High" };

/**
 * Format/quality preset buttons, a live ffmpeg-args preview, and a toggle to
 * hand-edit that string. The buttons mutate the args field directly (client
 * JS in app.js, driven by the presets/estimates embedded below) — the toggle
 * only controls whether the field accepts direct typing.
 */
function qualitySection(settings: AudioSettings): string {
  const hasCustom = !!settings.customArgs?.trim();
  const argsString = audioArgsString(settings);

  const presetStrings: Record<string, Record<string, string>> = {};
  const estimateStrings: Record<string, Record<string, string>> = {};
  for (const format of AUDIO_FORMATS) {
    presetStrings[format] = {};
    estimateStrings[format] = {};
    for (const quality of AUDIO_QUALITIES) {
      presetStrings[format][quality] = AUDIO_PRESETS[format][quality].args.join(" ");
      estimateStrings[format][quality] = AUDIO_PRESETS[format][quality].estimate;
    }
  }

  return `
    <div class="quality-section">
      <label>Output format</label>
      <div class="btn-row" role="group" aria-label="Output format">
        ${AUDIO_FORMATS.map((f) => `<button type="button" class="btn btn-sm ${f === settings.format ? "btn-primary" : "btn-ghost"}" data-audio-format="${f}" aria-pressed="${f === settings.format}">${FORMAT_LABELS[f]}</button>`).join("")}
      </div>
      <label>Quality</label>
      <div class="btn-row" role="group" aria-label="Quality">
        ${AUDIO_QUALITIES.map((q) => `<button type="button" class="btn btn-sm ${q === settings.quality ? "btn-primary" : "btn-ghost"}" data-audio-quality="${q}" aria-pressed="${q === settings.quality}" title="${escapeHtml(AUDIO_PRESETS[settings.format][q].estimate)}">${QUALITY_LABELS[q]}</button>`).join("")}
      </div>
      <input type="hidden" name="audio_format" id="audio-format-input" value="${settings.format}">
      <input type="hidden" name="audio_quality" id="audio-quality-input" value="${settings.quality}">

      <div class="setting-row">
        <label for="audio-args">ffmpeg audio args</label>
        <label class="switch" title="Edit the ffmpeg command manually">
          <input id="audio-custom-toggle" name="audio_custom_enabled" type="checkbox" value="true" ${hasCustom ? "checked" : ""} aria-label="Edit the ffmpeg command manually">
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <input id="audio-args" name="audio_args" value="${escapeHtml(argsString)}" ${hasCustom ? "" : "disabled"} placeholder="-c:a libmp3lame -b:a 128k">
      <div id="audio-presets-data" hidden
           data-presets="${escapeHtml(JSON.stringify(presetStrings))}"
           data-estimates="${escapeHtml(JSON.stringify(estimateStrings))}"></div>
    </div>
  `;
}

const ALL_TAGS = [...BOOK_TAGS, ...CHAPTER_TAGS];
function tagLabel(key: string): string {
  return ALL_TAGS.find((t) => t.key === key)?.label || key;
}

/** One chip per segment: a removable tag, or an editable+removable literal
 * text block. Both are draggable — reordering and moving between rows is
 * handled client-side (app.js), which rebuilds this exact markup from its
 * in-memory state after every change. */
function formatChipHtml(section: "directory" | "filename", rowIndex: number, blockIndex: number, seg: FormatRow[number]): string {
  const removeBtn = `<button type="button" class="chip-remove" data-section="${section}" data-row-index="${rowIndex}" data-block-index="${blockIndex}" aria-label="Remove">&times;</button>`;
  if (seg.type === "tag") {
    return `<span class="format-chip" draggable="true" data-section="${section}" data-row-index="${rowIndex}" data-block-index="${blockIndex}">
      <span class="format-chip-label">${escapeHtml(tagLabel(seg.value))}</span>${removeBtn}
    </span>`;
  }
  return `<span class="format-chip format-chip-text" draggable="true" data-section="${section}" data-row-index="${rowIndex}" data-block-index="${blockIndex}">
    <input type="text" class="chip-text-input" value="${escapeHtml(seg.value)}" size="${Math.max(2, seg.value.length)}" data-section="${section}" data-row-index="${rowIndex}" data-block-index="${blockIndex}">${removeBtn}
  </span>`;
}

/** One folder level, or the (single) filename row. `rowDraggable` offers a
 * grip handle to reorder folder levels relative to each other. */
function formatRowHtml(
  section: "directory" | "filename",
  rowIndex: number,
  row: FormatRow,
  availableTags: { key: string; label: string }[],
  removable: boolean,
  rowDraggable: boolean,
): string {
  const chips = row.map((seg, i) => formatChipHtml(section, rowIndex, i, seg)).join("");
  const options = availableTags.map((t) => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join("");
  const grip = rowDraggable
    ? `<span class="format-row-grip" draggable="true" data-row-drag="true" data-section="${section}" data-row-index="${rowIndex}" title="Drag to reorder folder levels">&#8942;&#8942;</span>`
    : "";
  const removeRow = removable
    ? `<button type="button" class="btn btn-sm btn-ghost format-remove-row" data-section="${section}" data-row-index="${rowIndex}" title="Remove this folder level">&times;</button>`
    : "";
  return `<div class="format-row" data-section="${section}" data-row-index="${rowIndex}">
    ${grip}
    <div class="format-blocks" data-section="${section}" data-row-index="${rowIndex}">${chips}</div>
    <div class="format-row-controls">
      <select class="format-add-tag" data-section="${section}" data-row-index="${rowIndex}">
        <option value="">+ Tag</option>
        ${options}
      </select>
      <button type="button" class="btn btn-sm btn-ghost format-add-text" data-section="${section}" data-row-index="${rowIndex}">+ Text</button>
      ${removeRow}
    </div>
  </div>`;
}

/**
 * Tag-based directory/filename templates, arranged and reordered by
 * dragging (client JS in app.js — this only renders the starting state and
 * embeds the tag catalog + current template as data for it to pick up).
 * The preview is entirely client-side against a fixed sample book.
 */
function outputFormatSection(format: OutputFormat): string {
  const directoryRows = format.directory
    .map((row, i) => formatRowHtml("directory", i, row, BOOK_TAGS, format.directory.length > 1, true))
    .join("");
  const filenameRow = formatRowHtml("filename", 0, format.filename, ALL_TAGS, false, false);

  return `
    <div class="format-section">
      <label>Folder structure <span class="hint">(each level becomes one folder; empty levels — e.g. no series — are skipped)</span></label>
      <div id="directory-rows">${directoryRows}</div>
      <button type="button" id="add-folder-level" class="btn btn-sm btn-ghost">+ Add folder level</button>
    </div>
    <div class="format-section">
      <label>Chapter filename</label>
      <div id="filename-row">${filenameRow}</div>
    </div>
    <div class="format-section">
      <label>Preview</label>
      <div id="format-preview" class="format-preview" aria-live="polite"></div>
    </div>
    <input type="hidden" name="output_format_json" id="output-format-json" value='${escapeHtml(JSON.stringify(format))}'>
    <div id="output-format-tags-data" hidden
         data-book-tags="${escapeHtml(JSON.stringify(BOOK_TAGS))}"
         data-chapter-tags="${escapeHtml(JSON.stringify(CHAPTER_TAGS))}"></div>
  `;
}

export function settingsPage(view: SettingsView): string {
  const { userName, activationBytes, hasPassword, message, error, userNav, desktop, operationRunning } = view;
  const content = `
    ${formStyles}
    <div class="auth-wrap">
      <div class="settings-header">
        <h1>${desktop ? "Settings" : `Settings — ${escapeHtml(userName)}`}</h1>
        <a href="/" class="btn btn-ghost btn-sm">&larr; Back to library</a>
      </div>
      ${message ? `<div class="auth-error" style="color:var(--success)">${escapeHtml(message)}</div>` : ""}
      ${error ? `<div class="auth-error">${escapeHtml(error)}</div>` : ""}
      ${audibleCard(view.audible)}
      <div class="auth-card">
        <form method="post" action="/user/settings">
          <label for="set-bytes" title="${escapeHtml(ACTIVATION_BYTES_HINT)}">Audible activation bytes</label>
          <input id="set-bytes" name="activation_bytes" value="${escapeHtml(activationBytes)}" placeholder="e.g. 1a2b3c4d" title="${escapeHtml(ACTIVATION_BYTES_HINT)}">
          ${desktop ? "" : `
          <label for="set-password">New password <span class="hint">(leave blank to keep ${hasPassword ? "current password" : "no password"})</span></label>
          <input id="set-password" name="password" type="password" autocomplete="new-password">`}
          ${!desktop && hasPassword ? `
          <div class="checkbox-row">
            <input id="set-remove-pw" name="remove_password" type="checkbox" value="true">
            <label for="set-remove-pw">Remove password</label>
          </div>` : ""}

          <h2 style="margin-top:1rem">Conversion quality</h2>
          ${qualitySection(view.audioSettings)}

          <h2 style="margin-top:1rem">Output naming</h2>
          ${outputFormatSection(view.outputFormat)}

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

      <p class="build-line" title="Which build is running — useful after an update">
        Audible Backup ${escapeHtml(versionLine())}
      </p>
    </div>
  `;
  return layout("Settings", content, userNav, undefined, operationRunning ?? false);
}
