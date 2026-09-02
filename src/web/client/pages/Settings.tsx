import * as React from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Switch } from "@base-ui/react/switch";
import { Topbar } from "../components/Topbar.tsx";
import { useToast } from "../components/Toaster.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { useSession } from "../SessionContext.tsx";
import { useOperationContext } from "../OperationContext.tsx";
import { api, ApiRequestError } from "../api.ts";
import type { AudibleStatus, AudioFormat, AudioQuality, SettingsState } from "../types.ts";
import { AUDIO_FORMATS, AUDIO_QUALITIES, AUDIO_PRESETS, audioArgsString, DEFAULT_AUDIO_SETTINGS, DEFAULT_OUTPUT_FORMAT } from "../types.ts";
import { OutputFormatBuilder } from "./OutputFormatBuilder.tsx";

const ACTIVATION_BYTES_HINT =
  "A decryption key tied to your Audible account/device. Only needed for " +
  "legacy .aax downloads — AAXC downloads (via Connect Audible) use a " +
  "per-file key instead and don't need this.";

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

const FORMAT_LABELS: Record<AudioFormat, string> = { mp3: "MP3", flac: "FLAC", aac: "AAC" };
const QUALITY_LABELS: Record<AudioQuality, string> = { low: "Low", medium: "Medium", high: "High" };

function AudibleCard({
  audible,
  onStart,
  onComplete,
  onCancel,
}: {
  audible: AudibleStatus;
  onStart: (marketplace: string) => void;
  onComplete: (redirectUrl: string) => void;
  onCancel: () => void;
}) {
  const [marketplace, setMarketplace] = React.useState("de");
  const [redirectUrl, setRedirectUrl] = React.useState("");

  if (!audible.available) {
    return (
      <div className="auth-card">
        <h2>Audible account</h2>
        <p className="hint">
          The Audible client could not start. This only happens when <code>AUDIBLE_HELPER</code> points at an
          external helper that fails to run — unset it to use the built-in client.
        </p>
      </div>
    );
  }

  if (audible.pending) {
    return (
      <div className="auth-card">
        <h2>Connect Audible — step 2 of 2</h2>
        <ol className="hint steps">
          <li>
            <a href={audible.pending.url} target="_blank" rel="noopener noreferrer">
              Open the Audible sign-in page
            </a>{" "}
            and log in there.
          </li>
          <li>After signing in your browser lands on a page that fails to load. That is expected.</li>
          <li>Copy that page&apos;s full address and paste it below.</li>
        </ol>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onComplete(redirectUrl);
          }}
        >
          <label htmlFor="redirect-url">Address of the page you landed on</label>
          <input
            id="redirect-url"
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
            placeholder="https://www.audible.de/?openid.oa2.authorization_code=..."
            required
            autoComplete="off"
          />
          <button className="btn btn-primary" type="submit">
            Finish sign-in
          </button>
        </form>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  if (audible.linked) {
    return (
      <div className="auth-card">
        <h2>Audible account</h2>
        <p>
          <span className="badge badge-success">Connected</span>
          {audible.marketplace && <span className="hint"> marketplace: {audible.marketplace}</span>}
        </p>
        <button className="btn btn-ghost" type="button" onClick={() => onStart(audible.marketplace || "de")}>
          Reconnect
        </button>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h2>Connect Audible</h2>
      <p className="hint">You sign in on Audible&apos;s own page — this app never sees your password.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onStart(marketplace);
        }}
      >
        <label htmlFor="marketplace">Marketplace</label>
        <select id="marketplace" value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
          {MARKETPLACES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit">
          Start sign-in
        </button>
      </form>
    </div>
  );
}

export function SettingsPage() {
  const { session } = useSession();
  const op = useOperationContext();
  const toast = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = React.useState<SettingsState | null>(null);
  const [activationBytes, setActivationBytes] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [removePassword, setRemovePassword] = React.useState(false);
  const [audioFormat, setAudioFormat] = React.useState<AudioFormat>(DEFAULT_AUDIO_SETTINGS.format);
  const [audioQuality, setAudioQuality] = React.useState<AudioQuality>(DEFAULT_AUDIO_SETTINGS.quality);
  const [customEnabled, setCustomEnabled] = React.useState(false);
  const [audioArgs, setAudioArgs] = React.useState("");
  const [outputFormat, setOutputFormat] = React.useState(DEFAULT_OUTPUT_FORMAT);
  const [message, setMessage] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api.settings
      .get()
      .then((s) => {
        setSettings(s);
        setActivationBytes(s.activationBytes);
        setAudioFormat(s.audioSettings.format);
        setAudioQuality(s.audioSettings.quality);
        setCustomEnabled(!!s.audioSettings.customArgs?.trim());
        setAudioArgs(audioArgsString(s.audioSettings));
        setOutputFormat(s.outputFormat);
      })
      .catch((err) => {
        if (!(err instanceof ApiRequestError)) toast("Could not load settings", true);
      });
  }, [toast]);

  React.useEffect(load, [load]);

  if (!session || !settings) {
    return (
      <>
        <Topbar />
        <main />
      </>
    );
  }

  const saveGeneral = async () => {
    try {
      const updated = await api.settings.update({ activationBytes, password: password || undefined, removePassword });
      setSettings(updated);
      setPassword("");
      setRemovePassword(false);
      setMessage("Settings saved");
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : "Could not save settings", true);
    }
  };

  const saveOutput = async (next: { audioFormat: AudioFormat; audioQuality: AudioQuality; audioArgs: string; audioCustomEnabled: boolean; outputFormat: typeof outputFormat }) => {
    try {
      const updated = await api.settings.update(next);
      setSettings(updated);
      setMessage("Settings saved");
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : "Could not save settings", true);
    }
  };

  // Matches the old UI exactly: preset buttons overwrite the displayed args
  // field even while the custom-args toggle is on — only the toggle
  // controls whether the field also accepts direct typing.
  const selectFormat = (format: AudioFormat) => {
    setAudioFormat(format);
    setAudioArgs(AUDIO_PRESETS[format][audioQuality].args.join(" "));
  };
  const selectQuality = (quality: AudioQuality) => {
    setAudioQuality(quality);
    setAudioArgs(AUDIO_PRESETS[audioFormat][quality].args.join(" "));
  };

  const startAudible = async (marketplace: string) => {
    try {
      const { url } = await api.audible.loginUrl(marketplace);
      setSettings((s) => (s ? { ...s, audible: { ...s.audible, pending: { url, marketplace } } } : s));
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : "Could not start sign-in", true);
    }
  };
  const completeAudible = async (redirectUrl: string) => {
    try {
      await api.audible.loginComplete(redirectUrl);
      await load();
      toast("Audible account connected");
      // Freshly-connected account is otherwise empty until the user
      // remembers to sync — same intent as the old ?sync=1 redirect.
      op.start(() => api.operation.sync()).catch(() => {});
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : "Sign-in failed", true);
    }
  };
  const cancelAudible = async () => {
    await api.audible.cancelPending().catch(() => {});
    await load();
  };

  const resetDb = async () => {
    if (!(await confirm("Reset the library database for this user? Downloaded files are kept, but the library list is cleared."))) {
      return;
    }
    try {
      await api.library.reset();
      toast("Library database reset. Files on disk were kept.");
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : "Could not reset the database", true);
    }
  };

  return (
    <>
      <Topbar />
      <main>
        <div className="settings-wrap">
          <div className="settings-header">
            <h1>{settings.desktop ? "Settings" : `Settings — ${settings.userName}`}</h1>
            <a href="/" className="btn btn-ghost btn-sm">
              &larr; Back to library
            </a>
          </div>
          {message && (
            <div className="auth-error" style={{ color: "var(--success)" }}>
              {message}
            </div>
          )}

          <Tabs.Root defaultValue="audible">
            <Tabs.List className="tabs" aria-label="Settings sections">
              <Tabs.Tab className="tab" value="audible">
                Audible
              </Tabs.Tab>
              <Tabs.Tab className="tab" value="output">
                Output
              </Tabs.Tab>
              <Tabs.Tab className="tab" value="debug">
                Debug
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel className="tab-panel" value="audible">
              <AudibleCard
                audible={settings.audible}
                onStart={startAudible}
                onComplete={completeAudible}
                onCancel={cancelAudible}
              />
              <div className="auth-card">
                <div className="field-stack">
                  <label htmlFor="set-bytes" title={ACTIVATION_BYTES_HINT}>
                    Audible activation bytes
                  </label>
                  <input
                    id="set-bytes"
                    value={activationBytes}
                    onChange={(e) => setActivationBytes(e.target.value)}
                    placeholder="e.g. 1a2b3c4d"
                    title={ACTIVATION_BYTES_HINT}
                  />
                  {!settings.desktop && (
                    <>
                      <label htmlFor="set-password">
                        New password{" "}
                        <span className="hint">
                          (leave blank to keep {settings.hasPassword ? "current password" : "no password"})
                        </span>
                      </label>
                      <input
                        id="set-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                    </>
                  )}
                  {!settings.desktop && settings.hasPassword && (
                    <div className="checkbox-row">
                      <input
                        id="set-remove-pw"
                        type="checkbox"
                        checked={removePassword}
                        onChange={(e) => setRemovePassword(e.target.checked)}
                      />
                      <label htmlFor="set-remove-pw">Remove password</label>
                    </div>
                  )}
                  <button className="btn btn-primary" style={{ alignSelf: "flex-start" }} type="button" onClick={saveGeneral}>
                    Save
                  </button>
                </div>
              </div>
            </Tabs.Panel>

            <Tabs.Panel className="tab-panel" value="output">
              <div className="auth-card">
                <h2>Conversion quality</h2>
                <div className="quality-section">
                  <label>Output format</label>
                  <div className="btn-row" role="group" aria-label="Output format">
                    {AUDIO_FORMATS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`btn btn-sm ${f === audioFormat ? "btn-primary" : "btn-ghost"}`}
                        aria-pressed={f === audioFormat}
                        onClick={() => selectFormat(f)}
                      >
                        {FORMAT_LABELS[f]}
                      </button>
                    ))}
                  </div>
                  <label>Quality</label>
                  <div className="btn-row" role="group" aria-label="Quality">
                    {AUDIO_QUALITIES.map((q) => (
                      <button
                        key={q}
                        type="button"
                        className={`btn btn-sm ${q === audioQuality ? "btn-primary" : "btn-ghost"}`}
                        aria-pressed={q === audioQuality}
                        title={AUDIO_PRESETS[audioFormat][q].estimate}
                        onClick={() => selectQuality(q)}
                      >
                        {QUALITY_LABELS[q]}
                      </button>
                    ))}
                  </div>
                  <div className="setting-row">
                    <label htmlFor="audio-args">ffmpeg audio args</label>
                    <label className="switch" title="Edit the ffmpeg command manually">
                      <Switch.Root
                        checked={customEnabled}
                        onCheckedChange={setCustomEnabled}
                        aria-label="Edit the ffmpeg command manually"
                      >
                        <span className="switch-track">
                          <span className="switch-thumb" />
                        </span>
                      </Switch.Root>
                    </label>
                  </div>
                  <input
                    id="audio-args"
                    value={audioArgs}
                    onChange={(e) => setAudioArgs(e.target.value)}
                    disabled={!customEnabled}
                    placeholder="-c:a libmp3lame -b:a 128k"
                  />
                </div>

                <h2 style={{ marginTop: "1.5rem" }}>Output naming</h2>
                <OutputFormatBuilder value={outputFormat} onChange={setOutputFormat} />

                <button
                  className="btn btn-primary"
                  style={{ marginTop: "1rem" }}
                  type="button"
                  onClick={() =>
                    saveOutput({
                      audioFormat,
                      audioQuality,
                      audioArgs,
                      audioCustomEnabled: customEnabled,
                      outputFormat,
                    })
                  }
                >
                  Save
                </button>
              </div>
            </Tabs.Panel>

            <Tabs.Panel className="tab-panel" value="debug">
              <div className="auth-card danger-zone">
                <h2>Reset library database</h2>
                <p className="hint">
                  Clears this user&apos;s library list — every book, its download and conversion state.{" "}
                  <strong>Files on disk are kept</strong>; a later sync re-imports whatever is still there.
                </p>
                <button className="btn btn-danger" type="button" onClick={resetDb}>
                  Reset database
                </button>
              </div>
            </Tabs.Panel>
          </Tabs.Root>

          <p className="build-line" title="Which build is running — useful after an update">
            Audible Backup {settings.version}
          </p>
        </div>
      </main>
    </>
  );
}
