import { useEffect, useRef, useState } from "react";
import {
  getSettings,
  setSetting,
  deleteChatsOlderThan,
  type AppSettings,
} from "../lib/db";
import { hasApiKey, setApiKey, clearApiKey } from "../lib/keys";
import { PROVIDER_LABELS, PROVIDERS, type ProviderId } from "../lib/models";
import { ModelPicker } from "./ModelPicker";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  applyHotkey,
  clearHotkey,
  DEFAULT_HOTKEY,
  eventToAccelerator,
  formatHotkey,
  getActiveHotkey,
} from "../lib/hotkey";

type Props = {
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
};

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
  const [recording, setRecording] = useState(false);
  const [hotkeyDraft, setHotkeyDraft] = useState<string | null>(null);
  const [hotkeyError, setHotkeyError] = useState("");
  const [keyEpoch, setKeyEpoch] = useState(0);
  const saveTimer = useRef<number | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const lastGoodHotkeyRef = useRef(DEFAULT_HOTKEY);
  const persistGenRef = useRef(0);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSettings(s);
      settingsRef.current = s;
      lastGoodHotkeyRef.current = s.hotkey.trim() || DEFAULT_HOTKEY;
      const hk: Record<ProviderId, boolean> = {
        openai: false,
        anthropic: false,
        google: false,
      };
      for (const p of PROVIDERS) hk[p] = await hasApiKey(p);
      setHasKey(hk);
    })();
  }, []);

  useEffect(() => {
    if (!recording) return;
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        void applyHotkey(lastGoodHotkeyRef.current);
        return;
      }
      const accel = eventToAccelerator(e);
      if (!accel || !settings) return;
      setHotkeyDraft(null);
      patch({ hotkey: accel });
      setRecording(false);
      setHotkeyError("");
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, settings]);

  function commitHotkeyDraft() {
    if (hotkeyDraft == null || !settings) return;
    const next = hotkeyDraft.trim() || DEFAULT_HOTKEY;
    setHotkeyDraft(null);
    if (next !== settings.hotkey) patch({ hotkey: next });
  }

  async function startRecording() {
    setHotkeyDraft(null);
    setRecording(true);
    setHotkeyError("");
    // Free our own grab so Record can hear it; other apps may still steal.
    try {
      await clearHotkey();
    } catch {
      /* ignore */
    }
  }

  function patch(partial: Partial<AppSettings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      settingsRef.current = next;
      queueSave(next);
      return next;
    });
  }

  function queueSave(next: AppSettings) {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void persist(next);
    }, 250);
  }

  async function persist(s: AppSettings) {
    const gen = ++persistGenRef.current;
    const requested = s.hotkey.trim() || DEFAULT_HOTKEY;
    let hotkey = requested;
    let hotkeyOk = true;
    try {
      await applyHotkey(requested);
      setHotkeyError("");
      lastGoodHotkeyRef.current = requested;
    } catch (err) {
      hotkeyOk = false;
      setHotkeyError((err as Error).message || String(err));
      // Never persist a rejected combo — keep last known-good.
      hotkey = getActiveHotkey() || lastGoodHotkeyRef.current;
      // Only roll UI back if this request is still showing and not superseded.
      if (
        hotkey !== requested &&
        gen === persistGenRef.current
      ) {
        setSettings((prev) => {
          if (!prev || prev.hotkey !== requested) return prev;
          const next = { ...prev, hotkey };
          settingsRef.current = next;
          return next;
        });
      }
    }
    if (gen !== persistGenRef.current) return;
    await setSetting("resume_minutes", s.resume_minutes);
    await setSetting("always_on_top", s.always_on_top);
    await setSetting("show_tray", s.show_tray);
    await setSetting("default_provider", s.default_provider);
    await setSetting("default_model", s.default_model);
    await setSetting("web_search", true);
    await setSetting("hotkey", hotkey);
    if (gen !== persistGenRef.current) return;
    await getCurrentWindow().setAlwaysOnTop(s.always_on_top);
    onSaved({ ...s, hotkey });
    setStatus(hotkeyOk ? "Saved" : "Saved (hotkey unchanged)");
  }

  async function saveKey(provider: ProviderId) {
    const value = keys[provider].trim();
    if (!value) return;
    await setApiKey(provider, value);
    setKeys((k) => ({ ...k, [provider]: "" }));
    setHasKey((h) => ({ ...h, [provider]: true }));
    setKeyEpoch((n) => n + 1);
    setStatus(`${PROVIDER_LABELS[provider]} key saved`);
  }

  async function clearKey(provider: ProviderId) {
    await clearApiKey(provider);
    setKeys((k) => ({ ...k, [provider]: "" }));
    setHasKey((h) => ({ ...h, [provider]: false }));
    setKeyEpoch((n) => n + 1);
    setStatus(`${PROVIDER_LABELS[provider]} key cleared`);
  }

  if (!settings) return <div className="settings-panel">Loading…</div>;

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>Settings</h2>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">Changes save automatically</p>

      <section>
        <h3>API keys (BYOK)</h3>
        {PROVIDERS.map((p) => (
          <div key={p} className="field">
            <span>
              {PROVIDER_LABELS[p]}
              {hasKey[p] ? " · saved" : ""}
            </span>
            <div className="key-row">
              <input
                type="password"
                placeholder={
                  hasKey[p] ? "•••••••• (paste new to replace)" : "Paste key"
                }
                value={keys[p]}
                onChange={(e) => setKeys({ ...keys, [p]: e.target.value })}
                onBlur={() => void saveKey(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveKey(p);
                }}
              />
              {hasKey[p] && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void clearKey(p)}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h3>Defaults</h3>
        <ModelPicker
          provider={settings.default_provider}
          modelId={settings.default_model}
          refreshKey={keyEpoch}
          onChange={(provider, modelId) =>
            patch({ default_provider: provider, default_model: modelId })
          }
        />
        <label className="field" style={{ marginTop: 12 }}>
          <span>Resume last chat within (minutes)</span>
          <input
            type="number"
            min={0}
            value={settings.resume_minutes}
            onChange={(e) =>
              patch({ resume_minutes: Number(e.target.value) || 0 })
            }
          />
        </label>
      </section>

      <section>
        <h3>Window</h3>
        <label className="field">
          <span>Global hotkey</span>
          <div className="hotkey-row">
            <input
              className="hotkey-display"
              aria-label="Global hotkey accelerator"
              title={formatHotkey(settings.hotkey || DEFAULT_HOTKEY)}
              spellCheck={false}
              readOnly={recording}
              value={
                recording
                  ? "Press keys… (Esc cancel)"
                  : (hotkeyDraft ?? (settings.hotkey || DEFAULT_HOTKEY))
              }
              onChange={(e) => {
                if (!recording) setHotkeyDraft(e.target.value);
              }}
              onBlur={() => commitHotkeyDraft()}
              onKeyDown={(e) => {
                if (recording) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <button
              type="button"
              className="ghost"
              onClick={() => void startRecording()}
            >
              Record
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setHotkeyDraft(null);
                patch({ hotkey: DEFAULT_HOTKEY });
              }}
            >
              Reset
            </button>
          </div>
          <p className="hint">
            If Record opens another app, that combo is already taken — type the
            accelerator (e.g. CommandOrControl+Shift+Space) instead.
          </p>
          {hotkeyError && <p className="hint error-text">{hotkeyError}</p>}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.always_on_top}
            onChange={(e) => patch({ always_on_top: e.target.checked })}
          />
          Always on top
        </label>
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

      {status && <p className="hint settings-status">{status}</p>}
    </div>
  );
}
