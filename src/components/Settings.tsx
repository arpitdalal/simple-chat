import { useEffect, useState } from "react";
import { getSettings, setSetting, deleteChatsOlderThan, type AppSettings } from "../lib/db";
import { hasApiKey, setApiKey } from "../lib/keys";
import { CATALOG, PROVIDER_LABELS, type ProviderId } from "../lib/models";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Props = { onClose: () => void; onSaved: (s: AppSettings) => void };

const PROVIDERS: ProviderId[] = ["openai", "anthropic", "google"];

export function Settings({ onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [keys, setKeys] = useState<Record<ProviderId, string>>({
    openai: "",
    anthropic: "",
    google: "",
  });
  const [hasKey, setHasKey] = useState<Record<ProviderId, boolean>>({
    openai: false,
    anthropic: false,
    google: false,
  });
  const [status, setStatus] = useState("");

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSettings(s);
      const hk: Record<ProviderId, boolean> = {
        openai: false,
        anthropic: false,
        google: false,
      };
      for (const p of PROVIDERS) hk[p] = await hasApiKey(p);
      setHasKey(hk);
    })();
  }, []);

  if (!settings) return <div className="settings-panel">Loading…</div>;

  const modelsForProvider = CATALOG.filter(
    (m) => m.provider === settings.default_provider,
  );

  async function save() {
    if (!settings) return;
    for (const p of PROVIDERS) {
      if (keys[p].trim()) await setApiKey(p, keys[p].trim());
    }
    await setSetting("resume_minutes", settings.resume_minutes);
    await setSetting("always_on_top", settings.always_on_top);
    await setSetting("show_tray", settings.show_tray);
    await setSetting("default_provider", settings.default_provider);
    await setSetting("default_model", settings.default_model);
    await setSetting("web_search", settings.web_search);
    await getCurrentWindow().setAlwaysOnTop(settings.always_on_top);
    onSaved(settings);
    setStatus("Saved");
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>Settings</h2>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <section>
        <h3>API keys (BYOK)</h3>
        {PROVIDERS.map((p) => (
          <label key={p} className="field">
            <span>
              {PROVIDER_LABELS[p]}
              {hasKey[p] ? " · saved" : ""}
            </span>
            <input
              type="password"
              placeholder={hasKey[p] ? "•••••••• (leave blank to keep)" : "Paste key"}
              value={keys[p]}
              onChange={(e) => setKeys({ ...keys, [p]: e.target.value })}
            />
          </label>
        ))}
      </section>

      <section>
        <h3>Defaults</h3>
        <label className="field">
          <span>Provider</span>
          <select
            value={settings.default_provider}
            onChange={(e) => {
              const provider = e.target.value;
              const first = CATALOG.find((m) => m.provider === provider);
              setSettings({
                ...settings,
                default_provider: provider,
                default_model: first?.id ?? settings.default_model,
              });
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <select
            value={
              modelsForProvider.some((m) => m.id === settings.default_model)
                ? settings.default_model
                : "__custom__"
            }
            onChange={(e) => {
              if (e.target.value === "__custom__") return;
              setSettings({ ...settings, default_model: e.target.value });
            }}
          >
            {modelsForProvider.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom__">Custom model ID…</option>
          </select>
        </label>
        <label className="field">
          <span>Model ID (catalog or free-text)</span>
          <input
            value={settings.default_model}
            onChange={(e) =>
              setSettings({ ...settings, default_model: e.target.value.trim() })
            }
            placeholder="e.g. gpt-4o-mini"
          />
        </label>
        <label className="field">
          <span>Resume last chat within (minutes)</span>
          <input
            type="number"
            min={0}
            value={settings.resume_minutes}
            onChange={(e) =>
              setSettings({
                ...settings,
                resume_minutes: Number(e.target.value) || 0,
              })
            }
          />
        </label>
      </section>

      <section>
        <h3>Window</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.always_on_top}
            onChange={(e) =>
              setSettings({ ...settings, always_on_top: e.target.checked })
            }
          />
          Always on top
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.web_search}
            onChange={(e) =>
              setSettings({ ...settings, web_search: e.target.checked })
            }
          />
          Web search on by default (provider-native)
        </label>
        <p className="hint">Hotkey: ⌘⇧Space (mac) / Ctrl+Shift+Space (win) · Close hides</p>
      </section>

      <section>
        <h3>History</h3>
        <button
          type="button"
          className="danger"
          onClick={async () => {
            await deleteChatsOlderThan(180);
            setStatus("Deleted chats older than 6 months");
          }}
        >
          Delete chats older than 6 months
        </button>
      </section>

      <div className="settings-footer">
        <button type="button" className="primary" onClick={() => void save()}>
          Save
        </button>
        {status && <span className="hint">{status}</span>}
      </div>
    </div>
  );
}
